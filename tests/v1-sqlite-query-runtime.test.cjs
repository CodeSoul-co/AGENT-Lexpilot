const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaAdaptersLocal } = require('../scripts/hypha-paths.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { createLocalLegalAgentApplication } = require('../src/v0/app-bootstrap.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const { createExecutionArtifactRepository } = require('../src/v1/execution-artifact-repository.cjs');
const {
  CASE_COUNT_WIN_RATE_TEMPLATE_ID
} = require('../src/v1/constrained-text2sql-planner.cjs');
const { createSQLiteDataSource } = require('../src/v1/sqlite-data-source.cjs');
const { createV1SQLiteQueryRuntime } = require('../src/v1/sqlite-query-runtime.cjs');

const PROFESSIONAL_QUERY_TEXT = '统计近三年案例库中未签劳动合同案件的胜诉率和赔偿中位数。';
const projectRoot = path.resolve(__dirname, '..');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-sqlite-runtime-'));
  const databasePath = path.join(directory, 'legal-cases.sqlite');
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE labor_cases (
      case_id TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      compensation_amount INTEGER
    );
    INSERT INTO labor_cases VALUES
      ('LC-2023-1', 2023, '未签劳动合同', 'employee_win', 10000),
      ('LC-2023-2', 2023, '未签劳动合同', 'employer_win', 0),
      ('LC-2024-1', 2024, '未签劳动合同', 'employee_win', 20000),
      ('LC-2024-2', 2024, '未签劳动合同', 'employee_win', 30000),
      ('LC-2025-1', 2025, '未签劳动合同', 'employee_win', 40000),
      ('LC-2025-X', 2025, '解除劳动合同', 'employee_win', 50000);
  `);
  database.close?.();
  const dataSource = createSQLiteDataSource({
    id: 'local.legal_cases',
    databasePath,
    allowedTables: ['labor_cases'],
    allowedColumns: ['year', 'issue_type', 'outcome', 'compensation_amount'],
    projectRoot
  });
  return {
    directory,
    databasePath,
    dataSource,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

function runtimeInput(redactedText = PROFESSIONAL_QUERY_TEXT) {
  return {
    runId: 'sqlite-run-1',
    sessionId: 'sqlite-session-1',
    ownerId: 'sqlite-owner',
    piiRedacted: true,
    redactedText,
    clarificationRound: 0,
    knownFacts: {}
  };
}

test('plans and executes the supported template against the configured SQLite database', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const descriptor = runtime.describe();
    assert.equal(descriptor.runtime, 'sqlite-readonly');
    assert.equal(descriptor.executionProvider, 'hypha-adapters-local.loadSqlite');
    assert.equal(descriptor.hyphaSourceModified, false);

    const planned = runtime.plan(runtimeInput());
    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.executionAttempted, false);
    assert.equal(planned.plan.readOnly, true);
    assert.match(planned.plan.schemaFingerprint, /^[0-9a-f]{64}$/);

    const executed = await runtime.execute({
      ...runtimeInput(),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });
    assert.equal(executed.status, 'completed');
    assert.equal(executed.executionAttempted, true);
    assert.equal(executed.result.sourceRowCount, 5);
    assert.deepEqual(
      executed.result.rows.map((row) => ({
        year: row.year,
        caseCount: row.case_count,
        winRate: row.employee_win_rate,
        median: row.median_compensation
      })),
      [
        { year: 2023, caseCount: 2, winRate: 50, median: 10000 },
        { year: 2024, caseCount: 2, winRate: 100, median: 25000 },
        { year: 2025, caseCount: 1, winRate: 100, median: 40000 }
      ]
    );
    assert.equal(executed.providerReceipt.readOnly, true);
    assert.equal(executed.providerReceipt.sourceRowCount, 5);
    assert.match(executed.artifact.contentSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(executed.trace).includes(fixture.databasePath), false);
  } finally {
    fixture.cleanup();
  }
});

test('plans and executes the independent case-count and win-rate template', async () => {
  const fixture = createFixture();
  const queryText = '查询案例库近三年未签劳动合同案件数量和胜诉率。';
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = runtime.plan(runtimeInput(queryText));

    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.plan.templateId, CASE_COUNT_WIN_RATE_TEMPLATE_ID);
    assert.equal(planned.plan.sql.includes('compensation_amount'), false);
    assert.deepEqual(planned.plan.semanticQuery.selectedColumns, ['year', 'outcome']);
    assert.deepEqual(planned.plan.expectedOutput.columns, [
      'year',
      'case_count',
      'employee_win_rate'
    ]);
    assert.equal(planned.plan.executionSteps.length, 3);

    const executed = await runtime.execute({
      ...runtimeInput(queryText),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });

    assert.equal(executed.status, 'completed');
    assert.deepEqual(executed.result.columns, [
      'year',
      'case_count',
      'employee_win_rate'
    ]);
    assert.deepEqual(executed.result.rows, [
      { year: 2023, case_count: 2, employee_win_rate: 50 },
      { year: 2024, case_count: 2, employee_win_rate: 100 },
      { year: 2025, case_count: 1, employee_win_rate: 100 }
    ]);
    assert.equal(executed.result.sourceRowCount, 5);
    assert.equal(executed.artifact.fileName, '案件数量与胜诉率分析.md');
    assert.match(executed.artifact.content, /案件数量与胜诉率分析/);
    assert.equal(executed.artifact.content.includes('赔偿'), false);
    assert.equal(executed.artifact.content.includes('¥'), false);
  } finally {
    fixture.cleanup();
  }
});

test('binds an explicit year range into parameters and limits the executed rows', async () => {
  const fixture = createFixture();
  const queryText = '统计2024年至2025年案例库中未签劳动合同案件的胜诉率和赔偿中位数。';
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = runtime.plan(runtimeInput(queryText));

    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.plan.templateId, 'labor-case-yearly-outcome-statistics.v1');
    assert.deepEqual(planned.plan.parameters, {
      start_year: 2024,
      end_year: 2025,
      issue_type: '未签劳动合同'
    });
    assert.equal(planned.plan.sql.includes('2024'), false);
    assert.deepEqual(planned.plan.semanticQuery.yearRange, [2024, 2025]);

    const executed = await runtime.execute({
      ...runtimeInput(queryText),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });
    assert.equal(executed.status, 'completed');
    assert.equal(executed.result.sourceRowCount, 3);
    assert.deepEqual(executed.result.rows.map((row) => row.year), [2024, 2025]);
    assert.match(executed.artifact.content, /2024-2025 年未签劳动合同案例分析/);
  } finally {
    fixture.cleanup();
  }
});

test('stops execution when the natural-language range changes after confirmation', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = runtime.plan(runtimeInput());
    const changed = await runtime.execute({
      ...runtimeInput('统计2024年至2025年未签劳动合同案件的胜诉率和赔偿中位数。'),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });

    assert.equal(changed.status, 'rejected');
    assert.equal(changed.errorCode, 'PLAN_DRIFT');
    assert.equal(changed.executionAttempted, false);
  } finally {
    fixture.cleanup();
  }
});

test('stops execution when the selected template changes after confirmation', async () => {
  const fixture = createFixture();
  const countQuery = '统计近三年未签劳动合同案件数量和胜诉率。';
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = runtime.plan(runtimeInput(countQuery));
    const changed = await runtime.execute({
      ...runtimeInput(PROFESSIONAL_QUERY_TEXT),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });

    assert.equal(changed.status, 'rejected');
    assert.equal(changed.errorCode, 'PLAN_DRIFT');
    assert.equal(changed.executionAttempted, false);
  } finally {
    fixture.cleanup();
  }
});

test('rejects writes and unsupported natural-language templates before SQLite execution', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const write = runtime.plan(runtimeInput('删除案例库中的全部数据'));
    assert.equal(write.status, 'rejected');
    assert.equal(write.errorCode, 'WRITE_OPERATION_BLOCKED');
    assert.equal(write.executionAttempted, false);

    const unsupported = runtime.plan(runtimeInput('统计知识产权案件数量。'));
    assert.equal(unsupported.status, 'rejected');
    assert.equal(unsupported.errorCode, 'QUERY_TEMPLATE_NOT_SUPPORTED');
    assert.equal(unsupported.executionAttempted, false);

    const rawSql = runtime.plan(
      runtimeInput(
        'SELECT year FROM labor_cases; 统计2025年未签劳动合同案件的胜诉率和赔偿中位数。'
      )
    );
    assert.equal(rawSql.status, 'rejected');
    assert.equal(rawSql.errorCode, 'RAW_SQL_INPUT_BLOCKED');
    assert.equal(rawSql.executionAttempted, false);
  } finally {
    fixture.cleanup();
  }
});

test('stops confirmed execution when the live SQLite Schema drifts', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const planned = runtime.plan(runtimeInput());

    const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
    const writable = new sqlite.DatabaseSync(fixture.databasePath);
    writable.exec(
      'ALTER TABLE labor_cases RENAME COLUMN compensation_amount TO compensation_total;'
    );
    writable.close?.();

    const executed = await runtime.execute({
      ...runtimeInput(),
      expectedPlanHash: planned.plan.planHash,
      expectedSchemaFingerprint: planned.plan.schemaFingerprint,
      expectedSchemaSnapshot: planned.plan.schemaSnapshot
    });
    assert.equal(executed.status, 'rejected');
    assert.equal(executed.errorCode, 'SCHEMA_DRIFT');
    assert.equal(executed.executionAttempted, false);
    assert.match(executed.reason, /Schema 已变化/);
    assert.equal(executed.replanRequired, true);
    assert.equal(executed.schemaDrift.detected, true);
    assert.deepEqual(executed.schemaDrift.affectedTables, ['labor_cases']);
    assert.deepEqual(executed.schemaDrift.affectedFields, ['labor_cases.compensation_amount']);
  } finally {
    fixture.cleanup();
  }
});

test('notifies the session, records the drift, and requires confirmation after replanning', async () => {
  const fixture = createFixture();
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const executionLog = createDemoExecutionLog({
      filePath: path.join(fixture.directory, 'schema-drift-log.jsonl')
    });
    const service = new LegalSelfCheckConversationService({
      store: new InMemoryLegalSessionStore(),
      ownerId: 'schema-drift-owner',
      idFactory: () => 'schema-drift-session',
      clock: () => '2026-08-03T09:00:00.000Z',
      autoCleanup: false,
      v1Runtime: runtime,
      executionLog
    });
    const started = service.start({
      userText: PROFESSIONAL_QUERY_TEXT,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });

    const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
    const writable = new sqlite.DatabaseSync(fixture.databasePath);
    writable.exec(`
      ALTER TABLE labor_cases RENAME TO labor_cases_previous;
      CREATE TABLE labor_cases (
        case_id TEXT PRIMARY KEY,
        year INTEGER NOT NULL,
        issue_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        compensation_amount TEXT
      );
      INSERT INTO labor_cases SELECT * FROM labor_cases_previous;
      DROP TABLE labor_cases_previous;
    `);
    writable.close?.();

    const rejected = await service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.v1.replanRequired, true);
    assert.deepEqual(rejected.v1.schemaDrift.affectedFields, [
      'labor_cases.compensation_amount'
    ]);
    const rejectedLog = service.listV1ExecutionLogs().find((entry) => entry.operationType === 'execute');
    assert.equal(rejectedLog.schemaDriftDetected, true);
    assert.equal(rejectedLog.affectedFieldCount, 1);
    assert.equal(rejectedLog.replanRequired, true);

    const replanned = await service.replanV1Execution(started.sessionId);
    assert.equal(replanned.status, 'awaiting_confirmation');
    assert.equal(replanned.v1.replanRequired, false);
    assert.equal(replanned.v1.schemaDrift.resolution, 'replanned');
    assert.notEqual(replanned.v1.plan.schemaFingerprint, started.v1.plan.schemaFingerprint);

    const duplicateReplan = service.replanV1Execution(started.sessionId);
    assert.equal(duplicateReplan.error.code, 'V1_REPLAN_NOT_REQUIRED');
    const completed = await service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.result.sourceRowCount, 5);
    assert.equal(service.listV1ExecutionLogs().filter((entry) => entry.operationType === 'replan').length, 1);
    assert.equal(service.getV1ExecutionLogIntegrity().status, 'verified');
  } finally {
    fixture.cleanup();
  }
});

test('integrates async SQLite execution with confirmation, session state, and audit log', async () => {
  const fixture = createFixture();
  const artifactRepository = createExecutionArtifactRepository({
    rootPath: path.join(fixture.directory, 'artifacts'),
    projectRoot
  });
  try {
    const runtime = await createV1SQLiteQueryRuntime({ dataSource: fixture.dataSource });
    const executionLog = createDemoExecutionLog({
      filePath: path.join(fixture.directory, 'execution-log.jsonl')
    });
    const service = new LegalSelfCheckConversationService({
      store: new InMemoryLegalSessionStore(),
      ownerId: 'sqlite-integration-owner',
      idFactory: () => 'sqlite-integration-session',
      clock: () => '2026-08-03T08:00:00.000Z',
      autoCleanup: false,
      v1Runtime: runtime,
      executionLog,
      artifactRepository
    });
    const started = service.start({
      userText: PROFESSIONAL_QUERY_TEXT,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    assert.equal(started.status, 'awaiting_confirmation');

    const pending = service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(typeof pending.then, 'function');
    assert.equal(service.getSession(started.sessionId).status, 'executing');
    const duplicate = service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(duplicate.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');

    const completed = await pending;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.result.sourceRowCount, 5);
    assert.equal(completed.v1.artifact.storage.storeId, 'lexpilot.execution-artifacts.local');
    assert.match(completed.v1.artifact.storage.objectKey, /^analysis\/[0-9a-f]{64}\.md$/);
    const persisted = await artifactRepository.readAnalysisArtifact(
      completed.v1.artifact.storage
    );
    assert.equal(persisted.content, completed.v1.artifact.content);
    assert.equal(persisted.contentSha256, completed.v1.artifact.contentSha256);
    assert.equal(service.getSession(started.sessionId).status, 'completed');
    const logs = service.listV1ExecutionLogs();
    assert.equal(logs.length, 2);
    const executionEntry = logs.find((entry) => entry.operationType === 'execute');
    assert.equal(executionEntry.status, 'completed');
    assert.equal(executionEntry.executionProvider, 'hypha-adapters-local.loadSqlite');
    assert.equal(executionEntry.providerReadOnly, true);
    assert.equal(executionEntry.sourceRowCount, 5);
    assert.equal(Number.isSafeInteger(executionEntry.providerDurationMs), true);
    assert.equal(Number.isSafeInteger(executionEntry.providerOutputBytes), true);
    assert.equal(executionEntry.artifactStoreId, 'lexpilot.execution-artifacts.local');
    assert.equal(executionEntry.artifactObjectKey, completed.v1.artifact.storage.objectKey);
    assert.equal(service.getV1ExecutionLogIntegrity().status, 'verified');
  } finally {
    await artifactRepository.close();
    fixture.cleanup();
  }
});

test('boots the local application in explicit SQLite mode while demo remains the default', async () => {
  const fixture = createFixture();
  let application;
  try {
    const dataDirectory = path.join(fixture.directory, 'application-data');
    application = await createLocalLegalAgentApplication({
      projectRoot,
      environment: {
        LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
        LEGAL_SESSION_OWNER_ID: 'sqlite-application-owner',
        LEGAL_SESSION_DATA_DIR: dataDirectory,
        LEGAL_AGENT_PROVIDER: 'demo',
        LEGAL_V1_RUNTIME: 'sqlite',
        LEGAL_V1_SQLITE_PATH: fixture.databasePath,
        LEGAL_V1_ARTIFACT_DIR: path.join(fixture.directory, 'application-artifacts')
      }
    });
    assert.equal(application.v1Descriptor.runtime, 'sqlite-readonly');
    assert.equal(application.v1Descriptor.hyphaSourceModified, false);

    const started = await application.service.start({
      userText: PROFESSIONAL_QUERY_TEXT,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    assert.equal(started.status, 'awaiting_confirmation');
    const completed = await application.service.confirmV1Execution(started.sessionId, {
      confirmed: true
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.result.sourceRowCount, 5);
    assert.equal(completed.v1.artifact.storage.storeId, 'lexpilot.execution-artifacts.local');
    assert.equal(application.artifactDirectory.startsWith(fixture.directory), true);
  } finally {
    await application?.close();
    fixture.cleanup();
  }
});
