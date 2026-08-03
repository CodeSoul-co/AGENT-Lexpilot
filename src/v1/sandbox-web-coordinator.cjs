const { randomUUID } = require('node:crypto');

const MAX_PENDING_SANDBOX_PLANS = 8;
const SANDBOX_PLAN_TTL_MS = 10 * 60 * 1000;

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

function createSandboxWebCoordinator(options = {}) {
  const runtime = options.sandboxRuntime;
  requireRuntime(runtime);
  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date().toISOString());
  const planTtlMs = options.planTtlMs ?? SANDBOX_PLAN_TTL_MS;
  if (!Number.isInteger(planTtlMs) || planTtlMs < 1) throw new TypeError('planTtlMs must be a positive integer.');
  const pending = new Map();

  return Object.freeze({
    describe() {
      return {
        available: true,
        ...runtime.describe(),
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
      const planned = await runtime.plan({ ...input, runId, sessionId });
      const record = { invocationId: planned.invocationId, runId };
      record.expirationTimer = setTimeout(() => {
        if (pending.get(planId) !== record) return;
        pending.delete(planId);
        Promise.resolve(runtime.reject(record)).catch(() => {});
      }, planTtlMs);
      record.expirationTimer.unref?.();
      pending.set(planId, record);
      return {
        status: planned.status,
        planId,
        executionAttempted: false,
        plan: planned.plan
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
        return runtime.reject(record);
      }
      return runtime.approve({ ...record, approvedAt: clock() });
    }
  });
}

module.exports = {
  MAX_PENDING_SANDBOX_PLANS,
  SANDBOX_PLAN_TTL_MS,
  createSandboxWebCoordinator
};
