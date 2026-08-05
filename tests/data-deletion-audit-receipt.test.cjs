const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const {
  OWNER_HISTORY_ERASURE_PHRASE,
  LegalSelfCheckConversationService
} = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const {
  DATA_DELETION_PHASES,
  DATA_DELETION_SCOPES,
  createDataDeletionAuditEntry
} = require('../src/v1/data-deletion-audit-receipt.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');

const ACTOR_ID = `actor-sha256-${'a'.repeat(64)}`;

test('validates the versioned aggregate-only deletion audit contract', () => {
  const entry = createDataDeletionAuditEntry({
    operationId: 'lexpilot-deletion.00000000-0000-4000-8000-000000000001',
    scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
    phase: DATA_DELETION_PHASES.COMPLETED,
    targetSessionCount: 1,
    targetArtifactCount: 1,
    deletedSessionCount: 1,
    deletedArtifactCount: 1,
    deletionFailureCount: 0
  });
  assert.equal(entry.deletionReceiptVersion, 'lexpilot.data-deletion-audit.v1');
  assert.equal(entry.sessionId, 'privacy-data-deletion');
  assert.equal(entry.operationType, 'session_deletion_completed');
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.hasOwn(entry, 'ownerId'), false);
  assert.equal(Object.hasOwn(entry, 'deletedSessionIds'), false);
  assert.throws(
    () => createDataDeletionAuditEntry({
      operationId: 'lexpilot-deletion.00000000-0000-4000-8000-000000000001',
      scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
      phase: DATA_DELETION_PHASES.COMPLETED,
      targetSessionCount: 1,
      targetArtifactCount: 0,
      deletedSessionCount: 2,
      deletedArtifactCount: 0,
      deletionFailureCount: 0
    }),
    /must not exceed/
  );
});

test('rejects drifted deletion fields before appending them to the hash chain', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-audit-drift-'));
  const executionLog = createDemoExecutionLog({
    filePath: path.join(directory, 'execution-log.jsonl')
  });
  const entry = createDataDeletionAuditEntry({
    operationId: 'lexpilot-deletion.00000000-0000-4000-8000-000000000002',
    scope: DATA_DELETION_SCOPES.RETENTION,
    phase: DATA_DELETION_PHASES.COMPLETED,
    targetSessionCount: 2,
    targetArtifactCount: 0,
    deletedSessionCount: 2,
    deletedArtifactCount: 0,
    deletionFailureCount: 0
  });
  try {
    assert.throws(
      () => executionLog.append({
        actorId: ACTOR_ID,
        ...entry,
        operationType: 'session_deletion_completed'
      }),
      /does not match the data deletion audit contract/
    );
    assert.equal(fs.existsSync(path.join(directory, 'execution-log.jsonl')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('records all three deletion scopes in one immutable hash chain without private identifiers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-audit-contract-'));
  const filePath = path.join(directory, 'execution-log.jsonl');
  let now = '2026-01-01T00:00:00.000Z';
  let id = 0;
  const executionLog = createDemoExecutionLog({ filePath, clock: () => now });
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'private-owner-id',
    auditActorId: ACTOR_ID,
    idFactory: () => `private-session-${++id}`,
    clock: () => now,
    autoCleanup: false,
    executionLog
  });
  const start = () => service.start({
    userText: '这是不得进入审计日志的法律问题。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  try {
    const single = start();
    const singleResult = await service.deleteSessionWithArtifacts(single.sessionId, {
      confirmed: true
    });

    const expired = start();
    now = '2026-04-05T00:00:00.000Z';
    const retentionResult = await service.cleanupInactiveSessionsWithArtifacts();
    assert.equal(retentionResult.deletedCount, 1);
    assert.equal(service.getSession(expired.sessionId), null);

    start();
    const ownerResult = await service.eraseOwnerHistory({
      confirmed: true,
      confirmationPhrase: OWNER_HISTORY_ERASURE_PHRASE
    });

    for (const result of [singleResult, retentionResult, ownerResult]) {
      assert.equal(result.deletionAudit.contractVersion, 'lexpilot.data-deletion-audit.v1');
      assert.equal(result.deletionAudit.recorded, true);
      assert.match(result.deletionAudit.logEntryRef.entryHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(Object.isFrozen(result.deletionAudit), true);
      assert.equal(Object.isFrozen(result.deletionAudit.logEntryRef), true);
    }

    const records = executionLog.list({ limit: 50 }).sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(
      records.map((record) => [record.deletionScope, record.deletionPhase]),
      [
        ['single_session', 'requested'],
        ['single_session', 'completed'],
        ['retention', 'requested'],
        ['retention', 'completed'],
        ['owner_history', 'requested'],
        ['owner_history', 'completed']
      ]
    );
    assert.equal(records[0].deletionOperationId, records[1].deletionOperationId);
    assert.equal(records[2].deletionOperationId, records[3].deletionOperationId);
    assert.equal(records[4].deletionOperationId, records[5].deletionOperationId);
    assert.equal(new Set(records.map((record) => record.deletionOperationId)).size, 3);
    assert.equal(executionLog.verifyIntegrity().status, 'verified');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('private-owner-id'), false);
    assert.equal(raw.includes('private-session-'), false);
    assert.equal(raw.includes('不得进入审计日志'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('records a failed Artifact-first deletion while preserving the Session for retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-audit-failure-'));
  const filePath = path.join(directory, 'execution-log.jsonl');
  const executionLog = createDemoExecutionLog({ filePath });
  const store = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'failure-private-owner',
    auditActorId: ACTOR_ID,
    idFactory: () => 'failure-private-session',
    autoCleanup: false,
    executionLog,
    artifactRepository: {
      async storeAnalysisArtifact() {},
      async readAnalysisArtifact() { throw new Error('private provider failure'); },
      async deleteAnalysisArtifact() { throw new Error('must not be called'); }
    }
  });
  try {
    service.start({
      userText: '不得进入失败审计日志的原始问题。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const session = store.get('failure-private-session', 'failure-private-owner');
    session.v1 = {
      artifact: {
        contentSha256: 'b'.repeat(64),
        storage: {
          storeId: 'private-store',
          objectKey: 'analysis/private-object.md',
          sizeBytes: 12
        }
      }
    };
    store.save(session, 'failure-private-owner');

    await assert.rejects(
      service.deleteSessionWithArtifacts('failure-private-session', { confirmed: true }),
      (error) => error?.code === 'SESSION_DELETE_ARTIFACT_FAILED'
    );
    assert.notEqual(store.get('failure-private-session', 'failure-private-owner'), null);
    const records = executionLog.list({ limit: 10 }).sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(records.map((record) => record.deletionPhase), ['requested', 'failed']);
    assert.equal(records[1].deletedSessionCount, 0);
    assert.equal(records[1].deletedArtifactCount, 0);
    assert.equal(records[1].errorCode, 'SESSION_DELETE_ARTIFACT_FAILED');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('failure-private-owner'), false);
    assert.equal(raw.includes('failure-private-session'), false);
    assert.equal(raw.includes('private provider failure'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
