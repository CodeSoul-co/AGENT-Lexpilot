const { createHash } = require('node:crypto');
const {
  assertProfessionalQueryTaskReceipt
} = require('./professional-query-task-input.cjs');

const QUERY_WORKSPACE_ARCHIVE_DAYS = 30;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const QUERY_WORKSPACE_LIFECYCLE_SCHEMA = 'workspace-lifecycle.legal-query@1.0.0';
const QUERY_WORKSPACE_ARCHIVE_SCHEMA = 'workspace-archive.legal-query@1.0.0';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ID_PATTERN = /^query-workspace-[0-9a-f]{32}$/;
const LIFECYCLE_KEYS = Object.freeze([
  'schema',
  'workspaceId',
  'status',
  'createdAt',
  'lastActiveAt',
  'archiveAfterInactiveDays',
  'archivedAt',
  'archiveReceipt'
]);
const ARCHIVE_RECEIPT_KEYS = Object.freeze([
  'schema',
  'workspaceId',
  'previousTaskStatus',
  'archivedAt',
  'lastActiveAt',
  'inactiveDaysThreshold',
  'reason',
  'taskInputReceiptSha256',
  'artifactReference',
  'artifactReferenceSha256',
  'rawPathValuesAllowed',
  'restorePolicy',
  'receiptSha256'
]);

class QueryWorkspaceLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueryWorkspaceLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new QueryWorkspaceLifecycleError(code, message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('QUERY_WORKSPACE_TIMESTAMP_INVALID', `${label} is invalid.`);
  return milliseconds;
}

function requireExactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, 'Query Workspace lifecycle value is invalid.');
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(code, 'Query Workspace lifecycle contains undeclared fields.');
  }
  return value;
}

function normalizeArtifactReference(artifact) {
  if (artifact === null || artifact === undefined) return null;
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    typeof artifact.artifactId !== 'string' ||
    artifact.artifactId.length === 0 ||
    typeof artifact.type !== 'string' ||
    artifact.type.length === 0 ||
    typeof artifact.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(artifact.contentSha256)
  ) {
    fail('QUERY_WORKSPACE_ARTIFACT_INVALID', 'Artifact reference is invalid.');
  }
  const storage = artifact.storage;
  let storageReference = null;
  if (storage !== undefined && storage !== null) {
    if (
      typeof storage !== 'object' ||
      typeof storage.storeId !== 'string' ||
      storage.storeId.length === 0 ||
      typeof storage.objectKey !== 'string' ||
      !/^analysis\/[0-9a-f]{64}\.md$/.test(storage.objectKey) ||
      storage.contentSha256 !== artifact.contentSha256
    ) {
      fail('QUERY_WORKSPACE_ARTIFACT_INVALID', 'Artifact storage reference is invalid.');
    }
    storageReference = {
      storeId: storage.storeId,
      objectKey: storage.objectKey,
      contentSha256: storage.contentSha256,
      ...(typeof storage.versionId === 'string' ? { versionId: storage.versionId } : {}),
      ...(typeof storage.etag === 'string' ? { etag: storage.etag } : {})
    };
  }
  return deepFreeze({
    artifactId: artifact.artifactId,
    type: artifact.type,
    contentSha256: artifact.contentSha256,
    storage: storageReference
  });
}

function createQueryWorkspaceLifecycle({ taskInputReceipt, now } = {}) {
  assertProfessionalQueryTaskReceipt(taskInputReceipt);
  parseTimestamp(now, 'now');
  return deepFreeze({
    schema: QUERY_WORKSPACE_LIFECYCLE_SCHEMA,
    workspaceId: taskInputReceipt.workspaceId,
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    archiveAfterInactiveDays: QUERY_WORKSPACE_ARCHIVE_DAYS,
    archivedAt: null,
    archiveReceipt: null
  });
}

function assertQueryWorkspaceLifecycle(lifecycle) {
  const value = requireExactKeys(
    lifecycle,
    LIFECYCLE_KEYS,
    'QUERY_WORKSPACE_LIFECYCLE_INVALID'
  );
  const createdAt = parseTimestamp(value.createdAt, 'createdAt');
  const lastActiveAt = parseTimestamp(value.lastActiveAt, 'lastActiveAt');
  if (
    value.schema !== QUERY_WORKSPACE_LIFECYCLE_SCHEMA ||
    !WORKSPACE_ID_PATTERN.test(value.workspaceId ?? '') ||
    !['active', 'archived'].includes(value.status) ||
    value.archiveAfterInactiveDays !== QUERY_WORKSPACE_ARCHIVE_DAYS ||
    lastActiveAt < createdAt
  ) {
    fail('QUERY_WORKSPACE_LIFECYCLE_INVALID', 'Query Workspace lifecycle has drifted.');
  }
  if (value.status === 'active') {
    if (value.archivedAt !== null || value.archiveReceipt !== null) {
      fail('QUERY_WORKSPACE_LIFECYCLE_INVALID', 'Active Query Workspace cannot have an archive receipt.');
    }
  } else {
    const archivedAt = parseTimestamp(value.archivedAt, 'archivedAt');
    if (archivedAt <= lastActiveAt) {
      fail('QUERY_WORKSPACE_LIFECYCLE_INVALID', 'Archived Query Workspace timestamps are invalid.');
    }
    assertArchiveReceipt(value.archiveReceipt, value);
  }
  return value;
}

