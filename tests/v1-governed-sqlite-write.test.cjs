const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaAdaptersLocal } = require('../scripts/hypha-paths.cjs');
const { createSQLiteDataSource, SQLiteDataSourceError } = require('../src/v1/sqlite-data-source.cjs');
const { createV1SQLiteQueryRuntime } = require('../src/v1/sqlite-query-runtime.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');

const projectRoot = path.resolve(__dirname, '..');

function createFixture({ duplicateIds = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-governed-write-'));
  const databasePath = path.join(directory, 'legal-cases.sqlite');
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE labor_cases (
      case_id TEXT ${duplicateIds ? '' : 'PRIMARY KEY'},
      year INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      compensation_amount INTEGER CHECK (compensation_amount >= 0)
    );
    INSERT INTO labor_cases VALUES ('LC-1', 2025, '未签劳动合同', 'employee_win', 10000);
    ${duplicateIds ? "INSERT INTO labor_cases VALUES ('LC-1', 2024, '未签劳动合同', 'employer_win', 0);" : ''}
  `);
  database.close?.();
  const dataSource = createSQLiteDataSource({
    id: 'local.legal_cases.write',
    databasePath,
    allowedTables: ['labor_cases'],
    allowedColumns: ['case_id', 'year', 'issue_type', 'outcome', 'compensation_amount'],
    accessMode: 'read-write',
    allowedWriteOperations: ['insert', 'update', 'delete'],
    requiresHumanReview: true,
    maxAffectedRows: 1,
    projectRoot
  });
  return {
    dataSource,
    databasePath,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

function readAmounts(databasePath) {
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare('SELECT compensation_amount FROM labor_cases ORDER BY year;').all().map((row) => Number(row.compensation_amount));
  } finally {
    database.close?.();
  }
}

function runtimeInput(text, runId = 'run-write-1') {
  return { runId, sessionId: 'session-write-1', piiRedacted: true, redactedText: text };
}

test('Human Review blocks mutation until approval and executes the approved plan once', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = await runtime.plan(runtimeInput('将案例 LC-1 的赔偿金额更新为 22000'));
    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.plan.status, 'human_review_required');
    assert.equal(planned.plan.humanReviewRequired, true);
    assert.equal(planned.executionAttempted, false);
    assert.deepEqual(readAmounts(fixture.databasePath), [10000]);
    assert.equal(planned.governanceReceipt.eventTypes.includes('human.review.requested'), true);

    const completed = await runtime.execute({
      ...runtimeInput('将案例 LC-1 的赔偿金额更新为 22000'),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      governedInvocationId: planned.plan.governedInvocationId,
      confirmedAt: '2026-08-03T10:00:00.000Z',
      confirmedPlan: planned.plan
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { status: 'committed', affectedRows: 1, transactionStatus: 'committed' });
    assert.deepEqual(readAmounts(fixture.databasePath), [22000]);
    assert.equal(completed.governanceReceipt.eventTypes.includes('human.review.approved'), true);
    assert.equal(completed.governanceReceipt.eventTypes.includes('human.review.resolved'), true);

    const repeated = await runtime.execute({
      ...runtimeInput('将案例 LC-1 的赔偿金额更新为 22000'),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      governedInvocationId: planned.plan.governedInvocationId,
      confirmedPlan: planned.plan
    });
    assert.equal(repeated.status, 'rejected');
    assert.deepEqual(readAmounts(fixture.databasePath), [22000]);
  } finally {
    fixture.cleanup();
  }
});

test('rejected Human Review and dangerous DDL never reach SQLite', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = await runtime.plan(runtimeInput('删除案例 LC-1', 'run-reject'));
    const rejected = await runtime.reject({
      runId: 'run-reject',
      governedInvocationId: planned.plan.governedInvocationId
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.governanceReceipt.eventTypes.includes('human.review.rejected'), true);
    assert.deepEqual(readAmounts(fixture.databasePath), [10000]);

    const ddl = await runtime.plan(runtimeInput('DROP TABLE labor_cases', 'run-ddl'));
    assert.equal(ddl.errorCode, 'DANGEROUS_OPERATION_DENIED');
    assert.equal(ddl.executionAttempted, false);
    assert.deepEqual(readAmounts(fixture.databasePath), [10000]);
  } finally {
    fixture.cleanup();
  }
});

test('approved write failure is reported as rolled back with no automatic retry', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    assert.equal(runtime.describe().limits.maxAttempts, 1);
    const planned = await runtime.plan(
      runtimeInput('新增案例 LC-1，年份 2026，事项 未签劳动合同，结果 employee_win，赔偿 20000', 'run-duplicate')
    );
    const failed = await runtime.execute({
      ...runtimeInput('', 'run-duplicate'),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      governedInvocationId: planned.plan.governedInvocationId,
      confirmedAt: '2026-08-03T10:00:00.000Z',
      confirmedPlan: planned.plan
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.executionAttempted, true);
    assert.deepEqual(failed.result, { status: 'failed', affectedRows: 0, transactionStatus: 'rolled_back' });
    assert.equal(failed.governanceReceipt.status, 'resolved_failed');
    assert.deepEqual(readAmounts(fixture.databasePath), [10000]);
  } finally {
    fixture.cleanup();
  }
});

test('affected-row overflow and constraint failures roll back the transaction', async () => {
  const duplicateFixture = createFixture({ duplicateIds: true });
  try {
    const schema = await duplicateFixture.dataSource.inspectSchema();
    await assert.rejects(
      duplicateFixture.dataSource.executeWrite({
        sql: 'UPDATE labor_cases SET compensation_amount = :compensation_amount WHERE case_id = :case_id;',
        parameters: { case_id: 'LC-1', compensation_amount: 99999 },
        expectedSchemaFingerprint: schema.schemaFingerprint
      }),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'AFFECTED_ROWS_LIMIT_EXCEEDED'
    );
    assert.deepEqual(readAmounts(duplicateFixture.databasePath), [0, 10000]);
  } finally {
    duplicateFixture.cleanup();
  }

  const constrainedFixture = createFixture();
  try {
    const schema = await constrainedFixture.dataSource.inspectSchema();
    await assert.rejects(
      constrainedFixture.dataSource.executeWrite({
        sql: 'UPDATE labor_cases SET compensation_amount = :compensation_amount WHERE case_id = :case_id;',
        parameters: { case_id: 'LC-1', compensation_amount: -1 },
        expectedSchemaFingerprint: schema.schemaFingerprint
      }),
      (error) => error instanceof SQLiteDataSourceError && /CHECK constraint failed/.test(error.message)
    );
    assert.deepEqual(readAmounts(constrainedFixture.databasePath), [10000]);
  } finally {
    constrainedFixture.cleanup();
  }
});

test('conversation confirmation records only safe governance and transaction receipts', async () => {
  const fixture = createFixture();
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-write-log-'));
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const service = new LegalSelfCheckConversationService({
      store: new InMemoryLegalSessionStore(),
      ownerId: 'private-owner-id',
      idFactory: () => 'write-session-1',
      clock: () => '2026-08-03T10:00:00.000Z',
      autoCleanup: false,
      v1Runtime: runtime,
      executionLog: createDemoExecutionLog({ filePath: path.join(logDirectory, 'execution.jsonl') })
    });
    const started = await service.start({
      userText: '将案例 LC-1 的赔偿金额更新为 33000',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    assert.equal(started.status, 'awaiting_confirmation');
    assert.equal(started.v1.plan.humanReviewRequired, true);
    assert.deepEqual(readAmounts(fixture.databasePath), [10000]);

    const completed = await service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.result.affectedRows, 1);
    assert.deepEqual(readAmounts(fixture.databasePath), [33000]);
    const logs = service.listV1ExecutionLogs();
    const execution = logs.find((entry) => entry.operationType === 'execute');
    assert.equal(execution.humanReviewRequired, true);
    assert.equal(execution.humanReviewStatus, 'approved_and_resolved');
    assert.equal(execution.transactionStatus, 'committed');
    assert.equal(execution.affectedRows, 1);
    assert.match(execution.governedInvocationId, /^lexpilot-write-[0-9a-f]{24}$/);
    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes('private-owner-id'), false);
    assert.equal(serialized.includes(fixture.databasePath), false);
    assert.equal(serialized.includes('33000'), false);
  } finally {
    fixture.cleanup();
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
});
