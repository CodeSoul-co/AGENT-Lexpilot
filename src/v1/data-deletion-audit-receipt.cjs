const DATA_DELETION_AUDIT_CONTRACT_VERSION = 'lexpilot.data-deletion-audit.v1';
const DATA_DELETION_AUDIT_SESSION_ID = 'privacy-data-deletion';

const DATA_DELETION_SCOPES = Object.freeze({
  SINGLE_SESSION: 'single_session',
  RETENTION: 'retention',
  OWNER_HISTORY: 'owner_history'
});

const DATA_DELETION_PHASES = Object.freeze({
  REQUESTED: 'requested',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

const OPERATION_TYPES = Object.freeze({
  [DATA_DELETION_SCOPES.SINGLE_SESSION]: Object.freeze({
    [DATA_DELETION_PHASES.REQUESTED]: 'session_deletion_requested',
    [DATA_DELETION_PHASES.COMPLETED]: 'session_deletion_completed',
    [DATA_DELETION_PHASES.FAILED]: 'session_deletion_failed'
  }),
  [DATA_DELETION_SCOPES.RETENTION]: Object.freeze({
    [DATA_DELETION_PHASES.REQUESTED]: 'session_retention_cleanup_requested',
    [DATA_DELETION_PHASES.COMPLETED]: 'session_retention_cleanup_completed',
    [DATA_DELETION_PHASES.FAILED]: 'session_retention_cleanup_failed'
  }),
  [DATA_DELETION_SCOPES.OWNER_HISTORY]: Object.freeze({
    [DATA_DELETION_PHASES.REQUESTED]: 'owner_history_erasure_requested',
    [DATA_DELETION_PHASES.COMPLETED]: 'owner_history_erasure_completed',
    [DATA_DELETION_PHASES.FAILED]: 'owner_history_erasure_failed'
  })
});

const STATUS_BY_PHASE = Object.freeze({
  [DATA_DELETION_PHASES.REQUESTED]: 'pending',
  [DATA_DELETION_PHASES.COMPLETED]: 'completed',
  [DATA_DELETION_PHASES.FAILED]: 'partial_failure'
});

function requireCount(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
}

function requireScope(value) {
  if (!Object.values(DATA_DELETION_SCOPES).includes(value)) {
    throw new TypeError('deletionScope must be a supported data deletion scope.');
  }
}

function requirePhase(value) {
  if (!Object.values(DATA_DELETION_PHASES).includes(value)) {
    throw new TypeError('deletionPhase must be requested, completed, or failed.');
  }
}

function createDataDeletionAuditEntry(input = {}) {
  const {
    operationId,
    scope,
    phase,
    targetSessionCount,
    targetArtifactCount,
    deletedSessionCount,
    deletedArtifactCount,
    deletionFailureCount,
    errorCode
  } = input;
  if (
    typeof operationId !== 'string' ||
    !/^lexpilot-deletion\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      operationId
    )
  ) {
    throw new TypeError('deletionOperationId must be a safe LexPilot deletion identifier.');
  }
  requireScope(scope);
  requirePhase(phase);
  for (const [fieldName, value] of Object.entries({
    targetSessionCount,
    targetArtifactCount,
    deletedSessionCount,
    deletedArtifactCount,
    deletionFailureCount
  })) {
    requireCount(value, fieldName);
  }
  if (deletedSessionCount > targetSessionCount) {
    throw new TypeError('deletedSessionCount must not exceed targetSessionCount.');
  }
  if (deletedArtifactCount > targetArtifactCount) {
    throw new TypeError('deletedArtifactCount must not exceed targetArtifactCount.');
  }
  if (phase === DATA_DELETION_PHASES.REQUESTED) {
    if (deletedSessionCount !== 0 || deletedArtifactCount !== 0 || deletionFailureCount !== 0) {
      throw new TypeError('requested deletion receipts must have zero outcome counts.');
    }
  }
  if (phase === DATA_DELETION_PHASES.COMPLETED && deletionFailureCount !== 0) {
    throw new TypeError('completed deletion receipts must have zero failures.');
  }
  if (phase === DATA_DELETION_PHASES.FAILED && deletionFailureCount === 0) {
    throw new TypeError('failed deletion receipts must include at least one failure.');
  }
  if (errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(errorCode)) {
    throw new TypeError('errorCode must be a safe structured error code.');
  }
  return Object.freeze({
    sessionId: DATA_DELETION_AUDIT_SESSION_ID,
    operationType: OPERATION_TYPES[scope][phase],
    status: STATUS_BY_PHASE[phase],
    deletionReceiptVersion: DATA_DELETION_AUDIT_CONTRACT_VERSION,
    deletionOperationId: operationId,
    deletionScope: scope,
    deletionPhase: phase,
    targetSessionCount,
    targetArtifactCount,
    deletedSessionCount,
    deletedArtifactCount,
    deletionFailureCount,
    auditRecordsRetained: true,
    ...(errorCode === undefined ? {} : { errorCode })
  });
}

function validateDataDeletionAuditRecord(record) {
  const deletionFields = [
    'deletionReceiptVersion',
    'deletionOperationId',
    'deletionScope',
    'deletionPhase',
    'deletedSessionCount',
    'deletedArtifactCount',
    'deletionFailureCount'
  ];
  if (!deletionFields.some((key) => record[key] !== undefined)) return;
  const expected = createDataDeletionAuditEntry({
    operationId: record.deletionOperationId,
    scope: record.deletionScope,
    phase: record.deletionPhase,
    targetSessionCount: record.targetSessionCount,
    targetArtifactCount: record.targetArtifactCount,
    deletedSessionCount: record.deletedSessionCount,
    deletedArtifactCount: record.deletedArtifactCount,
    deletionFailureCount: record.deletionFailureCount,
    errorCode: record.errorCode
  });
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw new TypeError(`entry.${key} does not match the data deletion audit contract.`);
    }
  }
}

