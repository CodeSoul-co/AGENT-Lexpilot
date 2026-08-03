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
      expectedSchemaFingerprint: planned.plan.schemaFingerprint
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
      expectedSchemaFingerprint: planned.plan.schemaFingerprint
    });
    assert.equal(executed.status, 'rejected');
    assert.equal(executed.errorCode, 'SCHEMA_DRIFT');
    assert.equal(executed.executionAttempted, false);
    assert.match(executed.reason, /Schema 已变化/);
  } finally {
    fixture.cleanup();
  }
});

test('integrates async SQLite execution with confirmation, session state, and audit log', async () => {
  const fixture = createFixture();
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
      executionLog
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
    assert.equal(service.getSession(started.sessionId).status, 'completed');
    const logs = service.listV1ExecutionLogs();
    assert.equal(logs.length, 2);
    assert.equal(logs.find((entry) => entry.operationType === 'execute').status, 'completed');
    assert.equal(service.getV1ExecutionLogIntegrity().status, 'verified');
  } finally {
    fixture.cleanup();
  }
});

test('boots the local application in explicit SQLite mode while demo remains the default', async () => {
  const fixture = createFixture();
  try {
    const dataDirectory = path.join(fixture.directory, 'application-data');
    const application = await createLocalLegalAgentApplication({
      projectRoot,
      environment: {
        LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
        LEGAL_SESSION_OWNER_ID: 'sqlite-application-owner',
        LEGAL_SESSION_DATA_DIR: dataDirectory,
        LEGAL_AGENT_PROVIDER: 'demo',
        LEGAL_V1_RUNTIME: 'sqlite',
        LEGAL_V1_SQLITE_PATH: fixture.databasePath
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
  } finally {
    fixture.cleanup();
  }
});
