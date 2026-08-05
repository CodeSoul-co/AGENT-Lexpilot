const { randomUUID } = require('node:crypto');
const { createAuditActorId, requireAuditActorId } = require('../v1/audit-identity.cjs');
const {
  DATA_DELETION_PHASES,
  DATA_DELETION_SCOPES,
  createDataDeletionAuditEntry,
  createDataDeletionAuditReceipt
} = require('../v1/data-deletion-audit-receipt.cjs');
const {
  createProfessionalQueryTaskInput,
  createProfessionalQueryTaskReceipt,
  restoreProfessionalQueryTaskInput
} = require('../v1/professional-query-task-input.cjs');
const {
  QUERY_WORKSPACE_ARCHIVE_DAYS,
  archiveQueryWorkspaceIfInactive,
  assertQueryWorkspaceLifecycle,
  createQueryWorkspaceLifecycle,
  touchQueryWorkspace,
  verifyQueryWorkspaceArchive
} = require('../v1/query-workspace-lifecycle.cjs');
const {
  assertCapabilityReferenceSnapshot,
  capabilitySnapshotRef,
  createCapabilityBoundSessionStore
} = require('../v1/capability-reference-snapshot.cjs');
const {
  V0_DOMAIN_PACK_VERSION,
  V0_ERROR_CODES,
  PRIVACY_AUTHORIZATION_STATUS,
  PRIVACY_POLICY_VERSION
} = require('./contracts.cjs');
const { prepareLegalSelfCheckInput } = require('./privacy-gateway.cjs');
const { analyzeInformationReadiness } = require('./clarification-planner.cjs');
const { LocalVerifiedLawRetriever } = require('./law-retriever.cjs');
const { COMPARISON_METHOD, compareFactsToLaw } = require('./law-comparison-engine.cjs');
const {
  RESULT_CARD_DISCLAIMER,
  RESULT_CARD_FINDING_LABEL,
  buildLegalResultCards
} = require('./legal-result-card-builder.cjs');
const {
  LAW_REFERENCE_DISCLAIMER,
  planLawRetrieval
} = require('./law-reference-planner.cjs');
const {
  SESSION_RETENTION_DAYS,
  calculateInactiveBefore
} = require('./retention-policy.cjs');
const { InMemoryLegalSessionStore } = require('./session-store.cjs');

// Long-running processes re-run the retention sweep at most once per day
// on session entry points (startup sweep still runs in the constructor).
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OWNER_HISTORY_ERASURE_PHRASE = 'DELETE MY HISTORY';
const {
  TASK_TYPES,
  TASK_TYPE_LABELS,
  TASK_TYPE_CLASSIFICATION_METHOD,
  classifyBusinessTask
} = require('./task-type-classifier.cjs');

const TERMINAL_STATUSES = new Set([
  'completed',
  'professional_query_identified',
  'information_ready',
  'unsupported_domain',
  'clarification_limit_reached',
  'failed',
  'awaiting_confirmation',
  'cancelled',
  'rejected',
  'archived'
]);

function safeEvent(type, data) {
  return { type, data };
}

function isGovernedArtifactReceipt(receipt, expectedContentSha256, expectedBindingRef = null) {
  const bindingRef = receipt?.artifactOutputBindingRef ?? null;
  return (
    receipt !== null &&
    typeof receipt === 'object' &&
    typeof receipt.storeId === 'string' &&
    receipt.storeId.length > 0 &&
    typeof receipt.objectKey === 'string' &&
    /^analysis\/[0-9a-f]{64}\.md$/.test(receipt.objectKey) &&
    receipt.contentSha256 === expectedContentSha256 &&
    ((expectedBindingRef === null && bindingRef === null) ||
      (expectedBindingRef !== null &&
        bindingRef?.id === expectedBindingRef.id &&
        bindingRef?.version === expectedBindingRef.version &&
        bindingRef?.manifestCanonicalSha256 === expectedBindingRef.manifestCanonicalSha256))
  );
}

function publicPrivacyAuthorization(session) {
  const authorization = session?.privacyAuthorization;
  const valid =
    authorization?.status === PRIVACY_AUTHORIZATION_STATUS.GRANTED &&
    typeof authorization.policyVersion === 'string' &&
    authorization.policyVersion.length > 0 &&
    typeof authorization.recordedAt === 'string';
  return valid
    ? {
        authorizationStatus: authorization.status,
        privacyPolicyVersion: authorization.policyVersion,
        authorizationRecordedAt: authorization.recordedAt
      }
    : { authorizationStatus: PRIVACY_AUTHORIZATION_STATUS.NOT_RECORDED };
}

function publicResult(session) {
  return {
    sessionId: session.id,
    status: session.status,
    ...publicPrivacyAuthorization(session),
    domainPackVersion: V0_DOMAIN_PACK_VERSION,
    piiRedacted: true,
    taskType: session.taskType,
    taskTypeLabel: session.taskTypeLabel,
    taskTypeRecognition: session.taskTypeRecognition,
    legalDomain: session.legalDomain,
    legalDomainLabel: session.legalDomainLabel,
    knownFacts: session.knownFacts,
    missingFields: session.missingFields,
    questions: session.questions,
    lawRetrievalStatus: session.lawRetrievalStatus ?? 'not_run',
    lawReferences: session.lawReferences ?? [],
    lawCorpus: session.lawCorpus,
    lawReferenceDisclaimer:
      session.taskType === TASK_TYPES.LEGAL_SELF_CHECK ? LAW_REFERENCE_DISCLAIMER : undefined,
    legalConclusionGenerated: false,
    lawRetrievalError: session.lawRetrievalError,
    lawComparisonStatus: session.lawComparisonStatus ?? 'not_run',
    lawComparisons: session.lawComparisons ?? [],
    lawComparisonError: session.lawComparisonError,
    resultCardStatus: session.resultCardStatus ?? 'not_run',
    resultCards: session.resultCards ?? [],
    disclaimer:
      session.taskType === TASK_TYPES.LEGAL_SELF_CHECK ? RESULT_CARD_DISCLAIMER : undefined,
    resultCardError: session.resultCardError,
    clarificationRound: session.clarificationRound,
    error: session.error,
    trace: session.latestTrace
  };
}

