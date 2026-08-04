const { randomUUID } = require('node:crypto');
const { requireAuditActorId } = require('./audit-identity.cjs');

const MAX_PENDING_SANDBOX_PLANS = 8;
const SANDBOX_PLAN_TTL_MS = 10 * 60 * 1000;

class SandboxAuditLogError extends Error {
  constructor() {
    super('Sandbox 审计日志写入失败，本次操作已安全停止。');
    this.name = 'SandboxAuditLogError';
    this.code = 'AUDIT_LOG_WRITE_FAILED';
  }
}

class SandboxOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxOperationError';
    this.code = code;
  }
}

function requireRuntime(runtime) {
  for (const method of ['describe', 'plan', 'approve', 'reject']) {
    if (!runtime || typeof runtime[method] !== 'function') {
      throw new TypeError('sandboxRuntime must implement describe, plan, approve, and reject.');
    }
  }
}

function requirePlanId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value)) {
    throw new TypeError('Sandbox plan id is invalid.');
  }
  return value;
}

function requireExecutionLog(executionLog) {
  if (executionLog === null) return;
  if (
    typeof executionLog?.append !== 'function' ||
    typeof executionLog?.verifyIntegrity !== 'function'
  ) {
    throw new TypeError('executionLog must expose append(entry) and verifyIntegrity().');
  }
}

function safeErrorCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)
    ? value
    : fallback;
}

function terminalAuditFields(record, result, durationMs, humanReviewStatus) {
  const output = result?.result;
  const generatedArtifactRefs = Array.isArray(output?.generatedArtifactRefs)
    ? output.generatedArtifactRefs
    : [];
  const resourceAccountingMode =
    typeof output?.resourceEvidence?.accountingMode === 'string'
      ? output.resourceEvidence.accountingMode
      : undefined;
  return {
    ...record.auditFields,
    operationType: humanReviewStatus === 'approved' ? 'sandbox_execute' : 'sandbox_reject',
    status: result?.status ?? 'failed',
    durationMs,
    executionAttempted: result?.executionAttempted === true,
    humanReviewStatus,
    governanceEventCount: result?.governanceReceipt?.eventCount,
    generatedArtifactCount: generatedArtifactRefs.length,
    executionProvider: output?.providerReceipt?.providerId,
    sandboxCleanupVerified:
      output?.cleanupEvidence?.executionContainerAbsent === undefined
        ? undefined
        : output.cleanupEvidence.executionContainerAbsent === true,
    processTreeTerminationVerified:
      output?.cleanupEvidence?.processTreeTerminationVerified === undefined
        ? undefined
        : output.cleanupEvidence.processTreeTerminationVerified === true,
    resourceAccountingMode,
    errorCode:
      result?.status === 'completed'
        ? undefined
        : safeErrorCode(output?.errorCode, 'SANDBOX_EXECUTION_FAILED')
  };
}