function createDataDeletionAuditReceipt(record, entry, options = {}) {
  if (options.recoveryQueued !== undefined && typeof options.recoveryQueued !== 'boolean') {
    throw new TypeError('recoveryQueued must be a boolean when present.');
  }
  const base = {
    contractVersion: DATA_DELETION_AUDIT_CONTRACT_VERSION,
    operationId: entry.deletionOperationId,
    scope: entry.deletionScope,
    phase: entry.deletionPhase,
    status: entry.status
  };
  if (record === null) {
    return Object.freeze({
      ...base,
      recorded: false,
      recoveryQueued: options.recoveryQueued === true,
      logEntryRef: null
    });
  }
  validateDataDeletionAuditRecord(record);
  for (const [key, value] of Object.entries(entry)) {
    if (record[key] !== value) {
      throw new TypeError(`executionLog.append() returned a drifted ${key}.`);
    }
  }
  if (
    !Number.isSafeInteger(record.schemaVersion) ||
    record.schemaVersion < 1 ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.entryId !== 'string' ||
    record.entryId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(record.entryHash)
  ) {
    throw new TypeError('executionLog.append() must return an immutable hash-chain record.');
  }
  return Object.freeze({
    ...base,
    recorded: true,
    recoveryQueued: false,
    logEntryRef: Object.freeze({
      schemaVersion: record.schemaVersion,
      entryId: record.entryId,
      sequence: record.sequence,
      entryHash: `sha256:${record.entryHash}`
    })
  });
}

module.exports = {
  DATA_DELETION_AUDIT_CONTRACT_VERSION,
  DATA_DELETION_AUDIT_SESSION_ID,
  DATA_DELETION_PHASES,
  DATA_DELETION_SCOPES,
  createDataDeletionAuditEntry,
  createDataDeletionAuditReceipt,
  validateDataDeletionAuditRecord
};
