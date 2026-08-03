const assert = require('node:assert/strict');
const test = require('node:test');
const { createSandboxWebCoordinator } = require('../src/v1/sandbox-web-coordinator.cjs');

function fixture() {
  const calls = [];
  const runtime = {
    describe() {
      return { runtime: 'mock-sandbox', policy: { network: 'disabled' } };
    },
    async plan(input) {
      calls.push(['plan', input]);
      return {
        status: 'awaiting_confirmation',
        invocationId: `invocation-${input.runId}`,
        plan: {
          language: input.language,
          scriptSha256: 'sha256:safe',
          inputFiles: [],
          requiresConfirmation: true
        }
      };
    },
    async approve(input) {
      calls.push(['approve', input]);
      return { status: 'completed', executionAttempted: true, result: { generatedArtifactRefs: [] } };
    },
    async reject(input) {
      calls.push(['reject', input]);
      return { status: 'rejected', executionAttempted: false };
    }
  };
  const coordinator = createSandboxWebCoordinator({
    sandboxRuntime: runtime,
    idFactory: () => 'plan-1',
    clock: () => '2026-08-03T10:00:00.000Z'
  });
  return { calls, coordinator };
}

test('Sandbox Web coordinator creates a safe plan and executes only after confirmation', async () => {
  const { calls, coordinator } = fixture();
  const script = 'print("private-value")';
  const planned = await coordinator.plan({ language: 'python', script, inputFiles: [] });
  assert.equal(planned.planId, 'plan-1');
  assert.equal(planned.executionAttempted, false);
  assert.equal(JSON.stringify(planned).includes(script), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'plan');

  const completed = await coordinator.confirm('plan-1', { confirmed: true });
  assert.equal(completed.status, 'completed');
  assert.equal(calls[1][0], 'approve');
  assert.equal(calls[1][1].approvedAt, '2026-08-03T10:00:00.000Z');
  await assert.rejects(
    coordinator.confirm('plan-1', { confirmed: true }),
    (error) => error.code === 'SANDBOX_PLAN_NOT_FOUND'
  );
});

test('Sandbox Web coordinator rejection never approves and consumes the pending plan', async () => {
  const { calls, coordinator } = fixture();
  await coordinator.plan({ language: 'shell', script: 'printf ok', inputFiles: [] });
  const rejected = await coordinator.confirm('plan-1', { confirmed: false });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(calls.map((call) => call[0]), ['plan', 'reject']);
  await assert.rejects(
    coordinator.confirm('plan-1', { confirmed: false }),
    (error) => error.code === 'SANDBOX_PLAN_NOT_FOUND'
  );
});

test('Sandbox Web coordinator fails closed on malformed confirmations', async () => {
  const { coordinator } = fixture();
  await coordinator.plan({ language: 'python', script: 'print(1)', inputFiles: [] });
  await assert.rejects(coordinator.confirm('plan-1', { confirmed: 'yes' }), /boolean/);
  await assert.rejects(coordinator.confirm('../plan-1', { confirmed: true }), /invalid/);
});

test('unconfirmed Sandbox plans expire and release the governed invocation', async () => {
  const calls = [];
  const coordinator = createSandboxWebCoordinator({
    idFactory: () => 'expiring-plan',
    planTtlMs: 10,
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `invocation-${input.runId}`,
        plan: { requiresConfirmation: true }
      }),
      approve: async () => ({ status: 'completed' }),
      reject: async (input) => calls.push(input.runId)
    }
  });
  await coordinator.plan({ language: 'python', script: 'print(1)', inputFiles: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, ['sandbox-run-expiring-plan']);
  await assert.rejects(
    coordinator.confirm('expiring-plan', { confirmed: true }),
    (error) => error.code === 'SANDBOX_PLAN_NOT_FOUND'
  );
});