function createSandboxWebCoordinator(options = {}) {
  const runtime = options.sandboxRuntime;
  requireRuntime(runtime);
  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date().toISOString());
  const now = options.now ?? Date.now;
  const executionLog = options.executionLog ?? null;
  requireExecutionLog(executionLog);
  const auditActorId =
    executionLog === null ? null : requireAuditActorId(options.auditActorId);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const planTtlMs = options.planTtlMs ?? SANDBOX_PLAN_TTL_MS;
  if (!Number.isInteger(planTtlMs) || planTtlMs < 1) throw new TypeError('planTtlMs must be a positive integer.');
  const pending = new Map();

  function appendAudit(entry) {
    if (executionLog === null) return null;
    try {
      return executionLog.append({ actorId: auditActorId, ...entry });
    } catch {
      throw new SandboxAuditLogError();
    }
  }

  return Object.freeze({
    describe() {
      return {
        available: true,
        ...runtime.describe(),
        auditLog: executionLog === null ? 'unavailable' : 'append-only-sha256-chain',
        pendingPlanLimit: MAX_PENDING_SANDBOX_PLANS,
        pendingPlanTtlMs: planTtlMs
      };
    },
    async plan(input) {
      const planId = requirePlanId(idFactory());
      if (pending.has(planId)) throw new Error('Sandbox plan id collision.');
      if (pending.size >= MAX_PENDING_SANDBOX_PLANS) {
        const error = new Error('Too many Sandbox plans are awaiting confirmation.');
        error.code = 'SANDBOX_PENDING_LIMIT';
        throw error;
      }
      const runId = `sandbox-run-${planId}`;
      const sessionId = `sandbox-session-${planId}`;
      let planned;
      try {
        planned = await runtime.plan({ ...input, runId, sessionId });
      } catch (error) {
        appendAudit({
          sessionId,
          runId,
          operationType: 'sandbox_plan',
          status: 'failed',
          executionAttempted: false,
          humanReviewRequired: true,
          humanReviewStatus: 'not_created',
          errorCode: 'SANDBOX_PLAN_FAILED'
        });
        throw error;
      }
      const record = {
        invocationId: planned.invocationId,
        runId,
        sessionId,
        auditFields: {
          sessionId,
          runId,
          language: planned.plan?.language,
          scriptSha256: planned.plan?.scriptSha256,
          sandboxInvocationId: planned.invocationId,
          planHash: planned.plan?.planHash,
          inputFileCount: planned.plan?.inputFileCount,
          inputBytes: planned.plan?.inputBytes,
          humanReviewRequired: true
        }
      };
      let planLog;
      try {
        planLog = appendAudit({
          ...record.auditFields,
          operationType: 'sandbox_plan',
          status: planned.status,
          executionAttempted: false,
          humanReviewStatus: 'requested'
        });
      } catch (error) {
        try {
          await runtime.reject(record);
        } catch {
          // The audit failure remains authoritative; the runtime rejection was best effort.
        }
        throw error;
      }
      record.expirationTimer = setTimeout(() => {
        if (pending.get(planId) !== record) return;
        pending.delete(planId);
        Promise.resolve(runtime.reject(record))
          .then(
            (result) =>
              appendAudit({
                ...terminalAuditFields(record, result, 0, 'expired'),
                operationType: 'sandbox_expire',
                status: 'expired',
                errorCode: 'SANDBOX_CONFIRMATION_EXPIRED'
              }),
            () =>
              appendAudit({
                ...record.auditFields,
                operationType: 'sandbox_expire',
                status: 'failed',
                executionAttempted: false,
                humanReviewStatus: 'expired',
                errorCode: 'SANDBOX_REJECTION_FAILED'
              })
          )
          .catch(() => {});
      }, planTtlMs);
      record.expirationTimer.unref?.();
      pending.set(planId, record);
      return {
        status: planned.status,
        planId,
        executionAttempted: false,
        plan: planned.plan,
        executionLogId: planLog?.entryId
      };
    },
    async confirm(planId, input) {
      requirePlanId(planId);
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.confirmed !== 'boolean') {
        throw new TypeError('Sandbox confirmation must contain a boolean confirmed field.');
      }
      const record = pending.get(planId);
      if (!record) {
        const error = new Error('Sandbox plan was not found or was already resolved.');
        error.code = 'SANDBOX_PLAN_NOT_FOUND';
        throw error;
      }
      pending.delete(planId);
      clearTimeout(record.expirationTimer);
      if (!input.confirmed) {
        let rejected;
        try {
          rejected = await runtime.reject(record);
        } catch {
          appendAudit({
            ...record.auditFields,
            operationType: 'sandbox_reject',
            status: 'failed',
            durationMs: 0,
            executionAttempted: false,
            humanReviewStatus: 'rejected',
            errorCode: 'SANDBOX_REJECTION_FAILED'
          });
          throw new SandboxOperationError(
            'SANDBOX_REJECTION_FAILED',
            'Sandbox 拒绝处理失败，本次操作未执行。'
          );
        }
        const audit = appendAudit(terminalAuditFields(record, rejected, 0, 'rejected'));
        return { ...rejected, executionLogId: audit?.entryId };
      }
      const startedAt = now();
      let approved;
      try {
        approved = await runtime.approve({ ...record, approvedAt: clock() });
      } catch {
        const durationMs = Math.max(0, Math.round(now() - startedAt));
        appendAudit({
          ...record.auditFields,
          operationType: 'sandbox_execute',
          status: 'failed',
          durationMs,
          executionAttempted: true,
          humanReviewStatus: 'approved',
          errorCode: 'SANDBOX_EXECUTION_FAILED'
        });
        throw new SandboxOperationError(
          'SANDBOX_EXECUTION_FAILED',
          'Sandbox 执行失败，本次结果不会发布。'
        );
      }
      const durationMs = Math.max(0, Math.round(now() - startedAt));
      const audit = appendAudit(terminalAuditFields(record, approved, durationMs, 'approved'));
      return { ...approved, executionLogId: audit?.entryId };
    }
  });
}

module.exports = {
  MAX_PENDING_SANDBOX_PLANS,
  SANDBOX_PLAN_TTL_MS,
  SandboxAuditLogError,
  SandboxOperationError,
  createSandboxWebCoordinator
};
