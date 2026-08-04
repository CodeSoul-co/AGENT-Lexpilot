const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const { createSandboxWebCoordinator } = require('../src/v1/sandbox-web-coordinator.cjs');

const AUDIT_ACTOR_ID = `actor-hmac-sha256-${'a'.repeat(64)}`;

function scriptHash(script) {
  return `sha256:${createHash('sha256').update(script).digest('hex')}`;
}

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

test('appends Sandbox plan and execution receipts to the shared immutable log', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-audit-log-test-'));
  const filePath = path.join(directory, 'execution-log.jsonl');
  const privateScript = 'print("private-script-value")';
  let nowCall = 0;
  const log = createDemoExecutionLog({ filePath });
  const coordinator = createSandboxWebCoordinator({
    executionLog: log,
    auditActorId: AUDIT_ACTOR_ID,
    idFactory: () => 'audit-plan-1',
    clock: () => '2026-08-04T08:00:00.000Z',
    now: () => [100, 137][nowCall++],
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `lexpilot-sandbox.${input.runId}`,
        plan: {
          language: input.language,
          scriptSha256: scriptHash(input.script),
          planHash: `sha256:${'c'.repeat(64)}`,
          inputFileCount: input.inputFiles.length,
          inputBytes: 0,
          requiresConfirmation: true
        }
      }),
      approve: async () => ({
        status: 'completed',
        executionAttempted: true,
        result: {
          generatedArtifactRefs: ['artifact:generated'],
          providerReceipt: { providerId: 'docker-sandbox-provider' },
          cleanupEvidence: {
            executionContainerAbsent: true,
            processTreeTerminationVerified: true
          },
          resourceEvidence: { accountingMode: 'docker-stats' }
        },
        governanceReceipt: { eventCount: 7 }
      }),
      reject: async () => ({ status: 'rejected', executionAttempted: false })
    }
  });

  try {
    const planned = await coordinator.plan({
      language: 'python',
      script: privateScript,
      inputFiles: []
    });
    const completed = await coordinator.confirm(planned.planId, { confirmed: true });
    const records = log.list();
    const planRecord = records.find((record) => record.operationType === 'sandbox_plan');
    const executionRecord = records.find(
      (record) => record.operationType === 'sandbox_execute'
    );

    assert.equal(planned.executionLogId, planRecord.entryId);
    assert.equal(completed.executionLogId, executionRecord.entryId);
    assert.equal(executionRecord.actorId, AUDIT_ACTOR_ID);
    assert.equal(executionRecord.scriptSha256, scriptHash(privateScript));
    assert.equal(executionRecord.durationMs, 37);
    assert.equal(executionRecord.generatedArtifactCount, 1);
    assert.equal(executionRecord.sandboxCleanupVerified, true);
    assert.equal(executionRecord.processTreeTerminationVerified, true);
    assert.equal(executionRecord.governanceEventCount, 7);
    assert.equal(log.verifyIntegrity().recordCount, 2);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(privateScript), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed and releases Human Review when the Sandbox plan log cannot append', async () => {
  const calls = [];
  const coordinator = createSandboxWebCoordinator({
    auditActorId: AUDIT_ACTOR_ID,
    executionLog: {
      append() {
        throw new Error('private storage error');
      },
      verifyIntegrity() {
        return { status: 'unavailable' };
      }
    },
    idFactory: () => 'audit-failure-plan',
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `lexpilot-sandbox.${input.runId}`,
        plan: {
          language: 'python',
          scriptSha256: `sha256:${'d'.repeat(64)}`,
          inputFileCount: 0,
          inputBytes: 0
        }
      }),
      approve: async () => ({ status: 'completed' }),
      reject: async (input) => calls.push(input.runId)
    }
  });

  await assert.rejects(
    coordinator.plan({ language: 'python', script: 'print(1)', inputFiles: [] }),
    (error) => error.code === 'AUDIT_LOG_WRITE_FAILED' && !error.message.includes('private storage')
  );
  assert.deepEqual(calls, ['sandbox-run-audit-failure-plan']);
});

