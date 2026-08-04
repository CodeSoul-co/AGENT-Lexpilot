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
const {
  DEFAULT_OUTPUT_FORMATS,
  PROFESSIONAL_QUERY_TASK_SCHEMA,
  ProfessionalQueryTaskInputError,
  createProfessionalQueryTaskInput,
  createProfessionalQueryTaskReceipt,
  restoreProfessionalQueryTaskInput
} = require('../src/v1/professional-query-task-input.cjs');

const QUERY = '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。';

function startRequest(requestedOutputFormats) {
  return {
    userText: QUERY,
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION,
    ...(requestedOutputFormats ? { requestedOutputFormats } : {})
  };
}

function createCapturedService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-task-input-test-'));
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
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'v1-task-input-owner',
    idFactory: () => 'session-task-input-001',
    clock: () => '2026-08-04T10:00:00.000Z',
    autoCleanup: false,
    v1Runtime: runtime,
    executionLog: createDemoExecutionLog({
      filePath: path.join(directory, 'execution-log.jsonl')
    })
  });
  return {
    service,
    calls,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

test('builds the required V1 TaskSchema fields from redacted query and fixed runtime context', () => {
  const input = createProfessionalQueryTaskInput({
    piiRedacted: true,
    query: QUERY,
    sessionId: 'session-task-input-001',
    dataSourceId: 'demo.labor_cases',
    requestedOutputFormats: ['pdf', 'table']
  });
  const receipt = createProfessionalQueryTaskReceipt(input);

  assert.deepEqual(input, {
    schema: PROFESSIONAL_QUERY_TASK_SCHEMA,
    query: QUERY,
    data_source_id: 'demo.labor_cases',
    workspace_id: 'query-workspace-8cc230d5741b3bc5e20f6db892bcd772',
    requested_output_formats: ['table', 'pdf']
  });
  assert.equal(Object.isFrozen(input), true);
  assert.deepEqual(receipt.requestedOutputFormats, ['table', 'pdf']);
  assert.deepEqual(receipt.effectiveOutputFormats, DEFAULT_OUTPUT_FORMATS);
  assert.equal(receipt.queryRedacted, true);
  assert.equal(receipt.queryStoredInReceipt, false);
  assert.equal(receipt.workspaceKind, 'logical-query-session');
  assert.equal(receipt.workspacePathExposed, false);
  assert.equal(JSON.stringify(receipt).includes(QUERY), false);
  assert.equal(JSON.stringify(receipt).includes('session-task-input-001'), false);
  assert.deepEqual(restoreProfessionalQueryTaskInput(receipt, QUERY), input);
});

test('refuses raw, unsupported, duplicate, or path-shaped task selectors', () => {
  const base = {
    piiRedacted: true,
    query: QUERY,
    sessionId: 'session-task-input-001',
    dataSourceId: 'demo.labor_cases'
  };
  const invalidOptions = [
    { ...base, piiRedacted: false },
    { ...base, dataSourceId: 'C:\\private\\cases.sqlite' },
    { ...base, requestedOutputFormats: ['table', 'table'] },
    { ...base, requestedOutputFormats: ['csv'] },
    { ...base, sessionId: '' }
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => createProfessionalQueryTaskInput(options),
      (error) => error instanceof ProfessionalQueryTaskInputError
    );
  }
});

test('wires one task receipt through plan and confirmation without storing query text in it', () => {
  const { service, calls, cleanup } = createCapturedService();
  try {
    const planned = service.start(startRequest(['table', 'pdf']));
    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.v1.taskInput.schema, PROFESSIONAL_QUERY_TASK_SCHEMA);
    assert.equal(planned.v1.taskInput.dataSourceId, 'demo.labor_cases');
    assert.deepEqual(planned.v1.taskInput.requestedOutputFormats, ['table', 'pdf']);
    assert.equal(JSON.stringify(planned.v1.taskInput).includes(QUERY), false);
    assert.equal(calls[0][0], 'plan');
    assert.equal(calls[0][1].taskInput.query, QUERY);
    assert.equal(calls[0][1].taskInput.data_source_id, 'demo.labor_cases');
    assert.equal(
      calls[0][1].taskInput.workspace_id,
      planned.v1.taskInput.workspaceId
    );

    const completed = service.confirmV1Execution(planned.sessionId, { confirmed: true });
    assert.equal(completed.status, 'completed');
    assert.equal(calls[1][0], 'execute');
    assert.deepEqual(calls[1][1].taskInput, calls[0][1].taskInput);
    assert.equal(completed.v1.taskInput.workspacePathExposed, false);
  } finally {
    cleanup();
  }
});

test('fails closed before execution when the persisted TaskSchema receipt is extended or drifts', () => {
  const { service, calls, cleanup } = createCapturedService();
  try {
    const planned = service.start(startRequest());
    const stored = service.getSession(planned.sessionId);
    stored.v1.taskInput = {
      ...stored.v1.taskInput,
      workspaceId: 'query-workspace-00000000000000000000000000000000',
      injectedPath: 'C:\\private\\cases.sqlite'
    };
    service.store.save(stored, 'v1-task-input-owner');

    const rejected = service.confirmV1Execution(planned.sessionId, { confirmed: true });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.v1.status, 'failed');
    assert.match(rejected.v1.reason, /TaskSchema/);
    assert.equal(rejected.v1.result, null);
    assert.equal(calls.filter(([operation]) => operation === 'execute').length, 0);
    assert.equal(JSON.stringify(rejected).includes('C:\\private'), false);
  } finally {
    cleanup();
  }
});

test('does not accept V1 output selectors on a V0 legal self-check', () => {
  const service = new LegalSelfCheckConversationService({ autoCleanup: false });
  const result = service.start({
    userText: '老板让我明天不用来了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION,
    requestedOutputFormats: ['table']
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'INVALID_USER_TEXT');
  assert.equal(service.store.count(), 0);
});
