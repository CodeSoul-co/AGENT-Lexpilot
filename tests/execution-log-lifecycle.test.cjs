const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createDataDeletionAuditRecoveryStore
} = require('../src/v1/data-deletion-audit-recovery-store.cjs');
const {
  DATA_DELETION_PHASES,
  DATA_DELETION_SCOPES,
  createDataDeletionAuditEntry
} = require('../src/v1/data-deletion-audit-receipt.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const {
  DELETE_SOURCE_CONFIRMATION,
  ExecutionLogLifecycleError,
  createExecutionLogLifecycle
} = require('../src/v1/execution-log-lifecycle.cjs');

const DELETION_OPERATION_ID = 'lexpilot-deletion.11111111-1111-4111-8111-111111111111';
const AUDIT_ACTOR_ID = `actor-sha256-${'a'.repeat(64)}`;

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-log-lifecycle-test-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function appendRecords(filePath, count = 2) {
  let tick = 0;
  const log = createDemoExecutionLog({
    filePath,
    clock: () => `2026-08-04T01:00:0${tick++}.000Z`,
    idFactory: () => `entry-${tick}`
  });
  for (let index = 0; index < count; index += 1) {
    log.append({
      actorId: `actor-sha256-${'a'.repeat(64)}`,
      sessionId: `session-${index + 1}`,
      runId: `run-${index + 1}`,
      operationType: 'execute',
      status: 'completed',
      durationMs: index + 1,
      rowCount: index + 1
    });
  }
  return log;
}

function deletionEntry(phase, overrides = {}) {
  return createDataDeletionAuditEntry({
    operationId: DELETION_OPERATION_ID,
    scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
    phase,
    targetSessionCount: 1,
    targetArtifactCount: 2,
    deletedSessionCount: phase === DATA_DELETION_PHASES.REQUESTED ? 0 : 1,
    deletedArtifactCount: phase === DATA_DELETION_PHASES.REQUESTED ? 0 : 2,
    deletionFailureCount: phase === DATA_DELETION_PHASES.FAILED ? 1 : 0,
    ...overrides
  });
}

function appendDeletionAuditRecords(filePath) {
  let tick = 0;
  const log = createDemoExecutionLog({
    filePath,
    clock: () => `2026-08-04T03:00:0${tick++}.000Z`,
    idFactory: () => `deletion-entry-${tick}`
  });
  log.append({ actorId: AUDIT_ACTOR_ID, ...deletionEntry(DATA_DELETION_PHASES.REQUESTED) });
  log.append({ actorId: AUDIT_ACTOR_ID, ...deletionEntry(DATA_DELETION_PHASES.COMPLETED) });
  return log;
}

function createLifecycle(directory, overrides = {}) {
  return createExecutionLogLifecycle({
    filePath: path.join(directory, 'live', 'v1-execution-log.jsonl'),
    archiveDirectory: path.join(directory, 'archives'),
    clock: () => '2026-08-04T02:00:00.000Z',
    idFactory: () => 'archive-001',
    ...overrides
  });
}

test('archives an exact verified snapshot without deleting the live append-only log', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    appendRecords(filePath);
    const before = fs.readFileSync(filePath);
    const lifecycle = createLifecycle(directory);

    const archived = lifecycle.archive();
    assert.equal(archived.status, 'verified');
    assert.equal(archived.archiveId, 'archive-001');
    assert.equal(archived.recordCount, 2);
    assert.match(archived.sha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(filePath), true);

    const archivedFile = path.join(directory, 'archives', 'archive-001', 'execution-log.jsonl');
    const manifestFile = path.join(directory, 'archives', 'archive-001', 'manifest.json');
    assert.deepEqual(fs.readFileSync(archivedFile), before);
    const manifestText = fs.readFileSync(manifestFile, 'utf8');
    assert.equal(manifestText.includes(directory), false);
    assert.equal(JSON.parse(manifestText).sourceDeletionPolicy, 'verified-archive-and-exact-byte-match');
    assert.deepEqual(lifecycle.verifyArchive('archive-001'), archived);
    assert.equal(Object.isFrozen(lifecycle), true);
  });
});