test('records rejected Sandbox confirmation without starting execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-reject-log-test-'));
  const log = createDemoExecutionLog({ filePath: path.join(directory, 'execution-log.jsonl') });
  let approved = false;
  const coordinator = createSandboxWebCoordinator({
    executionLog: log,
    auditActorId: AUDIT_ACTOR_ID,
    idFactory: () => 'reject-plan',
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `lexpilot-sandbox.${input.runId}`,
        plan: {
          language: 'shell',
          scriptSha256: `sha256:${'e'.repeat(64)}`,
          inputFileCount: 0,
          inputBytes: 0
        }
      }),
      approve: async () => {
        approved = true;
        return { status: 'completed' };
      },
      reject: async () => ({
        status: 'rejected',
        executionAttempted: false,
        governanceReceipt: { eventCount: 4 }
      })
    }
  });

  try {
    const planned = await coordinator.plan({ language: 'shell', script: 'printf private', inputFiles: [] });
    const rejected = await coordinator.confirm(planned.planId, { confirmed: false });
    const record = log.list().find((entry) => entry.operationType === 'sandbox_reject');
    assert.equal(rejected.status, 'rejected');
    assert.equal(approved, false);
    assert.equal(record.executionAttempted, false);
    assert.equal(record.humanReviewStatus, 'rejected');
    assert.equal(record.governanceEventCount, 4);
    assert.equal(log.verifyIntegrity().recordCount, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('records a structured failure when approved Sandbox execution throws', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-failure-log-test-'));
  const filePath = path.join(directory, 'execution-log.jsonl');
  const log = createDemoExecutionLog({ filePath });
  let nowCall = 0;
  const coordinator = createSandboxWebCoordinator({
    executionLog: log,
    auditActorId: AUDIT_ACTOR_ID,
    idFactory: () => 'throwing-plan',
    now: () => [100, 125][nowCall++],
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `lexpilot-sandbox.${input.runId}`,
        plan: {
          language: 'python',
          scriptSha256: `sha256:${'f'.repeat(64)}`,
          inputFileCount: 0,
          inputBytes: 0
        }
      }),
      approve: async () => {
        throw new Error('private provider failure');
      },
      reject: async () => ({ status: 'rejected' })
    }
  });

  try {
    const planned = await coordinator.plan({ language: 'python', script: 'print(1)', inputFiles: [] });
    await assert.rejects(
      coordinator.confirm(planned.planId, { confirmed: true }),
      (error) => error.code === 'SANDBOX_EXECUTION_FAILED' && !error.message.includes('provider')
    );
    const record = log.list().find((entry) => entry.operationType === 'sandbox_execute');
    assert.equal(record.status, 'failed');
    assert.equal(record.executionAttempted, true);
    assert.equal(record.durationMs, 25);
    assert.equal(record.errorCode, 'SANDBOX_EXECUTION_FAILED');
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('private provider failure'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withholds an executed Sandbox result when the terminal log append fails', async () => {
  let appendCount = 0;
  let executionCompleted = false;
  const coordinator = createSandboxWebCoordinator({
    auditActorId: AUDIT_ACTOR_ID,
    executionLog: {
      append() {
        appendCount += 1;
        if (appendCount === 1) return { entryId: 'plan-log-id' };
        throw new Error('private terminal log failure');
      },
      verifyIntegrity() {
        return { status: 'verified' };
      }
    },
    idFactory: () => 'terminal-log-failure-plan',
    sandboxRuntime: {
      describe: () => ({ runtime: 'mock-sandbox' }),
      plan: async (input) => ({
        status: 'awaiting_confirmation',
        invocationId: `lexpilot-sandbox.${input.runId}`,
        plan: {
          language: 'python',
          scriptSha256: `sha256:${'1'.repeat(64)}`,
          inputFileCount: 0,
          inputBytes: 0
        }
      }),
      approve: async () => {
        executionCompleted = true;
        return {
          status: 'completed',
          executionAttempted: true,
          result: { generatedArtifactRefs: ['artifact:private-result'] }
        };
      },
      reject: async () => ({ status: 'rejected' })
    }
  });

  const planned = await coordinator.plan({ language: 'python', script: 'print(1)', inputFiles: [] });
  await assert.rejects(
    coordinator.confirm(planned.planId, { confirmed: true }),
    (error) => error.code === 'AUDIT_LOG_WRITE_FAILED' && !error.message.includes('terminal')
  );
  assert.equal(executionCompleted, true);
  assert.equal(appendCount, 2);
});