function historySummary(session) {
  return {
    sessionId: session.id,
    status: session.status,
    taskType: session.taskType,
    taskTypeLabel: session.taskTypeLabel,
    legalDomain: session.legalDomain,
    legalDomainLabel: session.legalDomainLabel,
    clarificationRound: session.clarificationRound,
    messageCount: session.messages.length,
    lawRetrievalStatus: session.lawRetrievalStatus ?? 'not_run',
    lawReferenceCount: session.lawReferences?.length ?? 0,
    lawComparisonStatus: session.lawComparisonStatus ?? 'not_run',
    lawComparisonCount: session.lawComparisons?.length ?? 0,
    resultCardStatus: session.resultCardStatus ?? 'not_run',
    resultCardCount: session.resultCards?.length ?? 0,
    ...publicPrivacyAuthorization(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workspaceStatus:
      session.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY
        ? session.v1?.workspace?.status
        : undefined
  };
}

function historyDetail(session) {
  return {
    ...historySummary(session),
    domainPackVersion: session.domainPackVersion,
    taskTypeRecognition: session.taskTypeRecognition,
    knownFacts: session.knownFacts,
    missingFields: session.missingFields,
    questions: session.questions,
    lawReferences: session.lawReferences ?? [],
    lawCorpus: session.lawCorpus,
    lawReferenceDisclaimer:
      session.taskType === TASK_TYPES.LEGAL_SELF_CHECK ? LAW_REFERENCE_DISCLAIMER : undefined,
    legalConclusionGenerated: false,
    lawRetrievalError: session.lawRetrievalError,
    lawComparisonStatus: session.lawComparisonStatus ?? 'not_run',
    lawComparisons: session.lawComparisons ?? [],
    lawComparisonError: session.lawComparisonError,
    resultCards: session.resultCards ?? [],
    disclaimer:
      session.taskType === TASK_TYPES.LEGAL_SELF_CHECK ? RESULT_CARD_DISCLAIMER : undefined,
    resultCardError: session.resultCardError,
    error: session.error,
    v1: session.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY ? session.v1 : undefined,
    messages: session.messages.map((message) => ({
      role: message.role,
      redactedText: message.redactedText,
      receivedAt: message.receivedAt
    }))
  };
}

class LegalSelfCheckConversationService {
  constructor(options = {}) {
    const baseStore = options.store ?? new InMemoryLegalSessionStore();
    this.capabilitySnapshot = options.capabilitySnapshot
      ? assertCapabilityReferenceSnapshot(options.capabilitySnapshot)
      : null;
    this.store = this.capabilitySnapshot
      ? createCapabilityBoundSessionStore(baseStore, this.capabilitySnapshot)
      : baseStore;
    this.taskClassifier = options.taskClassifier ?? classifyBusinessTask;
    if (typeof this.taskClassifier !== 'function') {
      throw new TypeError('taskClassifier must be a function.');
    }
    this.lawRetriever = options.lawRetriever ?? new LocalVerifiedLawRetriever();
    if (!this.lawRetriever || typeof this.lawRetriever.search !== 'function') {
      throw new TypeError('lawRetriever must provide a search function.');
    }
    this.lawComparator = options.lawComparator ?? compareFactsToLaw;
    if (typeof this.lawComparator !== 'function') {
      throw new TypeError('lawComparator must be a function.');
    }
    this.resultCardBuilder = options.resultCardBuilder ?? buildLegalResultCards;
    if (typeof this.resultCardBuilder !== 'function') {
      throw new TypeError('resultCardBuilder must be a function.');
    }
    this.ownerId = options.ownerId ?? 'local-user';
    if (typeof this.ownerId !== 'string' || this.ownerId.trim().length === 0) {
      throw new TypeError('ownerId must be a non-empty string.');
    }
    this.auditActorId = requireAuditActorId(
      options.auditActorId ?? createAuditActorId(this.ownerId)
    );
    this.idFactory = options.idFactory ?? randomUUID;
    this.deletionAuditIdFactory =
      options.deletionAuditIdFactory ?? (() => `lexpilot-deletion.${randomUUID()}`);
    if (typeof this.deletionAuditIdFactory !== 'function') {
      throw new TypeError('deletionAuditIdFactory must be a function.');
    }
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.retentionDays = options.retentionDays ?? SESSION_RETENTION_DAYS;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1) {
      throw new TypeError('retentionDays must be a positive integer.');
    }
    this.autoCleanup = options.autoCleanup ?? true;
    if (typeof this.autoCleanup !== 'boolean') {
      throw new TypeError('autoCleanup must be a boolean.');
    }
    this.v1Runtime = options.v1Runtime ?? null;
    if (
      this.v1Runtime !== null &&
      (typeof this.v1Runtime.plan !== 'function' ||
        typeof this.v1Runtime.execute !== 'function' ||
        typeof this.v1Runtime.describe !== 'function')
    ) {
      throw new TypeError('v1Runtime must expose describe(), plan(input), and execute(input).');
    }
    this.executionLog = options.executionLog ?? null;
    this.deletionAuditRecoveryStore = options.deletionAuditRecoveryStore ?? null;
    this.artifactRepository = options.artifactRepository ?? null;
    this.retentionCleanupPromise = null;
    this.artifactOutputBindingRef = this.artifactRepository?.describe?.().artifactOutputBindingRef ?? null;
    if (
      this.executionLog !== null &&
      (typeof this.executionLog.append !== 'function' ||
        typeof this.executionLog.list !== 'function' ||
        typeof this.executionLog.verifyIntegrity !== 'function')
    ) {
      throw new TypeError(
        'executionLog must expose append(entry), list(filter), and verifyIntegrity().'
      );
    }
    if (this.v1Runtime !== null && this.executionLog === null) {
      throw new TypeError('V1 runtime requires an append-only executionLog.');
    }
    if (
      this.deletionAuditRecoveryStore !== null &&
      (typeof this.deletionAuditRecoveryStore.enqueue !== 'function' ||
        typeof this.deletionAuditRecoveryStore.list !== 'function' ||
        typeof this.deletionAuditRecoveryStore.remove !== 'function')
    ) {
      throw new TypeError(
        'deletionAuditRecoveryStore must expose enqueue(input), list(), and remove(operationId).'
      );
    }
    if (
      this.deletionAuditRecoveryStore !== null &&
      (!this.executionLog || typeof this.executionLog.findDeletionAuditRecord !== 'function')
    ) {
      throw new TypeError(
        'deletion audit recovery requires executionLog.findDeletionAuditRecord(input).'
      );
    }
    if (
      this.artifactRepository !== null &&
      typeof this.artifactRepository.storeAnalysisArtifact !== 'function'
    ) {
      throw new TypeError('artifactRepository must expose storeAnalysisArtifact(input).');
    }
    this.lastDeletionAuditReconciliation = this.reconcilePendingDataDeletionAudits();
    this.lastWorkspaceArchive = this.autoCleanup
      ? this.archiveInactiveQueryWorkspaces()
      : null;
    this.lastCleanup = this.autoCleanup ? this.cleanupInactiveSessions() : null;
    this.lastCleanupAt = this.autoCleanup ? this.clock() : null;
  }

  describeCapabilityBinding() {
    return this.capabilitySnapshot ? capabilitySnapshotRef(this.capabilitySnapshot) : null;
  }

  recordDataDeletionAudit(input) {
    const entry = createDataDeletionAuditEntry(input);
    if (!this.executionLog) return createDataDeletionAuditReceipt(null, entry);
    try {
      const record = this.executionLog.append({ actorId: this.auditActorId, ...entry });
      return createDataDeletionAuditReceipt(record, entry);
    } catch (cause) {
      if (
        entry.deletionPhase === DATA_DELETION_PHASES.REQUESTED ||
        !this.deletionAuditRecoveryStore
      ) {
        throw cause;
      }
      try {
        this.deletionAuditRecoveryStore.enqueue({ actorId: this.auditActorId, entry });
      } catch (recoveryCause) {
        const error = new Error(
          '删除结果既未写入不可变日志，也未能进入本地恢复队列。',
          { cause: recoveryCause }
        );
        error.code = 'DATA_DELETION_AUDIT_RECOVERY_FAILED';
        throw error;
      }
      return createDataDeletionAuditReceipt(null, entry, { recoveryQueued: true });
    }
  }

  reconcilePendingDataDeletionAudits() {
    if (!this.deletionAuditRecoveryStore) {
      return Object.freeze({
        status: 'disabled',
        pendingCount: 0,
        appendedCount: 0,
        alreadyRecordedCount: 0,
        remainingCount: 0
      });
    }
    let pending;
    try {
      pending = this.deletionAuditRecoveryStore.list();
      let appendedCount = 0;
      let alreadyRecordedCount = 0;
      for (const recovery of pending) {
        const entry = recovery.entry;
        const existing = this.executionLog.findDeletionAuditRecord({
          operationId: entry.deletionOperationId,
          phase: entry.deletionPhase
        });
        if (existing) {
          createDataDeletionAuditReceipt(existing, entry);
          alreadyRecordedCount += 1;
        } else {
          const record = this.executionLog.append({ actorId: recovery.actorId, ...entry });
          createDataDeletionAuditReceipt(record, entry);
          appendedCount += 1;
        }
        this.deletionAuditRecoveryStore.remove(entry.deletionOperationId);
      }
      return Object.freeze({
        status: 'completed',
        pendingCount: pending.length,
        appendedCount,
        alreadyRecordedCount,
        remainingCount: 0
      });
    } catch (cause) {
      const error = new Error('删除审计恢复队列对账失败，已停止继续处理。', { cause });
      error.code = 'DATA_DELETION_AUDIT_RECONCILIATION_FAILED';
      throw error;
    }
  }

  maybeCleanupInactiveSessions() {
    if (!this.autoCleanup) return;
    const now = Date.parse(this.clock());
    if (
      this.lastCleanupAt &&
      Number.isFinite(now) &&
      now - Date.parse(this.lastCleanupAt) < CLEANUP_INTERVAL_MS
    ) {
      return;
    }
    this.lastWorkspaceArchive = this.archiveInactiveQueryWorkspaces();
    this.lastCleanup = this.cleanupInactiveSessions();
    this.lastCleanupAt = this.clock();
  }

  async maybeCleanupInactiveSessionsAsync() {
    if (!this.autoCleanup) return this.lastCleanup;
    const now = Date.parse(this.clock());
    if (
      this.lastCleanupAt &&
      Number.isFinite(now) &&
      now - Date.parse(this.lastCleanupAt) < CLEANUP_INTERVAL_MS
    ) {
      return this.retentionCleanupPromise ?? this.lastCleanup;
    }
    return this.cleanupInactiveSessionsWithArtifacts();
  }

  recognizeTask(redactedText) {
    try {
      const classified = this.taskClassifier({ piiRedacted: true, redactedText });
      const allowedKeys = new Set([
        'status',
        'taskType',
        'taskTypeLabel',
        'confidence',
        'matchedSignals',
        'classificationMethod',
        'trace'
      ]);
      const validTaskType = Object.values(TASK_TYPES).includes(classified?.taskType);
      const validSignals =
        Array.isArray(classified?.matchedSignals) &&
        classified.matchedSignals.length <= 10 &&
        classified.matchedSignals.every(
          (signal) => typeof signal === 'string' && /^[a-z0-9_]+$/.test(signal)
        ) &&
        new Set(classified.matchedSignals).size === classified.matchedSignals.length;
      const valid =
        classified?.status === 'classified' &&
        validTaskType &&
        classified.taskTypeLabel === TASK_TYPE_LABELS[classified.taskType] &&
        ['conservative_default', 'medium', 'high'].includes(classified.confidence) &&
        validSignals &&
        classified.classificationMethod === TASK_TYPE_CLASSIFICATION_METHOD &&
        Object.keys(classified).length === allowedKeys.size &&
        Object.keys(classified).every((key) => allowedKeys.has(key));
      if (!valid) {
        throw new Error('Invalid task classification output.');
      }
      return {
        status: classified.status,
        taskType: classified.taskType,
        taskTypeLabel: classified.taskTypeLabel,
        confidence: classified.confidence,
        matchedSignals: [...classified.matchedSignals],
        classificationMethod: classified.classificationMethod,
        trace: [
          safeEvent('business.task-type.classified', {
            taskType: classified.taskType,
            matchedSignalCount: classified.matchedSignals.length,
            classificationMethod: classified.classificationMethod
          })
        ]
      };
    } catch {
      return {
        status: 'failed',
        error: {
          code: V0_ERROR_CODES.TASK_TYPE_CLASSIFICATION_FAILED,
          message: '任务类型识别失败，未进入法律分析或数据查询流程。'
        },
        trace: [
          safeEvent('business.task-type.failed', {
            code: V0_ERROR_CODES.TASK_TYPE_CLASSIFICATION_FAILED
          })
        ]
      };
    }
  }

  cleanupInactiveSessions() {
    const inactiveBefore = calculateInactiveBefore(this.clock(), this.retentionDays);
    if (typeof this.store.scanInactive !== 'function') {
      const legacy = this.store.purgeInactive(inactiveBefore);
      const status = legacy.failedCount === 0 ? 'completed' : 'partial_failure';
      const targetSessionCount = legacy.deletedCount + legacy.failedCount;
      let deletionAudit = null;
      if (targetSessionCount > 0) {
        const deletionOperationId = this.deletionAuditIdFactory();
        this.recordDataDeletionAudit({
          operationId: deletionOperationId,
          scope: DATA_DELETION_SCOPES.RETENTION,
          phase: DATA_DELETION_PHASES.REQUESTED,
          targetSessionCount,
          targetArtifactCount: 0,
          deletedSessionCount: 0,
          deletedArtifactCount: 0,
          deletionFailureCount: 0
        });
        deletionAudit = this.recordDataDeletionAudit({
          operationId: deletionOperationId,
          scope: DATA_DELETION_SCOPES.RETENTION,
          phase:
            status === 'completed'
              ? DATA_DELETION_PHASES.COMPLETED
              : DATA_DELETION_PHASES.FAILED,
          targetSessionCount,
          targetArtifactCount: 0,
          deletedSessionCount: legacy.deletedCount,
          deletedArtifactCount: 0,
          deletionFailureCount: legacy.failedCount,
          ...(status === 'completed' ? {} : { errorCode: 'SESSION_RETENTION_CLEANUP_FAILED' })
        });
      }
      return {
        status,
        retentionDays: this.retentionDays,
        inactiveBefore,
        deletedCount: legacy.deletedCount,
        artifactDeletedCount: 0,
        artifactPendingCount: 0,
        failedCount: legacy.failedCount,
        deletionAudit,
        trace: [
          safeEvent('v0.session.retention.cleaned', {
            status,
            retentionDays: this.retentionDays,
            deletedCount: legacy.deletedCount,
            artifactDeletedCount: 0,
            artifactPendingCount: 0,
            failedCount: legacy.failedCount
          })
        ]
      };
    }
    const scanned = this.store.scanInactive(inactiveBefore);
    const targetArtifactCount = new Set(
      scanned.sessions
        .map((session) => session?.v1?.artifact?.storage)
        .filter(Boolean)
        .map((receipt) => `${receipt.storeId}\0${receipt.objectKey}`)
    ).size;
    const shouldAudit = scanned.sessions.length > 0 || scanned.failedCount > 0;
    const deletionOperationId = shouldAudit ? this.deletionAuditIdFactory() : null;
    if (shouldAudit) {
      this.recordDataDeletionAudit({
        operationId: deletionOperationId,
        scope: DATA_DELETION_SCOPES.RETENTION,
        phase: DATA_DELETION_PHASES.REQUESTED,
        targetSessionCount: scanned.sessions.length,
        targetArtifactCount,
        deletedSessionCount: 0,
        deletedArtifactCount: 0,
        deletionFailureCount: 0
      });
    }
    let deletedCount = 0;
    let artifactPendingCount = 0;
    let failedCount = scanned.failedCount;
    for (const session of scanned.sessions) {
      if (session?.v1?.artifact?.storage) {
        artifactPendingCount += 1;
        failedCount += 1;
        continue;
      }
      try {
        if (!this.store.delete(session.id, session.ownerId)) throw new Error('Session disappeared.');
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    const status = failedCount === 0 ? 'completed' : 'partial_failure';
    const deletionAudit = shouldAudit
      ? this.recordDataDeletionAudit({
          operationId: deletionOperationId,
          scope: DATA_DELETION_SCOPES.RETENTION,
          phase:
            status === 'completed'
              ? DATA_DELETION_PHASES.COMPLETED
              : DATA_DELETION_PHASES.FAILED,
          targetSessionCount: scanned.sessions.length,
          targetArtifactCount,
          deletedSessionCount: deletedCount,
          deletedArtifactCount: 0,
          deletionFailureCount: failedCount,
          ...(status === 'completed'
            ? {}
            : { errorCode: 'SESSION_RETENTION_CLEANUP_FAILED' })
        })
      : null;
    return {
      status,
      retentionDays: this.retentionDays,
      inactiveBefore,
      deletedCount,
      artifactDeletedCount: 0,
      artifactPendingCount,
      failedCount,
      deletionAudit,
      trace: [
        safeEvent('v0.session.retention.cleaned', {
          status,
          retentionDays: this.retentionDays,
          deletedCount,
          artifactDeletedCount: 0,
          artifactPendingCount,
          failedCount
        })
      ]
    };
  }

  cleanupInactiveSessionsWithArtifacts() {
    if (this.retentionCleanupPromise) return this.retentionCleanupPromise;
    this.retentionCleanupPromise = (async () => {
      const inactiveBefore = calculateInactiveBefore(this.clock(), this.retentionDays);
      if (typeof this.store.scanInactive !== 'function') {
        const result = this.cleanupInactiveSessions();
        this.lastCleanup = result;
        this.lastCleanupAt = this.clock();
        return result;
      }
      const scanned = this.store.scanInactive(inactiveBefore);
      const artifacts = new Map();
      const artifactKeyBySessionId = new Map();
      for (const session of scanned.sessions) {
        const receipt = session?.v1?.artifact?.storage;
        if (!receipt) continue;
        const key = `${receipt.storeId}\0${receipt.objectKey}`;
        artifacts.set(key, receipt);
        artifactKeyBySessionId.set(session.id, key);
      }

      const shouldAudit = scanned.sessions.length > 0 || scanned.failedCount > 0;
      const deletionOperationId = shouldAudit ? this.deletionAuditIdFactory() : null;
      if (shouldAudit) {
        this.recordDataDeletionAudit({
          operationId: deletionOperationId,
          scope: DATA_DELETION_SCOPES.RETENTION,
          phase: DATA_DELETION_PHASES.REQUESTED,
          targetSessionCount: scanned.sessions.length,
          targetArtifactCount: artifacts.size,
          deletedSessionCount: 0,
          deletedArtifactCount: 0,
          deletionFailureCount: 0
        });
      }

      const deletedArtifactKeys = new Set();
      let artifactDeletedCount = 0;
      let artifactFailedCount = 0;
      const deletionAvailable =
        this.artifactRepository &&
        typeof this.artifactRepository.readAnalysisArtifact === 'function' &&
        typeof this.artifactRepository.deleteAnalysisArtifact === 'function';
      for (const [key, receipt] of artifacts) {
        try {
          if (!deletionAvailable) throw new Error('Artifact deletion is unavailable.');
          await this.artifactRepository.readAnalysisArtifact(receipt);
          const deletion = await this.artifactRepository.deleteAnalysisArtifact(receipt);
          if (!['deleted', 'already_absent'].includes(deletion?.status)) {
            throw new Error('Artifact deletion receipt is invalid.');
          }
          deletedArtifactKeys.add(key);
          artifactDeletedCount += 1;
        } catch {
          artifactFailedCount += 1;
        }
      }

      let deletedCount = 0;
      let failedCount = scanned.failedCount;
      for (const session of scanned.sessions) {
        const artifactKey = artifactKeyBySessionId.get(session.id);
        if (artifactKey && !deletedArtifactKeys.has(artifactKey)) {
          failedCount += 1;
          continue;
        }
        try {
          if (!this.store.delete(session.id, session.ownerId)) throw new Error('Session disappeared.');
          deletedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
      const status = failedCount === 0 && artifactFailedCount === 0 ? 'completed' : 'partial_failure';
      const deletionFailureCount = failedCount + artifactFailedCount;
      const deletionAudit = shouldAudit
        ? this.recordDataDeletionAudit({
            operationId: deletionOperationId,
            scope: DATA_DELETION_SCOPES.RETENTION,
            phase:
              status === 'completed'
                ? DATA_DELETION_PHASES.COMPLETED
                : DATA_DELETION_PHASES.FAILED,
            targetSessionCount: scanned.sessions.length,
            targetArtifactCount: artifacts.size,
            deletedSessionCount: deletedCount,
            deletedArtifactCount: artifactDeletedCount,
            deletionFailureCount,
            ...(status === 'completed'
              ? {}
              : { errorCode: 'SESSION_RETENTION_CLEANUP_FAILED' })
          })
        : null;
      const result = {
        status,
        retentionDays: this.retentionDays,
        inactiveBefore,
        deletedCount,
        artifactDeletedCount,
        artifactPendingCount: artifactFailedCount,
        failedCount,
        deletionAudit,
        trace: [
          safeEvent('v0.session.retention.cleaned', {
            status,
            retentionDays: this.retentionDays,
            deletedCount,
            artifactDeletedCount,
            artifactPendingCount: artifactFailedCount,
            failedCount
          })
        ]
      };
      this.lastCleanup = result;
      this.lastCleanupAt = this.clock();
      return result;
    })().finally(() => {
      this.retentionCleanupPromise = null;
    });
    return this.retentionCleanupPromise;
  }

  start(input) {
    this.maybeCleanupInactiveSessions();
    const prepared = prepareLegalSelfCheckInput(input);
    if (prepared.status !== 'ready') {
      return { ...prepared };
    }
    const taskRecognition = this.recognizeTask(prepared.redactedText);
    if (taskRecognition.status !== 'classified') {
      return {
        status: 'failed',
        domainPackVersion: V0_DOMAIN_PACK_VERSION,
        piiRedacted: true,
        error: taskRecognition.error,
        trace: [...prepared.trace, ...taskRecognition.trace]
      };
    }
    if (
      prepared.requestedOutputFormats !== undefined &&
      taskRecognition.taskType !== TASK_TYPES.PROFESSIONAL_DATA_QUERY
    ) {
      return {
        status: 'failed',
        domainPackVersion: V0_DOMAIN_PACK_VERSION,
        piiRedacted: true,
        error: {
          code: V0_ERROR_CODES.INVALID_USER_TEXT,
          message: 'requestedOutputFormats 仅适用于 V1 专业数据查询。'
        },
        trace: [
          ...prepared.trace,
          ...taskRecognition.trace,
          safeEvent('v1.task-input.rejected', { code: 'TASK_TYPE_MISMATCH' })
        ]
      };
    }

    const now = this.clock();
    const session = {
      id: this.idFactory(),
      ownerId: this.ownerId,
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      ...(this.capabilitySnapshot
        ? { capabilitySnapshot: structuredClone(this.capabilitySnapshot) }
        : {}),
      privacyAuthorization: {
        status: PRIVACY_AUTHORIZATION_STATUS.GRANTED,
        policyVersion: prepared.privacyPolicyVersion,
        recordedAt: now,
        subjectId: this.ownerId
      },
      status: 'active',
      taskType: taskRecognition.taskType,
      taskTypeLabel: taskRecognition.taskTypeLabel,
      taskTypeRecognition: {
        status: taskRecognition.status,
        confidence: taskRecognition.confidence,
        matchedSignals: taskRecognition.matchedSignals,
        classificationMethod: taskRecognition.classificationMethod
      },
      clarificationRound: 0,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          role: 'user',
          redactedText: prepared.redactedText,
          receivedAt: now
        }
      ],
      legalDomain: undefined,
      legalDomainLabel: undefined,
      knownFacts: {},
      missingFields: [],
      questions: [],
      lawRetrievalStatus: 'not_run',
      lawReferences: [],
      lawCorpus: undefined,
      lawRetrievalError: undefined,
      lawComparisonStatus: 'not_run',
      lawComparisons: [],
      lawComparisonError: undefined,
      resultCardStatus: 'not_run',
      resultCards: [],
      resultCardError: undefined,
      error: undefined,
      trace: [...prepared.trace, ...taskRecognition.trace],
      latestTrace: []
    };

    if (session.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY) {
      if (this.v1Runtime) {
        return this.startV1QueryPlan(session, prepared, taskRecognition);
      }
      session.status = 'professional_query_identified';
      const sessionEvent = safeEvent('business.session.created', {
        sessionId: session.id,
        taskType: session.taskType,
        status: session.status
      });
      session.trace.push(sessionEvent);
      session.latestTrace = [...prepared.trace, ...taskRecognition.trace, sessionEvent];
      this.store.create(session);
      return publicResult(session);
    }

    const analysis = this.analyze(session);
    this.applyAnalysis(session, analysis);
    const lawRetrieval = this.retrieveLawReferences(session);
    const lawComparison = this.compareLawReferences(session);
    const resultCardBuild = this.buildResultCards(session);
    const sessionEvent = safeEvent('v0.session.created', {
      sessionId: session.id,
      clarificationRound: session.clarificationRound,
      status: session.status
    });
    session.trace.push(
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace,
      sessionEvent
    );
    session.latestTrace = [
      ...prepared.trace,
      ...taskRecognition.trace,
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace,
      sessionEvent
    ];
    this.store.create(session);
    return publicResult(session);
  }

  answer(sessionId, userText) {
    this.maybeCleanupInactiveSessions();
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) {
      return this.sessionError(sessionId, V0_ERROR_CODES.SESSION_NOT_FOUND, '没有找到对应会话。');
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      return this.sessionError(
        sessionId,
        V0_ERROR_CODES.SESSION_NOT_ACCEPTING_INPUT,
        '当前会话已经结束，不能继续补充回答。'
      );
    }

    const authorization = session.privacyAuthorization;
    const currentAuthorizationValid =
      authorization?.status === PRIVACY_AUTHORIZATION_STATUS.GRANTED &&
      authorization.policyVersion === PRIVACY_POLICY_VERSION &&
      authorization.subjectId === this.ownerId;
    if (!currentAuthorizationValid) {
      return this.sessionError(
        sessionId,
        V0_ERROR_CODES.PRIVACY_POLICY_VERSION_UNSUPPORTED,
        '当前会话没有有效的现行隐私政策授权，请重新确认后开启新会话。'
      );
    }

    const prepared = prepareLegalSelfCheckInput({
      userText,
      privacyConsent: true,
      privacyPolicyVersion: authorization.policyVersion
    });
    if (prepared.status !== 'ready') {
      return { sessionId, ...prepared };
    }

    const now = this.clock();
    session.messages.push({
      role: 'user',
      redactedText: prepared.redactedText,
      receivedAt: now
    });
    session.clarificationRound += 1;
    session.updatedAt = now;

    const analysis = this.analyze(session);
    this.applyAnalysis(session, analysis);
    const lawRetrieval = this.retrieveLawReferences(session);
    const lawComparison = this.compareLawReferences(session);
    const resultCardBuild = this.buildResultCards(session);
    const sessionEvent = safeEvent('v0.session.updated', {
      sessionId: session.id,
      clarificationRound: session.clarificationRound,
      status: session.status
    });
    session.trace.push(
      ...prepared.trace,
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace,
      sessionEvent
    );
    session.latestTrace = [
      ...prepared.trace,
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace,
      sessionEvent
    ];
    this.store.save(session, this.ownerId);
    return publicResult(session);
  }

  getSession(sessionId) {
    return this.store.get(sessionId, this.ownerId);
  }

  applySupplementalFacts(sessionId, supplementalFacts) {
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) return null;
    if (session.taskType !== TASK_TYPES.LEGAL_SELF_CHECK) return null;
    if (TERMINAL_STATUSES.has(session.status)) return null;
    if (
      !supplementalFacts ||
      typeof supplementalFacts !== 'object' ||
      Array.isArray(supplementalFacts)
    ) {
      return null;
    }
    // 会话中已有的事实（来自确定性提取）优先；补充事实只填补空缺字段。
    const additions = Object.entries(supplementalFacts).filter(
      ([field, value]) =>
        !Object.hasOwn(session.knownFacts, field) &&
        ['string', 'number', 'boolean'].includes(typeof value) &&
        (typeof value !== 'string' || (value.length > 0 && value.length <= 200)) &&
        (typeof value !== 'number' || Number.isFinite(value))
    );
    if (additions.length === 0) return null;

    session.knownFacts = { ...Object.fromEntries(additions), ...session.knownFacts };
    session.updatedAt = this.clock();
    const analysis = this.analyze(session);
    this.applyAnalysis(session, analysis);
    const lawRetrieval = this.retrieveLawReferences(session);
    const lawComparison = this.compareLawReferences(session);
    const resultCardBuild = this.buildResultCards(session);
    const mergeEvent = safeEvent('v0.session.supplemental-facts-merged', {
      sessionId: session.id,
      fields: additions.map(([field]) => field),
      status: session.status
    });
    session.trace.push(
      mergeEvent,
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace
    );
    session.latestTrace = [
      mergeEvent,
      ...analysis.trace,
      ...lawRetrieval.trace,
      ...lawComparison.trace,
      ...resultCardBuild.trace
    ];
    this.store.save(session, this.ownerId);
    return publicResult(session);
  }

  startV1QueryPlan(session, prepared, taskRecognition) {
    const runId = randomUUID();
    let taskInput;
    try {
      const descriptor = this.v1Runtime.describe();
      taskInput = createProfessionalQueryTaskInput({
        piiRedacted: true,
        query: prepared.redactedText,
        sessionId: session.id,
        dataSourceId: descriptor?.dataSource,
        requestedOutputFormats: prepared.requestedOutputFormats
      });
    } catch {
      return this.sessionError(
        session.id,
        'V1_TASK_INPUT_INVALID',
        'V1 任务输入与当前固定数据源绑定不一致，查询计划未生成。'
      );
    }
    const planned = this.v1Runtime.plan({
      runId,
      sessionId: session.id,
      ownerId: this.ownerId,
      piiRedacted: true,
      redactedText: prepared.redactedText,
      clarificationRound: 0,
      knownFacts: {},
      taskInput
    });
    if (planned && typeof planned.then === 'function') {
      return planned.then(
        (result) =>
          this.finishV1QueryPlan(
            session,
            prepared,
            taskRecognition,
            runId,
            taskInput,
            result
          ),
        () =>
          this.finishV1QueryPlan(
            session,
            prepared,
            taskRecognition,
            runId,
            taskInput,
            {
              status: 'rejected',
              reason: '生成受治理数据库计划失败，操作未执行。',
              trace: [safeEvent('v1.query.plan.failed', { code: 'RUNTIME_REJECTED' })]
            }
          )
      );
    }
    return this.finishV1QueryPlan(
      session,
      prepared,
      taskRecognition,
      runId,
      taskInput,
      planned
    );
  }

  finishV1QueryPlan(session, prepared, taskRecognition, runId, taskInput, planned) {
    const now = this.clock();
    const taskInputReceipt = createProfessionalQueryTaskReceipt(taskInput);
    session.updatedAt = now;
    session.status = planned.status === 'rejected' ? 'rejected' : 'awaiting_confirmation';
    session.v1 = {
      runId,
      status: planned.status,
      taskInput: taskInputReceipt,
      workspace: createQueryWorkspaceLifecycle({ taskInputReceipt, now }),
      plan: planned.plan ?? null,
      schema: planned.schema ?? null,
      safety: planned.safety ?? null,
      governanceReceipt: planned.governanceReceipt ?? null,
      reason: planned.reason,
      result: null,
      chart: null,
      artifact: null,
      planLogId: null,
      executionLogId: null,
      confirmedAt: null,
      cancelledAt: null,
      schemaDrift: null,
      replanRequired: false,
      replannedAt: null
    };
    const planEvent = safeEvent('v1.query.plan.presented', {
      sessionId: session.id,
      runId,
      status: planned.status
    });
    const sessionEvent = safeEvent('business.session.created', {
      sessionId: session.id,
      taskType: session.taskType,
      status: session.status
    });
    session.trace.push(...(planned.trace ?? []), planEvent, sessionEvent);
    session.latestTrace = [
      ...prepared.trace,
      ...taskRecognition.trace,
      ...(planned.trace ?? []),
      planEvent,
      sessionEvent
    ];
    try {
      const planLog = this.appendV1ExecutionLog(session, {
        operationType: 'plan',
        status: planned.status,
        error: planned.reason
      });
      session.v1.planLogId = planLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, false);
    }
    this.store.create(session);
    return { ...publicResult(session), v1: session.v1 };
  }

  confirmV1Execution(sessionId, confirmation = {}) {
    this.maybeCleanupInactiveSessions();
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) {
      return this.sessionError(sessionId, V0_ERROR_CODES.SESSION_NOT_FOUND, '没有找到对应会话。');
    }
    if (
      session.v1?.workspace?.status === 'archived'
    ) {
      return this.archivedV1WorkspaceError(session);
    }
    if (
      session.taskType !== TASK_TYPES.PROFESSIONAL_DATA_QUERY ||
      session.status !== 'awaiting_confirmation' ||
      !session.v1?.plan
    ) {
      return this.sessionError(
        sessionId,
        'V1_EXECUTION_NOT_AWAITING_CONFIRMATION',
        '当前会话不在等待执行确认状态，不能重复确认或取消。'
      );
    }

    const now = this.clock();
    session.updatedAt = now;
    try {
      session.v1.workspace = touchQueryWorkspace(session.v1.workspace, now);
    } catch {
      return this.failV1Workspace(session, 'execute');
    }

    if (confirmation?.confirmed !== true) {
      if (
        session.v1.plan.humanReviewRequired === true &&
        typeof this.v1Runtime.reject === 'function'
      ) {
        session.status = 'cancelling';
        session.v1.status = 'cancelling';
        this.store.save(session, this.ownerId);
        return Promise.resolve(
          this.v1Runtime.reject({
            runId: session.v1.runId,
            governedInvocationId: session.v1.plan.governedInvocationId
          })
        ).then(
          (rejected) => this.finishV1Cancellation(session, now, rejected?.governanceReceipt),
          () => this.finishV1Cancellation(session, now, null)
        );
      }
      return this.finishV1Cancellation(session, now, null);
    }

    const startedAt = Date.now();
    let taskInput;
    try {
      taskInput = restoreProfessionalQueryTaskInput(
        session.v1.taskInput,
        session.messages.map((message) => message.redactedText).join('\n')
      );
    } catch {
      return this.failV1TaskInput(session, 'execute');
    }
    const execution = this.v1Runtime.execute({
      runId: session.v1.runId,
      sessionId: session.id,
      ownerId: this.ownerId,
      piiRedacted: true,
      redactedText: session.messages.map((message) => message.redactedText).join('\n'),
      clarificationRound: 0,
      knownFacts: {},
      expectedPlanHash: session.v1.plan.planHash,
      expectedSchemaFingerprint: session.v1.plan.schemaFingerprint,
      expectedSchemaSnapshot: session.v1.plan.schemaSnapshot ?? session.v1.schema,
      governedInvocationId: session.v1.plan.governedInvocationId,
      confirmedAt: now,
      confirmedPlan: session.v1.plan,
      taskInput
    });
    if (execution && typeof execution.then === 'function') {
      session.status = 'executing';
      session.v1.status = 'executing';
      session.v1.confirmedAt = now;
      this.store.save(session, this.ownerId);
      return execution.then(
        (executed) => this.finishV1Execution(session, executed, now, startedAt),
        () =>
          this.finishV1Execution(
            session,
            {
              status: 'rejected',
              executionAttempted: true,
              reason: '只读查询执行失败，结果不会发布。',
              trace: [safeEvent('v1.query.execution.failed', { code: 'RUNTIME_REJECTED' })]
            },
            now,
            startedAt
          )
      );
    }
    return this.finishV1Execution(session, execution, now, startedAt);
  }

  finishV1Cancellation(session, cancelledAt, governanceReceipt) {
    session.status = 'cancelled';
    session.v1.status = 'cancelled';
    session.v1.cancelledAt = cancelledAt;
    session.v1.governanceReceipt = governanceReceipt ?? session.v1.governanceReceipt;
    const cancelEvent = safeEvent('v1.query.execution.cancelled', {
      sessionId: session.id,
      runId: session.v1.runId,
      humanReviewRejected: session.v1.plan?.humanReviewRequired === true
    });
    session.trace.push(cancelEvent);
    session.latestTrace = [cancelEvent];
    try {
      const cancelLog = this.appendV1ExecutionLog(session, {
        operationType: 'cancel',
        status: 'cancelled',
        humanReviewRequired: session.v1.plan?.humanReviewRequired,
        humanReviewStatus: governanceReceipt?.status
      });
      session.v1.executionLogId = cancelLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, false);
    }
    this.store.save(session, this.ownerId);
    return { ...publicResult(session), v1: session.v1 };
  }

  replanV1Execution(sessionId) {
    this.maybeCleanupInactiveSessions();
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) {
      return this.sessionError(sessionId, V0_ERROR_CODES.SESSION_NOT_FOUND, '没有找到对应会话。');
    }
    if (
      session.v1?.workspace?.status === 'archived'
    ) {
      return this.archivedV1WorkspaceError(session);
    }
    if (
      session.taskType !== TASK_TYPES.PROFESSIONAL_DATA_QUERY ||
      session.status !== 'rejected' ||
      session.v1?.replanRequired !== true ||
      !session.v1?.plan ||
      typeof this.v1Runtime?.replan !== 'function'
    ) {
      return this.sessionError(
        sessionId,
        'V1_REPLAN_NOT_REQUIRED',
        '当前会话没有待处理的 Schema 变化，不能重新生成计划。'
      );
    }

    const previousPlan = session.v1.plan;
    const previousDrift = session.v1.schemaDrift;
    let taskInput;
    try {
      taskInput = restoreProfessionalQueryTaskInput(
        session.v1.taskInput,
        session.messages.map((message) => message.redactedText).join('\n')
      );
    } catch {
      return this.failV1TaskInput(session, 'replan');
    }
    const runId = randomUUID();
    const replannedAt = this.clock();
    try {
      session.v1.workspace = touchQueryWorkspace(session.v1.workspace, replannedAt);
    } catch {
      return this.failV1Workspace(session, 'replan');
    }
    const replanning = this.v1Runtime.replan({
      runId,
      sessionId: session.id,
      ownerId: this.ownerId,
      piiRedacted: true,
      redactedText: session.messages.map((message) => message.redactedText).join('\n'),
      clarificationRound: 0,
      knownFacts: {},
      expectedSchemaSnapshot: previousPlan.schemaSnapshot ?? session.v1.schema,
      taskInput
    });
    if (replanning && typeof replanning.then === 'function') {
      session.status = 'replanning';
      session.v1.status = 'replanning';
      this.store.save(session, this.ownerId);
      return replanning.then(
        (planned) => this.finishV1Replan(session, planned, previousPlan, previousDrift, replannedAt),
        () => this.finishV1Replan(
          session,
          {
            status: 'rejected',
            reason: '重新读取 Schema 或生成查询计划失败，本次查询仍保持停止。',
            replanRequired: true,
            trace: [safeEvent('v1.query.replan.failed', { code: 'RUNTIME_REJECTED' })]
          },
          previousPlan,
          previousDrift,
          replannedAt
        )
      );
    }
    return this.finishV1Replan(session, replanning, previousPlan, previousDrift, replannedAt);
  }

  finishV1Replan(session, planned, previousPlan, previousDrift, replannedAt) {
    const succeeded = planned.status === 'awaiting_confirmation' && planned.plan;
    session.updatedAt = replannedAt;
    session.status = succeeded ? 'awaiting_confirmation' : 'rejected';
    session.v1.runId = succeeded ? planned.runId : session.v1.runId;
    session.v1.status = planned.status;
    session.v1.plan = succeeded ? planned.plan : previousPlan;
    session.v1.schema = succeeded ? planned.schema : session.v1.schema;
    session.v1.safety = succeeded ? planned.safety : session.v1.safety;
    session.v1.reason = succeeded ? undefined : planned.reason;
    session.v1.result = null;
    session.v1.chart = null;
    session.v1.artifact = null;
    session.v1.confirmedAt = null;
    session.v1.cancelledAt = null;
    session.v1.replannedAt = succeeded ? replannedAt : null;
    session.v1.replanRequired = !succeeded;
    session.v1.schemaDrift = succeeded
      ? { ...previousDrift, replanRequired: false, resolution: 'replanned', resolvedAt: replannedAt }
      : planned.schemaDrift ?? previousDrift;
    const replanEvent = safeEvent(
      succeeded ? 'v1.query.replan.presented' : 'v1.query.replan.rejected',
      {
        sessionId: session.id,
        previousSchemaFingerprint: previousPlan.schemaFingerprint,
        currentSchemaFingerprint: planned.plan?.schemaFingerprint ?? planned.schemaDrift?.currentFingerprint,
        requiresConfirmation: succeeded
      }
    );
    session.trace.push(...(planned.trace ?? []), replanEvent);
    session.latestTrace = [...(planned.trace ?? []), replanEvent];
    try {
      const replanLog = this.appendV1ExecutionLog(session, {
        operationType: 'replan',
        status: planned.status,
        previousSchemaFingerprint: previousPlan.schemaFingerprint,
        currentSchemaFingerprint: planned.plan?.schemaFingerprint ?? planned.schemaDrift?.currentFingerprint,
        schemaDriftDetected: true,
        affectedTableCount: previousDrift?.affectedTables?.length ?? 0,
        affectedFieldCount: previousDrift?.affectedFields?.length ?? 0,
        replanRequired: !succeeded,
        error: planned.reason
      });
      session.v1.planLogId = replanLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, false);
    }
    this.store.save(session, this.ownerId);
    return { ...publicResult(session), v1: session.v1 };
  }

  finishV1Execution(session, executed, confirmedAt, startedAt) {
    if (
      executed.status === 'completed' &&
      this.artifactRepository !== null &&
      executed.plan?.readOnly !== false
    ) {
      const persistenceFailure = () =>
        this.finalizeV1Execution(
          session,
          {
            ...executed,
            status: 'failed',
            reason: '查询已执行，但分析产物持久化失败，结果已停止发布。',
            result: null,
            chart: null,
            artifact: null,
            trace: [
              ...(executed.trace ?? []),
              safeEvent('v1.artifact.persistence.failed', { resultWithheld: true })
            ]
          },
          confirmedAt,
          startedAt
        );
      if (!executed.artifact) {
        return persistenceFailure();
      }
      session.status = 'executing';
      session.v1.status = 'executing';
      this.store.save(session, this.ownerId);
      return Promise.resolve(
        this.artifactRepository.storeAnalysisArtifact({
          sessionId: session.id,
          runId: session.v1.runId,
          artifact: executed.artifact,
          publication: {
            status: executed.status,
            executionAttempted: executed.executionAttempted
          }
        })
      )
        .then(
          (storageReceipt) =>
            isGovernedArtifactReceipt(
              storageReceipt,
              executed.artifact.contentSha256,
              this.artifactOutputBindingRef
            )
              ? { persisted: true, storageReceipt }
              : { persisted: false },
          () => ({ persisted: false })
        )
        .then(({ persisted, storageReceipt }) => {
          if (!persisted) return persistenceFailure();
          return this.finalizeV1Execution(
            session,
            {
              ...executed,
              artifact: { ...executed.artifact, storage: storageReceipt },
              trace: [
                ...(executed.trace ?? []),
                safeEvent('v1.artifact.persisted', {
                  storeId: storageReceipt.storeId,
                  contentSha256: storageReceipt.contentSha256
                })
              ]
            },
            confirmedAt,
            startedAt
          );
        });
    }
    return this.finalizeV1Execution(session, executed, confirmedAt, startedAt);
  }

  finalizeV1Execution(session, executed, confirmedAt, startedAt) {
    const durationMs = Date.now() - startedAt;
    session.status =
      executed.status === 'completed'
        ? 'completed'
        : executed.status === 'failed'
          ? 'failed'
          : 'rejected';
    session.v1.status = executed.status;
    session.v1.reason = executed.reason;
    session.v1.result = executed.result ?? null;
    session.v1.chart = executed.chart ?? null;
    session.v1.artifact = executed.artifact ?? null;
    session.v1.safety = executed.safety ?? session.v1.safety;
    session.v1.governanceReceipt = executed.governanceReceipt ?? session.v1.governanceReceipt;
    session.v1.confirmedAt = confirmedAt;
    session.v1.schemaDrift = executed.schemaDrift ?? session.v1.schemaDrift ?? null;
    session.v1.replanRequired = executed.replanRequired === true;
    const executedEvent = safeEvent('v1.query.execution.finished', {
      sessionId: session.id,
      runId: session.v1.runId,
      status: executed.status,
      rowCount: executed.result?.rowCount ?? 0,
      durationMs
    });
    session.trace.push(...(executed.trace ?? []), executedEvent);
    session.latestTrace = [...(executed.trace ?? []), executedEvent];
    try {
      const executionLog = this.appendV1ExecutionLog(session, {
        operationType: 'execute',
        status: executed.status,
        durationMs,
        rowCount: executed.result?.rowCount ?? 0,
        artifactId: executed.artifact?.artifactId,
        artifactSha256: executed.artifact?.contentSha256,
        artifactStoreId: executed.artifact?.storage?.storeId,
        artifactObjectKey: executed.artifact?.storage?.objectKey,
        executionProvider: executed.providerReceipt?.provider,
        providerDurationMs: executed.providerReceipt?.durationMs,
        providerOutputBytes: executed.providerReceipt?.outputBytes,
        providerReadOnly: executed.providerReceipt?.readOnly,
        sourceRowCount: executed.providerReceipt?.sourceRowCount,
        affectedRows: executed.result?.affectedRows,
        transactionStatus: executed.result?.transactionStatus,
        humanReviewRequired: executed.safety?.humanReviewRequired,
        humanReviewStatus: executed.safety?.humanReviewStatus,
        governedInvocationId: executed.safety?.governedInvocationId,
        governanceEventCount: executed.governanceReceipt?.eventCount,
        previousSchemaFingerprint: executed.schemaDrift?.previousFingerprint,
        currentSchemaFingerprint: executed.schemaDrift?.currentFingerprint,
        schemaDriftDetected: executed.schemaDrift?.detected,
        affectedTableCount: executed.schemaDrift?.affectedTables?.length,
        affectedFieldCount: executed.schemaDrift?.affectedFields?.length,
        replanRequired: executed.replanRequired,
        error: executed.reason
      });
      session.v1.executionLogId = executionLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, executed.executionAttempted === true);
    }
    this.store.save(session, this.ownerId);
    return { ...publicResult(session), v1: session.v1 };
  }

  listV1ExecutionLogs(filter = {}) {
    if (!this.executionLog) {
      return [];
    }
    return this.executionLog.list(filter);
  }

  getV1ExecutionLogIntegrity() {
    if (!this.executionLog) {
      return { status: 'unavailable', recordCount: 0, verifiedCount: 0, legacyCount: 0 };
    }
    return this.executionLog.verifyIntegrity();
  }

  appendV1ExecutionLog(session, entry) {
    if (!this.executionLog) {
      throw new Error('V1 execution log is unavailable.');
    }
    return this.executionLog.append({
      actorId: this.auditActorId,
      sessionId: session.id,
      runId: session.v1?.runId,
      sql: session.v1?.plan?.sql,
      planHash: session.v1?.plan?.planHash,
      schemaFingerprint: session.v1?.plan?.schemaFingerprint,
      humanReviewRequired: session.v1?.plan?.humanReviewRequired,
      humanReviewStatus: session.v1?.governanceReceipt?.status,
      governedInvocationId: session.v1?.plan?.governedInvocationId,
      governanceEventCount: session.v1?.governanceReceipt?.eventCount,
      ...entry
    });
  }

  failV1ForAuditLog(session, resultMayHaveExecuted) {
    session.status = 'failed';
    session.v1.status = 'failed';
    session.v1.reason = resultMayHaveExecuted
      ? '查询已执行，但审计日志写入失败，结果已停止发布。'
      : '审计日志写入失败，本次操作未继续。';
    session.v1.result = null;
    session.v1.chart = null;
    session.v1.artifact = null;
    const failedEvent = safeEvent('v1.execution-log.append.failed', {
      sessionId: session.id,
      resultMayHaveExecuted
    });
    session.trace.push(failedEvent);
    session.latestTrace = [failedEvent];
  }

  archiveInactiveQueryWorkspaces() {
    const now = this.clock();
    const result = {
      status: 'completed',
      archiveAfterInactiveDays: QUERY_WORKSPACE_ARCHIVE_DAYS,
      archivedCount: 0,
      activeCount: 0,
      verifiedArchiveCount: 0,
      failedCount: 0
    };
    let sessions;
    try {
      sessions = this.store.list(this.ownerId);
    } catch {
      result.status = 'partial_failure';
      result.failedCount = 1;
      return result;
    }
    for (const session of sessions) {
      if (
        session.taskType !== TASK_TYPES.PROFESSIONAL_DATA_QUERY ||
        !session.v1?.workspace ||
        !session.v1?.taskInput
      ) {
        continue;
      }
      try {
        const current = assertQueryWorkspaceLifecycle(session.v1.workspace);
        if (current.status === 'archived') {
          verifyQueryWorkspaceArchive({
            lifecycle: current,
            taskInputReceipt: session.v1.taskInput,
            artifact: session.v1.artifact
          });
          result.verifiedArchiveCount += 1;
          continue;
        }
        const archived = archiveQueryWorkspaceIfInactive({
          lifecycle: current,
          taskInputReceipt: session.v1.taskInput,
          artifact: session.v1.artifact,
          previousTaskStatus: session.status,
          now
        });
        if (archived.status !== 'archived') {
          result.activeCount += 1;
          continue;
        }
        session.v1.workspace = archived;
        session.v1.status = 'archived';
        session.status = 'archived';
        const archiveEvent = safeEvent('v1.query-workspace.archived', {
          inactiveDaysThreshold: QUERY_WORKSPACE_ARCHIVE_DAYS,
          artifactReferenceCount: archived.archiveReceipt.artifactReference ? 1 : 0,
          receiptSha256: archived.archiveReceipt.receiptSha256
        });
        session.trace.push(archiveEvent);
        session.latestTrace = [archiveEvent];
        const archiveLog = this.appendV1ExecutionLog(session, {
          operationType: 'workspace_archive',
          status: 'archived',
          workspaceId: archived.workspaceId,
          workspaceArchiveReceiptSha256: archived.archiveReceipt.receiptSha256,
          workspaceInactiveDays: QUERY_WORKSPACE_ARCHIVE_DAYS,
          artifactReferenceCount: archived.archiveReceipt.artifactReference ? 1 : 0,
          executionAttempted: false
        });
        session.v1.executionLogId = archiveLog.entryId;
        this.store.save(session, this.ownerId);
        result.archivedCount += 1;
      } catch {
        result.failedCount += 1;
      }
    }
    if (result.failedCount > 0) result.status = 'partial_failure';
    return result;
  }

  failV1TaskInput(session, operationType) {
    session.status = 'failed';
    session.v1.status = 'failed';
    session.v1.reason = 'V1 TaskSchema 回执缺失或发生漂移，操作已安全停止。';
    session.v1.result = null;
    session.v1.chart = null;
    session.v1.artifact = null;
    const failedEvent = safeEvent('v1.task-input.invalid', {
      operationType,
      executionAttempted: false
    });
    session.trace.push(failedEvent);
    session.latestTrace = [failedEvent];
    try {
      const failureLog = this.appendV1ExecutionLog(session, {
        operationType,
        status: 'failed',
        error: session.v1.reason
      });
      session.v1.executionLogId = failureLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, false);
    }
    this.store.save(session, this.ownerId);
    return { ...publicResult(session), v1: session.v1 };
  }

  failV1Workspace(session, operationType) {
    session.status = 'failed';
    session.v1.status = 'failed';
    session.v1.reason = '逻辑查询 Workspace 回执缺失或发生漂移，操作已安全停止。';
    session.v1.result = null;
    session.v1.chart = null;
    session.v1.artifact = null;
    session.v1.workspace = null;
    const failedEvent = safeEvent('v1.query-workspace.invalid', {
      operationType,
      executionAttempted: false
    });
    session.trace.push(failedEvent);
    session.latestTrace = [failedEvent];
    try {
      const failureLog = this.appendV1ExecutionLog(session, {
        operationType,
        status: 'failed',
        error: session.v1.reason,
        errorCode: 'QUERY_WORKSPACE_INVALID'
      });
      session.v1.executionLogId = failureLog.entryId;
    } catch {
      this.failV1ForAuditLog(session, false);
    }
    this.store.save(session, this.ownerId);
    return { ...publicResult(session), v1: session.v1 };
  }

  archivedV1WorkspaceError(session) {
    try {
      verifyQueryWorkspaceArchive({
        lifecycle: session.v1.workspace,
        taskInputReceipt: session.v1.taskInput,
        artifact: session.v1.artifact
      });
    } catch {
      return this.failV1Workspace(session, 'archived-access');
    }
    return {
      ...publicResult(session),
      v1: session.v1,
      error: {
        code: 'V1_WORKSPACE_ARCHIVED',
        message: '该专业查询 Workspace 已因超过 30 天未活动而归档，请新建任务。'
      }
    };
  }

  deleteSession(sessionId, confirmation = {}) {
    if (confirmation?.confirmed !== true) {
      return {
        status: 'confirmation_required',
        sessionId,
        success: false,
        deleted: false,
        error: {
          code: V0_ERROR_CODES.SESSION_DELETE_CONFIRMATION_REQUIRED,
          message: '主动删除会话前必须由当前用户明确确认。'
        }
      };
    }
    const session = this.store.get(sessionId, this.ownerId);
    if (session?.v1?.artifact?.storage) {
      return {
        status: 'artifact_cleanup_required',
        sessionId,
        success: false,
        deleted: false,
        error: {
          code: 'SESSION_DELETE_REQUIRES_ARTIFACT_CLEANUP',
          message: '该会话包含持久化分析产物，必须使用可等待的安全删除入口。'
        }
      };
    }
    const deleted = this.store.delete(sessionId, this.ownerId);
    return {
      status: deleted ? 'deleted' : 'not_found',
      sessionId,
      success: deleted,
      deleted
    };
  }

  async deleteSessionWithArtifacts(sessionId, confirmation = {}) {
    if (confirmation?.confirmed !== true) return this.deleteSession(sessionId, confirmation);
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) return this.deleteSession(sessionId, confirmation);
    const artifact = session?.v1?.artifact;
    const storage = artifact?.storage;
    let artifactDeleted = false;
    const targetArtifactCount = storage ? 1 : 0;
    const deletionOperationId = this.deletionAuditIdFactory();
    this.recordDataDeletionAudit({
      operationId: deletionOperationId,
      scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
      phase: DATA_DELETION_PHASES.REQUESTED,
      targetSessionCount: 1,
      targetArtifactCount,
      deletedSessionCount: 0,
      deletedArtifactCount: 0,
      deletionFailureCount: 0
    });
    const recordFailure = (errorCode) =>
      this.recordDataDeletionAudit({
        operationId: deletionOperationId,
        scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
        phase: DATA_DELETION_PHASES.FAILED,
        targetSessionCount: 1,
        targetArtifactCount,
        deletedSessionCount: 0,
        deletedArtifactCount: artifactDeleted ? 1 : 0,
        deletionFailureCount: 1,
        errorCode
      });
    if (storage) {
      if (
        !this.artifactRepository ||
        typeof this.artifactRepository.readAnalysisArtifact !== 'function' ||
        typeof this.artifactRepository.deleteAnalysisArtifact !== 'function'
      ) {
        const error = new Error('当前运行时未配置关联分析产物的安全删除能力。');
        error.code = 'SESSION_DELETE_ARTIFACT_UNAVAILABLE';
        error.deletionAudit = recordFailure(error.code);
        throw error;
      }
      try {
        const verified = await this.artifactRepository.readAnalysisArtifact(storage);
        if (
          verified?.contentSha256 !== artifact.contentSha256 ||
          verified?.sizeBytes !== storage.sizeBytes
        ) {
          throw new Error('Artifact read-back receipt does not match the Session.');
        }
        const deletion = await this.artifactRepository.deleteAnalysisArtifact(storage);
        if (!['deleted', 'already_absent'].includes(deletion?.status)) {
          throw new Error('Artifact deletion receipt is invalid.');
        }
        artifactDeleted = true;
      } catch (cause) {
        const error = new Error('关联分析产物未能安全删除，会话已保留以便重试。', { cause });
        error.code = 'SESSION_DELETE_ARTIFACT_FAILED';
        error.deletionAudit = recordFailure(error.code);
        throw error;
      }
    }
    if (!this.store.delete(sessionId, this.ownerId)) {
      const error = new Error('关联产物已处理，但会话物理删除未获确认。');
      error.code = 'SESSION_DELETE_FAILED';
      error.deletionAudit = recordFailure(error.code);
      throw error;
    }
    const deletionAudit = this.recordDataDeletionAudit({
      operationId: deletionOperationId,
      scope: DATA_DELETION_SCOPES.SINGLE_SESSION,
      phase: DATA_DELETION_PHASES.COMPLETED,
      targetSessionCount: 1,
      targetArtifactCount,
      deletedSessionCount: 1,
      deletedArtifactCount: artifactDeleted ? 1 : 0,
      deletionFailureCount: 0
    });
    return Object.freeze({
      status: 'deleted',
      sessionId,
      success: true,
      deleted: true,
      artifactDeleted,
      deletionAudit
    });
  }

  listHistory() {
    this.maybeCleanupInactiveSessions();
    return this.store
      .list(this.ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(historySummary);
  }

  getHistory(sessionId) {
    this.maybeCleanupInactiveSessions();
    const session = this.store.get(sessionId, this.ownerId);
    if (session?.v1?.workspace?.status === 'archived') {
      try {
        verifyQueryWorkspaceArchive({
          lifecycle: session.v1.workspace,
          taskInputReceipt: session.v1.taskInput,
          artifact: session.v1.artifact
        });
      } catch {
        this.failV1Workspace(session, 'history');
        return historyDetail(this.store.get(sessionId, this.ownerId));
      }
    }
    return session ? historyDetail(session) : null;
  }

  async eraseOwnerHistory(confirmation = {}) {
    if (
      confirmation?.confirmed !== true ||
      confirmation?.confirmationPhrase !== OWNER_HISTORY_ERASURE_PHRASE
    ) {
      return {
        status: 'confirmation_required',
        success: false,
        erasedSessionCount: 0,
        erasedArtifactCount: 0,
        auditRecordsRetained: true,
        error: {
          code: 'OWNER_HISTORY_ERASURE_CONFIRMATION_REQUIRED',
          message: `清除全部历史必须输入确认短语 ${OWNER_HISTORY_ERASURE_PHRASE}。`
        }
      };
    }

    const sessions = this.store.list(this.ownerId);
    const artifacts = new Map();
    for (const session of sessions) {
      const storage = session?.v1?.artifact?.storage;
      if (storage) artifacts.set(`${storage.storeId}\0${storage.objectKey}`, storage);
    }
    const deletionOperationId = this.deletionAuditIdFactory();
    const recordErasureAudit = (phase, deletedSessionCount, deletedArtifactCount, errorCode) =>
      this.recordDataDeletionAudit({
        operationId: deletionOperationId,
        scope: DATA_DELETION_SCOPES.OWNER_HISTORY,
        phase,
        targetSessionCount: sessions.length,
        targetArtifactCount: artifacts.size,
        deletedSessionCount,
        deletedArtifactCount,
        deletionFailureCount:
          phase === DATA_DELETION_PHASES.FAILED
            ? Math.max(
                1,
                sessions.length - deletedSessionCount + artifacts.size - deletedArtifactCount
              )
            : 0,
        ...(errorCode ? { errorCode } : {})
      });

    recordErasureAudit(DATA_DELETION_PHASES.REQUESTED, 0, 0);
    if (
      artifacts.size > 0 &&
      (!this.artifactRepository ||
        typeof this.artifactRepository.readAnalysisArtifact !== 'function' ||
        typeof this.artifactRepository.deleteAnalysisArtifact !== 'function')
    ) {
      const error = new Error('存在持久化分析产物，但当前运行时未配置受治理的删除能力。');
      error.code = 'OWNER_HISTORY_ERASURE_UNAVAILABLE';
      error.deletionAudit = recordErasureAudit(
        DATA_DELETION_PHASES.FAILED,
        0,
        0,
        error.code
      );
      throw error;
    }

    let erasedArtifactCount = 0;
    let erasedSessionCount = 0;
    try {
      for (const receipt of artifacts.values()) {
        await this.artifactRepository.readAnalysisArtifact(receipt);
      }
      for (const receipt of artifacts.values()) {
        const result = await this.artifactRepository.deleteAnalysisArtifact(receipt);
        if (!['deleted', 'already_absent'].includes(result?.status)) {
          throw new Error('Artifact Repository returned an invalid deletion receipt.');
        }
        erasedArtifactCount += 1;
      }
      for (const session of sessions) {
        if (!this.store.delete(session.id, this.ownerId)) {
          throw new Error('Session Store did not confirm physical deletion.');
        }
        erasedSessionCount += 1;
      }
    } catch (cause) {
      const error = new Error('当前账号历史未能全部清除；请保留运行目录并重试。', { cause });
      error.code = 'OWNER_HISTORY_ERASURE_FAILED';
      try {
        error.deletionAudit = recordErasureAudit(
          DATA_DELETION_PHASES.FAILED,
          erasedSessionCount,
          erasedArtifactCount,
          error.code
        );
      } catch {
        // Preserve the erasure failure as the primary error; integrity checks still expose log failure.
      }
      throw error;
    }

    const deletionAudit = recordErasureAudit(
      DATA_DELETION_PHASES.COMPLETED,
      erasedSessionCount,
      erasedArtifactCount
    );
    return Object.freeze({
      status: 'completed',
      success: true,
      erasedSessionCount,
      erasedArtifactCount,
      auditRecordsRetained: true,
      erasureReceiptRecorded: deletionAudit.recorded,
      deletionAudit
    });
  }

  async readV1Artifact(sessionId, artifactId) {
    this.maybeCleanupInactiveSessions();
    const session = this.store.get(sessionId, this.ownerId);
    if (!session) {
      const error = new Error('没有找到对应会话。');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    const artifact = session.v1?.artifact;
    if (
      session.taskType !== TASK_TYPES.PROFESSIONAL_DATA_QUERY ||
      !artifact ||
      artifact.artifactId !== artifactId
    ) {
      const error = new Error('没有找到对应分析产物。');
      error.code = 'ARTIFACT_NOT_FOUND';
      throw error;
    }
    if (session.v1?.workspace?.status === 'archived') {
      try {
        verifyQueryWorkspaceArchive({
          lifecycle: session.v1.workspace,
          taskInputReceipt: session.v1.taskInput,
          artifact
        });
      } catch {
        this.failV1Workspace(session, 'artifact-download');
        const error = new Error('归档产物引用校验失败。');
        error.code = 'QUERY_WORKSPACE_INVALID';
        throw error;
      }
    }
    if (
      !artifact.storage ||
      !this.artifactRepository ||
      typeof this.artifactRepository.readAnalysisArtifact !== 'function'
    ) {
      const error = new Error('分析产物下载能力尚未配置。');
      error.code = 'ARTIFACT_DOWNLOAD_UNAVAILABLE';
      throw error;
    }
    let stored;
    try {
      stored = await this.artifactRepository.readAnalysisArtifact(artifact.storage);
    } catch {
      const error = new Error('分析产物回读校验失败。');
      error.code = 'ARTIFACT_VERIFY_FAILED';
      throw error;
    }
    if (
      stored.contentSha256 !== artifact.contentSha256 ||
      typeof stored.content !== 'string'
    ) {
      const error = new Error('分析产物回读校验失败。');
      error.code = 'ARTIFACT_VERIFY_FAILED';
      throw error;
    }
    return Object.freeze({
      status: 'verified',
      sessionId: session.id,
      workspaceStatus: session.v1?.workspace?.status ?? 'active',
      readOnly: true,
      artifact: Object.freeze({
        artifactId: artifact.artifactId,
        type: artifact.type,
        fileName: artifact.fileName,
        mimeType: stored.mimeType ?? artifact.mimeType,
        contentSha256: stored.contentSha256,
        sizeBytes: stored.sizeBytes,
        content: stored.content
      })
    });
  }

  analyze(session) {
    const combinedRedactedText = session.messages.map((message) => message.redactedText).join('\n');
    return analyzeInformationReadiness(
      {
        status: 'ready',
        piiRedacted: true,
        redactedText: combinedRedactedText
      },
      {
        clarificationRound: session.clarificationRound,
        existingKnownFacts: session.knownFacts,
        latestAnswerText:
          session.clarificationRound > 0 ? session.messages.at(-1)?.redactedText : undefined,
        pendingFields: session.missingFields
      }
    );
  }

  applyAnalysis(session, analysis) {
    session.status = analysis.status;
    session.legalDomain = analysis.legalDomain;
    session.legalDomainLabel = analysis.legalDomainLabel;
    session.knownFacts = analysis.knownFacts ?? session.knownFacts;
    session.missingFields = analysis.missingFields ?? [];
    session.questions = analysis.questions ?? [];
    session.error = analysis.error;
  }

  retrieveLawReferences(session) {
    if (session.status !== 'information_ready') {
      session.lawRetrievalStatus = 'not_run';
      session.lawReferences = [];
      session.lawCorpus = undefined;
      session.lawRetrievalError = undefined;
      return { trace: [] };
    }

    const plan = planLawRetrieval({
      legalDomain: session.legalDomain,
      knownFacts: session.knownFacts
    });
    if (!plan.eligible) {
      session.lawRetrievalStatus = 'no_match';
      session.lawReferences = [];
      session.lawCorpus = undefined;
      session.lawRetrievalError = undefined;
      return {
        trace: [
          ...plan.trace,
          safeEvent('v0.law.retrieval.completed', {
            status: 'no_match',
            legalDomain: session.legalDomain,
            resultCount: 0,
            reason: 'no_safe_structured_topic'
          })
        ]
      };
    }

    try {
      const retrieval = this.lawRetriever.search({
        legalDomain: plan.legalDomain,
        topics: plan.topics,
        limit: 3
      });
      const validStatus = ['matched', 'no_match'].includes(retrieval?.status);
      const validResults = Array.isArray(retrieval?.results);
      const statusMatchesCount =
        validResults &&
        ((retrieval.status === 'matched' && retrieval.results.length > 0) ||
          (retrieval.status === 'no_match' && retrieval.results.length === 0));
      const sameDomain =
        validResults &&
        retrieval.results.every((reference) => reference.legalDomain === session.legalDomain);
      if (!validStatus || !statusMatchesCount || !sameDomain) {
        throw new Error('Invalid law retrieval result.');
      }
      session.lawRetrievalStatus = retrieval.status;
      session.lawReferences = retrieval.results;
      session.lawCorpus = {
        id: retrieval.corpusId,
        version: retrieval.corpusVersion,
        verifiedAt: retrieval.corpusVerifiedAt,
        retrievalMode: retrieval.retrievalMode
      };
      session.lawRetrievalError = undefined;
      return { trace: [...plan.trace, ...retrieval.trace] };
    } catch {
      session.lawRetrievalStatus = 'failed';
      session.lawReferences = [];
      session.lawCorpus = undefined;
      session.lawRetrievalError = {
        code: V0_ERROR_CODES.LAW_RETRIEVAL_FAILED,
        message: '法规检索不可用，未生成候选法规引用。'
      };
      return {
        trace: [
          ...plan.trace,
          safeEvent('v0.law.retrieval.failed', {
            code: V0_ERROR_CODES.LAW_RETRIEVAL_FAILED,
            legalDomain: session.legalDomain
          })
        ]
      };
    }
  }

  compareLawReferences(session) {
    if (session.lawRetrievalStatus === 'no_match') {
      session.lawComparisonStatus = 'no_reference';
      session.lawComparisons = [];
      session.lawComparisonError = undefined;
      return { trace: [] };
    }
    if (session.lawRetrievalStatus !== 'matched') {
      session.lawComparisonStatus = 'not_run';
      session.lawComparisons = [];
      session.lawComparisonError = undefined;
      return { trace: [] };
    }

    try {
      const comparison = this.lawComparator({
        piiRedacted: true,
        legalDomain: session.legalDomain,
        knownFacts: session.knownFacts,
        redactedMessages: session.messages.map((message) => message.redactedText),
        lawReferences: session.lawReferences
      });
      const referenceIds = new Set(session.lawReferences.map((reference) => reference.id));
      const comparisonStatuses = new Set([
        'potential_match',
        'not_supported_by_facts',
        'insufficient_for_comparison'
      ]);
      const allowedKeys = new Set([
        'comparisonId',
        'lawReferenceId',
        'legalDomain',
        'comparisonStatus',
        'sanitizedFactExcerpt',
        'matchedFacts',
        'unresolvedElements',
        'comparisonMethod',
        'legalConclusionGenerated'
      ]);
      const elementCodePattern = /^(?:(?:missing_fact|fact_not_supporting):)?[a-z][a-z0-9_]*$/;
      const redactedConversation = session.messages
        .map((message) => message.redactedText)
        .join('\n');
      const validComparisons =
        comparison?.status === 'completed' &&
        Array.isArray(comparison.comparisons) &&
        comparison.comparisons.length === session.lawReferences.length &&
        comparison.comparisons.every(
          (item) =>
            item &&
            Object.keys(item).every((key) => allowedKeys.has(key)) &&
            Object.keys(item).length === allowedKeys.size &&
            referenceIds.has(item.lawReferenceId) &&
            item.comparisonId === `${item.lawReferenceId}:comparison` &&
            item.legalDomain === session.legalDomain &&
            comparisonStatuses.has(item.comparisonStatus) &&
            typeof item.sanitizedFactExcerpt === 'string' &&
            item.sanitizedFactExcerpt.length <= 300 &&
            (item.sanitizedFactExcerpt === '' ||
              item.sanitizedFactExcerpt
                .split(/(?<=[。！？!?；;])\s+/u)
                .filter(Boolean)
                .every((part) => redactedConversation.includes(part))) &&
            Array.isArray(item.matchedFacts) &&
            item.matchedFacts.every(
              (fact) =>
                fact &&
                Object.keys(fact).length === 2 &&
                Object.hasOwn(session.knownFacts, fact.field) &&
                fact.value === session.knownFacts[fact.field]
            ) &&
            Array.isArray(item.unresolvedElements) &&
            item.unresolvedElements.every(
              (element) => typeof element === 'string' && elementCodePattern.test(element)
            ) &&
            item.comparisonMethod === COMPARISON_METHOD &&
            item.legalConclusionGenerated === false
        );
      const uniqueComparisonIds = new Set(
        comparison?.comparisons?.map((item) => item.lawReferenceId) ?? []
      );
      if (!validComparisons || uniqueComparisonIds.size !== session.lawReferences.length) {
        throw new Error('Invalid law comparison result.');
      }
      session.lawComparisonStatus = 'completed';
      session.lawComparisons = comparison.comparisons;
      session.lawComparisonError = undefined;
      return {
        trace: [
          safeEvent('v0.law.comparison.completed', {
            legalDomain: session.legalDomain,
            comparisonCount: comparison.comparisons.length,
            potentialMatchCount: comparison.comparisons.filter(
              (item) => item.comparisonStatus === 'potential_match'
            ).length,
            method: COMPARISON_METHOD
          })
        ]
      };
    } catch {
      session.lawComparisonStatus = 'failed';
      session.lawComparisons = [];
      session.lawComparisonError = {
        code: V0_ERROR_CODES.LAW_COMPARISON_FAILED,
        message: '事实与法条比对不可用，未生成逐条匹配结果。'
      };
      return {
        trace: [
          safeEvent('v0.law.comparison.failed', {
            code: V0_ERROR_CODES.LAW_COMPARISON_FAILED,
            legalDomain: session.legalDomain
          })
        ]
      };
    }
  }

  buildResultCards(session) {
    if (session.lawComparisonStatus === 'no_reference') {
      session.resultCardStatus = 'no_match';
      session.resultCards = [];
      session.resultCardError = undefined;
      return { trace: [] };
    }
    if (session.lawComparisonStatus !== 'completed') {
      session.resultCardStatus = 'not_run';
      session.resultCards = [];
      session.resultCardError = undefined;
      return { trace: [] };
    }

    try {
      const built = this.resultCardBuilder({
        piiRedacted: true,
        legalDomain: session.legalDomain,
        lawReferences: session.lawReferences,
        lawComparisons: session.lawComparisons
      });
      const referencesById = new Map(
        session.lawReferences.map((reference) => [reference.id, reference])
      );
      const comparisonsByReferenceId = new Map(
        session.lawComparisons.map((comparison) => [comparison.lawReferenceId, comparison])
      );
      const potentialMatchCount = session.lawComparisons.filter(
        (comparison) => comparison.comparisonStatus === 'potential_match'
      ).length;
      const allowedKeys = new Set([
        'cardId',
        'findingStatus',
        'findingLabel',
        'userExcerpt',
        'lawReferenceId',
        'lawName',
        'articleNumber',
        'articleText',
        'articleTextSha256',
        'lawVersionDate',
        'officialSource',
        'unresolvedElements',
        'legalConclusionGenerated'
      ]);
      const validCards =
        ['completed', 'no_match'].includes(built?.status) &&
        Array.isArray(built.resultCards) &&
        built.resultCards.length === potentialMatchCount &&
        ((built.status === 'completed' && built.resultCards.length > 0) ||
          (built.status === 'no_match' && built.resultCards.length === 0)) &&
        built.disclaimer === RESULT_CARD_DISCLAIMER &&
        built.resultCards.every((card) => {
          const reference = referencesById.get(card.lawReferenceId);
          const comparison = comparisonsByReferenceId.get(card.lawReferenceId);
          return (
            reference &&
            comparison?.comparisonStatus === 'potential_match' &&
            Object.keys(card).length === allowedKeys.size &&
            Object.keys(card).every((key) => allowedKeys.has(key)) &&
            card.cardId === `${comparison.comparisonId}:result-card` &&
            card.findingStatus === 'potential_match' &&
            card.findingLabel === RESULT_CARD_FINDING_LABEL &&
            card.userExcerpt === comparison.sanitizedFactExcerpt &&
            card.lawName === reference.lawName &&
            card.articleNumber === reference.articleNumber &&
            card.articleText === reference.articleText &&
            card.articleTextSha256 === reference.articleTextSha256 &&
            card.lawVersionDate === reference.effectiveDate &&
            card.officialSource?.authority === reference.source.textAuthority &&
            card.officialSource?.url === reference.source.textUrl &&
            Object.keys(card.officialSource).length === 2 &&
            JSON.stringify(card.unresolvedElements) ===
              JSON.stringify(comparison.unresolvedElements) &&
            card.legalConclusionGenerated === false
          );
        });
      const uniqueReferenceIds = new Set(
        built?.resultCards?.map((card) => card.lawReferenceId) ?? []
      );
      if (!validCards || uniqueReferenceIds.size !== built.resultCards.length) {
        throw new Error('Invalid legal result card output.');
      }

      session.resultCardStatus = built.status;
      session.resultCards = built.resultCards;
      session.resultCardError = undefined;
      if (built.status === 'completed') {
        session.status = 'completed';
      }
      return {
        trace: [
          safeEvent('v0.legal-result-card.built', {
            legalDomain: session.legalDomain,
            resultCardCount: built.resultCards.length,
            status: built.status
          })
        ]
      };
    } catch {
      session.resultCardStatus = 'failed';
      session.resultCards = [];
      session.resultCardError = {
        code: V0_ERROR_CODES.RESULT_CARD_BUILD_FAILED,
        message: '法律自检结果卡片生成失败，未输出未经验证的结果。'
      };
      return {
        trace: [
          safeEvent('v0.legal-result-card.failed', {
            code: V0_ERROR_CODES.RESULT_CARD_BUILD_FAILED,
            legalDomain: session.legalDomain
          })
        ]
      };
    }
  }

  sessionError(sessionId, code, message) {
    return {
      sessionId,
      status: 'failed',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      error: { code, message },
      trace: [safeEvent('v0.session.rejected', { code })]
    };
  }
}

module.exports = {
  OWNER_HISTORY_ERASURE_PHRASE,
  TERMINAL_STATUSES,
  LegalSelfCheckConversationService
};