test('deletes the source only after explicit confirmation and restores without overwrite', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    appendRecords(filePath);
    const before = fs.readFileSync(filePath);
    const lifecycle = createLifecycle(directory);
    lifecycle.archive();

    assert.throws(
      () => lifecycle.deleteSource({ archiveId: 'archive-001' }),
      (error) =>
        error instanceof ExecutionLogLifecycleError &&
        error.code === 'SOURCE_DELETE_CONFIRMATION_REQUIRED'
    );
    assert.equal(fs.existsSync(filePath), true);

    const deleted = lifecycle.deleteSource({
      archiveId: 'archive-001',
      confirmation: DELETE_SOURCE_CONFIRMATION
    });
    assert.equal(deleted.status, 'deleted');
    assert.equal(fs.existsSync(filePath), false);

    const restored = lifecycle.restoreSource('archive-001');
    assert.equal(restored.status, 'restored');
    assert.equal(restored.recordCount, 2);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.equal(createDemoExecutionLog({ filePath }).verifyIntegrity().status, 'verified');
    assert.throws(
      () => lifecycle.restoreSource('archive-001'),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'SOURCE_LOG_ALREADY_EXISTS'
    );
  });
});

test('blocks archive and source deletion while deletion audit outcomes await reconciliation', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    appendRecords(filePath);
    const recoveryStore = createDataDeletionAuditRecoveryStore({
      directory: path.join(directory, 'live', 'deletion-audit-recovery')
    });
    recoveryStore.enqueue({
      actorId: AUDIT_ACTOR_ID,
      entry: deletionEntry(DATA_DELETION_PHASES.COMPLETED)
    });
    const lifecycle = createLifecycle(directory);

    assert.throws(
      () => lifecycle.archive(),
      (error) =>
        error instanceof ExecutionLogLifecycleError &&
        error.code === 'PENDING_DELETION_AUDIT_RECOVERY'
    );
    assert.throws(
      () => lifecycle.findDeletionAudit(DELETION_OPERATION_ID),
      (error) =>
        error instanceof ExecutionLogLifecycleError &&
        error.code === 'PENDING_DELETION_AUDIT_RECOVERY'
    );
    assert.equal(fs.existsSync(path.join(directory, 'archives')), false);

    recoveryStore.remove(DELETION_OPERATION_ID);
    lifecycle.archive();
    recoveryStore.enqueue({
      actorId: AUDIT_ACTOR_ID,
      entry: deletionEntry(DATA_DELETION_PHASES.COMPLETED)
    });
    assert.throws(
      () =>
        lifecycle.deleteSource({
          archiveId: 'archive-001',
          confirmation: DELETE_SOURCE_CONFIRMATION
        }),
      (error) =>
        error instanceof ExecutionLogLifecycleError &&
        error.code === 'PENDING_DELETION_AUDIT_RECOVERY'
    );
    assert.equal(fs.existsSync(filePath), true);
  });
});

test('finds a deletion audit operation across verified live and archived logs', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    appendDeletionAuditRecords(filePath);
    const lifecycle = createLifecycle(directory);
    lifecycle.archive();

    const found = lifecycle.findDeletionAudit(DELETION_OPERATION_ID);
    assert.equal(found.contractVersion, 'lexpilot.data-deletion-audit-lookup.v1');
    assert.equal(found.status, 'found');
    assert.deepEqual(
      found.sources.map((source) => source.sourceType),
      ['live', 'archive']
    );
    assert.deepEqual(
      found.sources.map((source) => source.records.map((record) => record.phase)),
      [
        ['requested', 'completed'],
        ['requested', 'completed']
      ]
    );
    assert.equal(found.sources[1].archiveId, 'archive-001');
    assert.equal(Object.isFrozen(found), true);
    assert.equal(Object.isFrozen(found.sources), true);
    assert.equal(Object.isFrozen(found.sources[0].records[0].logEntryRef), true);
    const serialized = JSON.stringify(found);
    for (const forbidden of ['actorId', 'sessionId', 'artifactObjectKey', directory]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    lifecycle.deleteSource({
      archiveId: 'archive-001',
      confirmation: DELETE_SOURCE_CONFIRMATION
    });
    const archivedOnly = lifecycle.findDeletionAudit(DELETION_OPERATION_ID);
    assert.deepEqual(
      archivedOnly.sources.map((source) => source.sourceType),
      ['archive']
    );

    const missing = lifecycle.findDeletionAudit(
      'lexpilot-deletion.22222222-2222-4222-8222-222222222222'
    );
    assert.equal(missing.status, 'not_found');
    assert.deepEqual(missing.sources, []);
    assert.throws(
      () => lifecycle.findDeletionAudit('../private'),
      /safe LexPilot deletion identifier/
    );
  });
});

