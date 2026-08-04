const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const { createV1DemoQueryRuntime } = require('../src/v1/demo-query-runtime.cjs');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const QUERY = '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。';

function request() {
  return {
    userText: QUERY,
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  };
}

function createService(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-workspace-archive-service-'));
  let now = START;
  const baseRuntime = createV1DemoQueryRuntime();
  const calls = [];
  const runtime = {
    describe: () => baseRuntime.describe(),
    plan(input) {
      calls.push(['plan', input]);
      return baseRuntime.plan(input);
    },
    execute(input) {
      calls.push(['execute', input]);
      return baseRuntime.execute(input);
    }
  };
  const clock = () => new Date(now).toISOString();
  const executionLog = createDemoExecutionLog({
    filePath: path.join(directory, 'execution-log.jsonl'),
    clock
  });
  let persistedArtifact = null;
  const artifactRepository = options.withArtifactRepository
    ? {
        storeAnalysisArtifact({ artifact }) {
          persistedArtifact = { ...artifact };
          return {
            storeId: 'lexpilot.execution-artifacts.local',
            objectKey: `analysis/${'a'.repeat(64)}.md`,
            contentSha256: artifact.contentSha256,
            sizeBytes: Buffer.byteLength(artifact.content, 'utf8'),
            backend: 'test-store'
          };
        },
        readAnalysisArtifact(receipt) {
          assert.equal(receipt.contentSha256, persistedArtifact.contentSha256);
          return {
            content: persistedArtifact.content,
            contentSha256: persistedArtifact.contentSha256,
            sizeBytes: Buffer.byteLength(persistedArtifact.content, 'utf8'),
            mimeType: persistedArtifact.mimeType
          };
        }
      }
    : undefined;
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'workspace-archive-owner',
    idFactory: () => 'workspace-archive-session',
    clock,
    v1Runtime: runtime,
    executionLog,
    artifactRepository
  });
  return {
    service,
    calls,
    setElapsedDays(days, extraMilliseconds = 0) {
      now = START + days * DAY + extraMilliseconds;
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('auto-archives a completed logical Workspace after 30 inactive days without moving content', () => {
  const context = createService();
  try {
    const planned = context.service.start(request());
    const completed = context.service.confirmV1Execution(planned.sessionId, { confirmed: true });
    const originalUpdatedAt = context.service.getSession(planned.sessionId).updatedAt;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.workspace.status, 'active');

    context.setElapsedDays(30, 1);
    const summaries = context.service.listHistory();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, 'archived');
    assert.equal(summaries[0].workspaceStatus, 'archived');
    assert.equal(summaries[0].updatedAt, originalUpdatedAt);
    assert.deepEqual(context.service.lastWorkspaceArchive, {
      status: 'completed',
      archiveAfterInactiveDays: 30,
      archivedCount: 1,
      activeCount: 0,
      verifiedArchiveCount: 0,
      failedCount: 0
    });

    const history = context.service.getHistory(planned.sessionId);
    assert.equal(history.status, 'archived');
    assert.equal(history.v1.workspace.status, 'archived');
    assert.equal(history.v1.workspace.archiveReceipt.previousTaskStatus, 'completed');
    assert.equal(history.v1.workspace.archiveReceipt.artifactReference.artifactId, completed.v1.artifact.artifactId);
    assert.equal(history.v1.workspace.archiveReceipt.artifactReference.storage, null);
    assert.equal(history.v1.workspace.archiveReceipt.restorePolicy, 'explicit-new-task-only');
    assert.equal(history.v1.workspace.archiveReceipt.rawPathValuesAllowed, false);
    const serializedReceipt = JSON.stringify(history.v1.workspace.archiveReceipt);
    assert.equal(serializedReceipt.includes(completed.v1.artifact.content), false);
    assert.equal(serializedReceipt.includes('C:\\'), false);

    const logs = context.service.listV1ExecutionLogs();
    const archiveLog = logs.find((entry) => entry.operationType === 'workspace_archive');
    assert.equal(archiveLog.status, 'archived');
    assert.equal(archiveLog.workspaceId, history.v1.workspace.workspaceId);
    assert.equal(
      archiveLog.workspaceArchiveReceiptSha256,
      history.v1.workspace.archiveReceipt.receiptSha256
    );
    assert.equal(archiveLog.workspaceInactiveDays, 30);
    assert.equal(archiveLog.artifactReferenceCount, 1);
    assert.equal(archiveLog.executionAttempted, false);
    assert.equal(context.service.getV1ExecutionLogIntegrity().status, 'verified');
  } finally {
    context.cleanup();
  }
});

