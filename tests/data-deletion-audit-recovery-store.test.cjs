const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const {
  createDataDeletionAuditRecoveryStore
} = require('../src/v1/data-deletion-audit-recovery-store.cjs');
const {
  DATA_DELETION_PHASES,
  DATA_DELETION_SCOPES,
  createDataDeletionAuditEntry
} = require('../src/v1/data-deletion-audit-receipt.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');

const ACTOR_ID = `actor-sha256-${'a'.repeat(64)}`;
const OPERATION_ID = 'lexpilot-deletion.00000000-0000-4000-8000-000000000010';

function completedEntry(overrides = {}) {
  return createDataDeletionAuditEntry({
    operationId: OPERATION_ID,
    scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
    phase: DATA_DELETION_PHASES.COMPLETED,
    targetSessionCount: 1,
    targetArtifactCount: 0,
    deletedSessionCount: 1,
    deletedArtifactCount: 0,
    deletionFailureCount: 0,
    ...overrides
  });
}

async function temporaryDirectory(prefix, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('atomically queues only validated aggregate outcomes and removes them idempotently', async () => {
  await temporaryDirectory('deletion-audit-recovery-store-', (directory) => {
    const store = createDataDeletionAuditRecoveryStore({ directory });
    const entry = completedEntry();
    assert.deepEqual(store.enqueue({ actorId: ACTOR_ID, entry }), {
      status: 'queued',
      operationId: OPERATION_ID
    });
    assert.deepEqual(store.enqueue({ actorId: ACTOR_ID, entry }), {
      status: 'already_queued',
      operationId: OPERATION_ID
    });
    const [queued] = store.list();
    assert.equal(Object.isFrozen(queued), true);
    assert.equal(queued.entry.deletionOperationId, OPERATION_ID);
    const raw = fs.readFileSync(path.join(directory, `${OPERATION_ID}.json`), 'utf8');
    assert.equal(raw.includes('owner-id'), false);
    assert.equal(raw.includes('session-id'), false);
    assert.equal(raw.includes('artifact-key'), false);
    assert.throws(
      () => store.enqueue({
        actorId: ACTOR_ID,
        entry: completedEntry({ targetSessionCount: 2 })
      }),
      (error) => error?.code === 'DELETION_AUDIT_RECOVERY_CONFLICT'
    );
    assert.deepEqual(store.remove(OPERATION_ID), {
      status: 'removed',
      operationId: OPERATION_ID
    });
    assert.deepEqual(store.remove(OPERATION_ID), {
      status: 'already_absent',
      operationId: OPERATION_ID
    });
    assert.deepEqual(store.list(), []);
  });
});

test('fails closed on unsafe files and tampered recovery envelopes', async () => {
  await temporaryDirectory('deletion-audit-recovery-tamper-', (directory) => {
    const store = createDataDeletionAuditRecoveryStore({ directory });
    fs.writeFileSync(path.join(directory, 'unexpected.txt'), '{}', 'utf8');
    assert.throws(
      () => store.list(),
      (error) => error?.code === 'DELETION_AUDIT_RECOVERY_INVALID'
    );
    fs.rmSync(path.join(directory, 'unexpected.txt'));
    store.enqueue({ actorId: ACTOR_ID, entry: completedEntry() });
    const filePath = path.join(directory, `${OPERATION_ID}.json`);
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    envelope.entry.privateSessionId = 'must-never-be-accepted';
    fs.writeFileSync(filePath, JSON.stringify(envelope), 'utf8');
    assert.throws(
      () => store.list(),
      (error) => error?.code === 'DELETION_AUDIT_RECOVERY_INVALID'
    );
  });
});

test('queues a failed outcome append and reconciles it before the next service can run', async () => {
  await temporaryDirectory('deletion-audit-reconcile-', async (directory) => {
    const log = createDemoExecutionLog({ filePath: path.join(directory, 'execution-log.jsonl') });
    const recoveryStore = createDataDeletionAuditRecoveryStore({
      directory: path.join(directory, 'recovery')
    });
    let failCompletedOnce = true;
    const intermittentLog = Object.freeze({
      append(entry) {
        if (entry.deletionPhase === DATA_DELETION_PHASES.COMPLETED && failCompletedOnce) {
          failCompletedOnce = false;
          throw new Error('simulated outcome append failure');
        }
        return log.append(entry);
      },
      findDeletionAuditRecord(input) { return log.findDeletionAuditRecord(input); },
      list(filter) { return log.list(filter); },
      verifyIntegrity() { return log.verifyIntegrity(); }
    });
    const sessions = new InMemoryLegalSessionStore();
    const service = new LegalSelfCheckConversationService({
      store: sessions,
      ownerId: 'private-recovery-owner',
      auditActorId: ACTOR_ID,
      idFactory: () => 'private-recovery-session',
      deletionAuditIdFactory: () => OPERATION_ID,
      autoCleanup: false,
      executionLog: intermittentLog,
      deletionAuditRecoveryStore: recoveryStore
    });
    service.start({
      userText: '不得进入恢复队列的原始法律问题。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const deleted = await service.deleteSessionWithArtifacts('private-recovery-session', {
      confirmed: true
    });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.deletionAudit.recorded, false);
    assert.equal(deleted.deletionAudit.recoveryQueued, true);
    assert.equal(sessions.count(), 0);
    assert.equal(recoveryStore.list().length, 1);
    const recoveryRaw = fs.readFileSync(
      path.join(directory, 'recovery', `${OPERATION_ID}.json`),
      'utf8'
    );
    assert.equal(recoveryRaw.includes('private-recovery-owner'), false);
    assert.equal(recoveryRaw.includes('private-recovery-session'), false);
    assert.equal(recoveryRaw.includes('不得进入恢复队列'), false);

    const restarted = new LegalSelfCheckConversationService({
      store: sessions,
      ownerId: 'private-recovery-owner',
      auditActorId: ACTOR_ID,
      autoCleanup: false,
      executionLog: intermittentLog,
      deletionAuditRecoveryStore: recoveryStore
    });
    assert.deepEqual(restarted.lastDeletionAuditReconciliation, {
      status: 'completed',
      pendingCount: 1,
      appendedCount: 1,
      alreadyRecordedCount: 0,
      remainingCount: 0
    });
    assert.deepEqual(recoveryStore.list(), []);
    const records = log.list({ limit: 10 }).sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(records.map((record) => record.deletionPhase), ['requested', 'completed']);
    assert.equal(records[0].deletionOperationId, records[1].deletionOperationId);
    assert.equal(log.verifyIntegrity().status, 'verified');
  });
});

test('removes a crash-window recovery record without duplicating an existing outcome', async () => {
  await temporaryDirectory('deletion-audit-idempotent-', (directory) => {
    const log = createDemoExecutionLog({ filePath: path.join(directory, 'execution-log.jsonl') });
    const recoveryStore = createDataDeletionAuditRecoveryStore({
      directory: path.join(directory, 'recovery')
    });
    const entry = completedEntry();
    recoveryStore.enqueue({ actorId: ACTOR_ID, entry });
    log.append({ actorId: ACTOR_ID, ...entry });

    const service = new LegalSelfCheckConversationService({
      store: new InMemoryLegalSessionStore(),
      ownerId: 'idempotent-owner',
      auditActorId: ACTOR_ID,
      autoCleanup: false,
      executionLog: log,
      deletionAuditRecoveryStore: recoveryStore
    });
    assert.deepEqual(service.lastDeletionAuditReconciliation, {
      status: 'completed',
      pendingCount: 1,
      appendedCount: 0,
      alreadyRecordedCount: 1,
      remainingCount: 0
    });
    assert.equal(log.verifyIntegrity().recordCount, 1);
    assert.deepEqual(recoveryStore.list(), []);
  });
});