function touchQueryWorkspace(lifecycle, now) {
  const current = assertQueryWorkspaceLifecycle(lifecycle);
  const next = parseTimestamp(now, 'now');
  const previous = parseTimestamp(current.lastActiveAt, 'lastActiveAt');
  if (current.status !== 'active') {
    fail('QUERY_WORKSPACE_ARCHIVED', 'Archived Query Workspace cannot become active implicitly.');
  }
  if (next < previous) fail('QUERY_WORKSPACE_TIMESTAMP_INVALID', 'Workspace time cannot move backwards.');
  return deepFreeze({ ...current, lastActiveAt: now });
}

function buildArchiveReceipt({ lifecycle, taskInputReceipt, artifact, previousTaskStatus, now }) {
  assertProfessionalQueryTaskReceipt(taskInputReceipt);
  if (taskInputReceipt.workspaceId !== lifecycle.workspaceId) {
    fail('QUERY_WORKSPACE_BINDING_DRIFT', 'Task input and Query Workspace ids do not match.');
  }
  if (typeof previousTaskStatus !== 'string' || previousTaskStatus.length === 0) {
    fail('QUERY_WORKSPACE_STATUS_INVALID', 'Previous task status is invalid.');
  }
  const artifactReference = normalizeArtifactReference(artifact);
  const unsigned = {
    schema: QUERY_WORKSPACE_ARCHIVE_SCHEMA,
    workspaceId: lifecycle.workspaceId,
    previousTaskStatus,
    archivedAt: now,
    lastActiveAt: lifecycle.lastActiveAt,
    inactiveDaysThreshold: QUERY_WORKSPACE_ARCHIVE_DAYS,
    reason: 'inactive-over-30-days',
    taskInputReceiptSha256: canonicalSha256(taskInputReceipt),
    artifactReference,
    artifactReferenceSha256: canonicalSha256(artifactReference),
    rawPathValuesAllowed: false,
    restorePolicy: 'explicit-new-task-only'
  };
  return deepFreeze({ ...unsigned, receiptSha256: canonicalSha256(unsigned) });
}

function assertArchiveReceipt(receipt, lifecycle) {
  const value = requireExactKeys(
    receipt,
    ARCHIVE_RECEIPT_KEYS,
    'QUERY_WORKSPACE_ARCHIVE_INVALID'
  );
  const { receiptSha256, ...unsigned } = value;
  if (
    value.schema !== QUERY_WORKSPACE_ARCHIVE_SCHEMA ||
    value.workspaceId !== lifecycle.workspaceId ||
    value.archivedAt !== lifecycle.archivedAt ||
    value.lastActiveAt !== lifecycle.lastActiveAt ||
    value.inactiveDaysThreshold !== QUERY_WORKSPACE_ARCHIVE_DAYS ||
    value.reason !== 'inactive-over-30-days' ||
    !SHA256_PATTERN.test(value.taskInputReceiptSha256 ?? '') ||
    !SHA256_PATTERN.test(value.artifactReferenceSha256 ?? '') ||
    value.rawPathValuesAllowed !== false ||
    value.restorePolicy !== 'explicit-new-task-only' ||
    !SHA256_PATTERN.test(receiptSha256 ?? '') ||
    canonicalSha256(unsigned) !== receiptSha256 ||
    canonicalSha256(value.artifactReference) !== value.artifactReferenceSha256
  ) {
    fail('QUERY_WORKSPACE_ARCHIVE_INVALID', 'Query Workspace archive receipt has drifted.');
  }
  return value;
}

function archiveQueryWorkspaceIfInactive(options = {}) {
  const lifecycle = assertQueryWorkspaceLifecycle(options.lifecycle);
  if (lifecycle.status === 'archived') return lifecycle;
  const nowMilliseconds = parseTimestamp(options.now, 'now');
  const lastActiveMilliseconds = parseTimestamp(lifecycle.lastActiveAt, 'lastActiveAt');
  if (
    nowMilliseconds - lastActiveMilliseconds <=
    QUERY_WORKSPACE_ARCHIVE_DAYS * DAY_IN_MILLISECONDS
  ) {
    return lifecycle;
  }
  const archiveReceipt = buildArchiveReceipt({ ...options, lifecycle });
  return deepFreeze({
    ...lifecycle,
    status: 'archived',
    archivedAt: options.now,
    archiveReceipt
  });
}

function verifyQueryWorkspaceArchive({ lifecycle, taskInputReceipt, artifact } = {}) {
  const current = assertQueryWorkspaceLifecycle(lifecycle);
  if (current.status !== 'archived') {
    fail('QUERY_WORKSPACE_NOT_ARCHIVED', 'Query Workspace is not archived.');
  }
  assertProfessionalQueryTaskReceipt(taskInputReceipt);
  const artifactReference = normalizeArtifactReference(artifact);
  if (
    current.workspaceId !== taskInputReceipt.workspaceId ||
    canonicalSha256(taskInputReceipt) !==
      current.archiveReceipt.taskInputReceiptSha256 ||
    canonicalSha256(artifactReference) !==
      current.archiveReceipt.artifactReferenceSha256
  ) {
    fail('QUERY_WORKSPACE_ARCHIVE_DRIFT', 'Archived Query Workspace references have drifted.');
  }
  return deepFreeze({
    status: 'verified',
    workspaceId: current.workspaceId,
    receiptSha256: current.archiveReceipt.receiptSha256
  });
}

module.exports = {
  QUERY_WORKSPACE_ARCHIVE_DAYS,
  QUERY_WORKSPACE_ARCHIVE_SCHEMA,
  QUERY_WORKSPACE_LIFECYCLE_SCHEMA,
  QueryWorkspaceLifecycleError,
  archiveQueryWorkspaceIfInactive,
  assertQueryWorkspaceLifecycle,
  createQueryWorkspaceLifecycle,
  touchQueryWorkspace,
  verifyQueryWorkspaceArchive
};