test('reads an archived Artifact only through the verified private Store receipt', async () => {
  const context = createService({ withArtifactRepository: true });
  try {
    const planned = context.service.start(request());
    const completed = await context.service.confirmV1Execution(planned.sessionId, {
      confirmed: true
    });
    context.setElapsedDays(31);
    context.service.listHistory();

    const downloaded = await context.service.readV1Artifact(
      planned.sessionId,
      completed.v1.artifact.artifactId
    );
    assert.equal(downloaded.status, 'verified');
    assert.equal(downloaded.workspaceStatus, 'archived');
    assert.equal(downloaded.readOnly, true);
    assert.equal(downloaded.artifact.content, completed.v1.artifact.content);
    assert.equal(downloaded.artifact.contentSha256, completed.v1.artifact.contentSha256);
    assert.equal('storage' in downloaded.artifact, false);

    await assert.rejects(
      context.service.readV1Artifact(planned.sessionId, 'artifact-not-owned'),
      (error) => error?.code === 'ARTIFACT_NOT_FOUND'
    );
  } finally {
    context.cleanup();
  }
});

test('archives an unconfirmed Workspace before confirmation and never calls the Provider', () => {
  const context = createService();
  try {
    const planned = context.service.start(request());
    context.setElapsedDays(31);

    const archived = context.service.confirmV1Execution(planned.sessionId, { confirmed: true });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.error.code, 'V1_WORKSPACE_ARCHIVED');
    assert.equal(archived.v1.workspace.archiveReceipt.previousTaskStatus, 'awaiting_confirmation');
    assert.equal(context.calls.filter(([operation]) => operation === 'execute').length, 0);
    assert.deepEqual(
      context.service.listV1ExecutionLogs().map((entry) => entry.operationType),
      ['workspace_archive', 'plan']
    );
  } finally {
    context.cleanup();
  }
});

test('does not archive at exactly 30 days and records confirmation as new activity', () => {
  const context = createService();
  try {
    const planned = context.service.start(request());
    context.setElapsedDays(30);

    const completed = context.service.confirmV1Execution(planned.sessionId, { confirmed: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.v1.workspace.status, 'active');
    assert.equal(completed.v1.workspace.lastActiveAt, new Date(START + 30 * DAY).toISOString());
    assert.equal(
      context.service.listV1ExecutionLogs().some(
        (entry) => entry.operationType === 'workspace_archive'
      ),
      false
    );
  } finally {
    context.cleanup();
  }
});

test('keeps 30-day archive separate from the existing 90-day physical session cleanup', () => {
  const context = createService();
  try {
    const planned = context.service.start(request());
    context.service.confirmV1Execution(planned.sessionId, { confirmed: true });

    context.setElapsedDays(31);
    assert.equal(context.service.listHistory()[0].status, 'archived');
    assert.equal(context.service.getSession(planned.sessionId).updatedAt, '2026-01-01T00:00:00.000Z');

    context.setElapsedDays(91);
    assert.deepEqual(context.service.listHistory(), []);
    assert.equal(context.service.getSession(planned.sessionId), null);
    assert.equal(context.service.lastCleanup.deletedCount, 1);
    assert.equal(context.service.lastWorkspaceArchive.verifiedArchiveCount, 1);
    assert.equal(
      context.service.listV1ExecutionLogs().filter(
        (entry) => entry.operationType === 'workspace_archive'
      ).length,
      1
    );
  } finally {
    context.cleanup();
  }
});

test('fails closed on archived reference drift instead of exposing modified Artifact content', () => {
  const context = createService();
  try {
    const planned = context.service.start(request());
    context.service.confirmV1Execution(planned.sessionId, { confirmed: true });
    context.setElapsedDays(31);
    context.service.listHistory();

    const stored = context.service.getSession(planned.sessionId);
    stored.v1.artifact.content = 'tampered private output';
    stored.v1.artifact.contentSha256 = 'f'.repeat(64);
    context.service.store.save(stored, 'workspace-archive-owner');

    const history = context.service.getHistory(planned.sessionId);
    assert.equal(history.status, 'failed');
    assert.equal(history.v1.workspace, null);
    assert.equal(history.v1.artifact, null);
    assert.equal(JSON.stringify(history).includes('tampered private output'), false);
    const failureLog = context.service
      .listV1ExecutionLogs()
      .find((entry) => entry.errorCode === 'QUERY_WORKSPACE_INVALID');
    assert.equal(failureLog.operationType, 'history');
    assert.equal(failureLog.status, 'failed');
  } finally {
    context.cleanup();
  }
});