test('refuses deletion when the live log advanced after the selected archive', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    const log = appendRecords(filePath);
    const lifecycle = createLifecycle(directory);
    lifecycle.archive();
    log.append({
      actorId: `actor-sha256-${'a'.repeat(64)}`,
      sessionId: 'session-3',
      runId: 'run-3',
      operationType: 'execute',
      status: 'completed'
    });

    assert.throws(
      () =>
        lifecycle.deleteSource({
          archiveId: 'archive-001',
          confirmation: DELETE_SOURCE_CONFIRMATION
        }),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'SOURCE_LOG_CHANGED'
    );
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(createDemoExecutionLog({ filePath }).verifyIntegrity().recordCount, 3);
  });
});

test('detects archive tampering before verification, deletion, or restore', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    appendRecords(filePath);
    const lifecycle = createLifecycle(directory);
    lifecycle.archive();
    const archivedFile = path.join(directory, 'archives', 'archive-001', 'execution-log.jsonl');
    fs.appendFileSync(archivedFile, '{}\n', 'utf8');

    assert.throws(
      () => lifecycle.verifyArchive('archive-001'),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_HASH_MISMATCH'
    );
    assert.throws(
      () => lifecycle.findDeletionAudit(DELETION_OPERATION_ID),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_HASH_MISMATCH'
    );
    assert.throws(
      () =>
        lifecycle.deleteSource({
          archiveId: 'archive-001',
          confirmation: DELETE_SOURCE_CONFIRMATION
        }),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_HASH_MISMATCH'
    );
    assert.equal(fs.existsSync(filePath), true);
  });
});

test('rejects missing, empty, duplicate, and path-traversal archive inputs', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    const lifecycle = createLifecycle(directory);
    assert.throws(
      () => lifecycle.archive(),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'SOURCE_LOG_NOT_FOUND'
    );
    assert.throws(
      () => lifecycle.verifyArchive('missing-archive'),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_NOT_FOUND'
    );

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf8');
    assert.throws(
      () => lifecycle.archive(),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'SOURCE_LOG_NOT_VERIFIED'
    );

    fs.rmSync(filePath);
    appendRecords(filePath);
    lifecycle.archive();
    assert.throws(
      () => lifecycle.archive(),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_ALREADY_EXISTS'
    );
    assert.throws(
      () => lifecycle.verifyArchive('../private'),
      (error) =>
        error instanceof ExecutionLogLifecycleError && error.code === 'ARCHIVE_ID_INVALID'
    );
  });
});

test('runs archive, verify, deletion lookup, delete, and restore through the maintenance command', () => {
  withTemporaryDirectory((directory) => {
    const projectRoot = path.resolve(__dirname, '..');
    const scriptPath = path.join(projectRoot, 'scripts', 'manage-execution-log.cjs');
    const filePath = path.join(directory, 'live', 'v1-execution-log.jsonl');
    const archiveDirectory = path.join(directory, 'archives');
    appendDeletionAuditRecords(filePath);
    const environment = {
      ...process.env,
      LEGAL_V1_EXECUTION_LOG_FILE: filePath,
      LEGAL_V1_EXECUTION_LOG_ARCHIVE_DIR: archiveDirectory
    };
    const invoke = (...arguments_) =>
      spawnSync(process.execPath, [scriptPath, ...arguments_], {
        cwd: projectRoot,
        env: environment,
        encoding: 'utf8'
      });

    const archived = invoke('archive');
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(archived.stdout.includes(directory), false);
    const archiveId = JSON.parse(archived.stdout).archiveId;

    const verified = invoke('verify', archiveId);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).status, 'verified');

    const found = invoke('find-deletion', DELETION_OPERATION_ID);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout.includes(directory), false);
    assert.deepEqual(
      JSON.parse(found.stdout).sources.map((source) => source.sourceType),
      ['live', 'archive']
    );

    const deleted = invoke('delete-source', archiveId, DELETE_SOURCE_CONFIRMATION);
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.equal(fs.existsSync(filePath), false);

    const restored = invoke('restore', archiveId);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).status, 'restored');
    assert.equal(createDemoExecutionLog({ filePath }).verifyIntegrity().recordCount, 2);
  });
});
