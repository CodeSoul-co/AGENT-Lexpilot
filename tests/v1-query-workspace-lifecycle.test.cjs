const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProfessionalQueryTaskInput,
  createProfessionalQueryTaskReceipt
} = require('../src/v1/professional-query-task-input.cjs');
const {
  QUERY_WORKSPACE_ARCHIVE_DAYS,
  QueryWorkspaceLifecycleError,
  archiveQueryWorkspaceIfInactive,
  createQueryWorkspaceLifecycle,
  touchQueryWorkspace,
  verifyQueryWorkspaceArchive
} = require('../src/v1/query-workspace-lifecycle.cjs');

const DAY = 24 * 60 * 60 * 1000;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function isoAfter(milliseconds) {
  return new Date(Date.parse(CREATED_AT) + milliseconds).toISOString();
}

function taskReceipt() {
  return createProfessionalQueryTaskReceipt(
    createProfessionalQueryTaskInput({
      piiRedacted: true,
      query: '统计近三年未签劳动合同案件数量和胜诉率。',
      sessionId: 'workspace-lifecycle-session',
      dataSourceId: 'demo.labor_cases'
    })
  );
}

function artifact() {
  const contentSha256 = 'a'.repeat(64);
  return {
    artifactId: 'artifact-workspace-lifecycle',
    type: 'analysis-document',
    fileName: '分析.md',
    content: 'private analysis content must not enter the archive receipt',
    contentSha256,
    storage: {
      storeId: 'lexpilot.execution-artifacts.local',
      objectKey: `analysis/${'b'.repeat(64)}.md`,
      contentSha256,
      versionId: 'version-safe',
      etag: 'etag-safe',
      rootPath: 'C:\\private\\artifacts'
    }
  };
}

test('creates an active logical Query Workspace without filesystem semantics', () => {
  const receipt = taskReceipt();
  const lifecycle = createQueryWorkspaceLifecycle({ taskInputReceipt: receipt, now: CREATED_AT });

  assert.equal(lifecycle.status, 'active');
  assert.equal(lifecycle.workspaceId, receipt.workspaceId);
  assert.equal(lifecycle.archiveAfterInactiveDays, QUERY_WORKSPACE_ARCHIVE_DAYS);
  assert.equal(lifecycle.lastActiveAt, CREATED_AT);
  assert.equal(lifecycle.archiveReceipt, null);
  assert.equal(JSON.stringify(lifecycle).includes('private'), false);
  assert.equal(Object.isFrozen(lifecycle), true);
});

test('archives strictly after 30 inactive days and freezes safe task and Artifact references', () => {
  const receipt = taskReceipt();
  const lifecycle = createQueryWorkspaceLifecycle({ taskInputReceipt: receipt, now: CREATED_AT });
  const exactlyThirtyDays = archiveQueryWorkspaceIfInactive({
    lifecycle,
    taskInputReceipt: receipt,
    artifact: artifact(),
    previousTaskStatus: 'completed',
    now: isoAfter(30 * DAY)
  });
  assert.equal(exactlyThirtyDays.status, 'active');

  const archived = archiveQueryWorkspaceIfInactive({
    lifecycle,
    taskInputReceipt: receipt,
    artifact: artifact(),
    previousTaskStatus: 'completed',
    now: isoAfter(30 * DAY + 1)
  });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.archiveReceipt.reason, 'inactive-over-30-days');
  assert.equal(archived.archiveReceipt.previousTaskStatus, 'completed');
  assert.equal(archived.archiveReceipt.rawPathValuesAllowed, false);
  assert.equal(archived.archiveReceipt.restorePolicy, 'explicit-new-task-only');
  assert.match(archived.archiveReceipt.receiptSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(archived.archiveReceipt.artifactReference.artifactId, 'artifact-workspace-lifecycle');
  const serialized = JSON.stringify(archived.archiveReceipt);
  assert.equal(serialized.includes('private analysis content'), false);
  assert.equal(serialized.includes('C:\\private'), false);
  assert.deepEqual(
    verifyQueryWorkspaceArchive({
      lifecycle: archived,
      taskInputReceipt: receipt,
      artifact: artifact()
    }),
    {
      status: 'verified',
      workspaceId: receipt.workspaceId,
      receiptSha256: archived.archiveReceipt.receiptSha256
    }
  );
});

test('touching activity resets the inactivity clock but never restores an archive implicitly', () => {
  const receipt = taskReceipt();
  const lifecycle = createQueryWorkspaceLifecycle({ taskInputReceipt: receipt, now: CREATED_AT });
  const touched = touchQueryWorkspace(lifecycle, isoAfter(20 * DAY));
  const stillActive = archiveQueryWorkspaceIfInactive({
    lifecycle: touched,
    taskInputReceipt: receipt,
    artifact: null,
    previousTaskStatus: 'awaiting_confirmation',
    now: isoAfter(40 * DAY)
  });
  assert.equal(stillActive.status, 'active');

  const archived = archiveQueryWorkspaceIfInactive({
    lifecycle: touched,
    taskInputReceipt: receipt,
    artifact: null,
    previousTaskStatus: 'awaiting_confirmation',
    now: isoAfter(51 * DAY)
  });
  assert.throws(
    () => touchQueryWorkspace(archived, isoAfter(52 * DAY)),
    (error) =>
      error instanceof QueryWorkspaceLifecycleError &&
      error.code === 'QUERY_WORKSPACE_ARCHIVED'
  );
});

test('detects TaskSchema, Artifact, and archive-receipt drift', () => {
  const receipt = taskReceipt();
  const lifecycle = createQueryWorkspaceLifecycle({ taskInputReceipt: receipt, now: CREATED_AT });
  const archived = archiveQueryWorkspaceIfInactive({
    lifecycle,
    taskInputReceipt: receipt,
    artifact: artifact(),
    previousTaskStatus: 'completed',
    now: isoAfter(31 * DAY)
  });
  assert.throws(
    () =>
      verifyQueryWorkspaceArchive({
        lifecycle: archived,
        taskInputReceipt: { ...receipt, requestedOutputFormats: ['table'] },
        artifact: artifact()
      }),
    (error) => error.code === 'QUERY_WORKSPACE_ARCHIVE_DRIFT'
  );
  assert.throws(
    () =>
      verifyQueryWorkspaceArchive({
        lifecycle: archived,
        taskInputReceipt: receipt,
        artifact: { ...artifact(), contentSha256: 'c'.repeat(64), storage: null }
      }),
    (error) => error.code === 'QUERY_WORKSPACE_ARCHIVE_DRIFT'
  );
  assert.throws(
    () =>
      verifyQueryWorkspaceArchive({
        lifecycle: {
          ...archived,
          archiveReceipt: {
            ...archived.archiveReceipt,
            restorePolicy: 'automatic'
          }
        },
        taskInputReceipt: receipt,
        artifact: artifact()
      }),
    (error) => error.code === 'QUERY_WORKSPACE_ARCHIVE_INVALID'
  );
});
