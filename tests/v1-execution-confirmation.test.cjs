const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION, V0_ERROR_CODES } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const { createV1DemoQueryRuntime } = require('../src/v1/demo-query-runtime.cjs');

const PROFESSIONAL_QUERY_TEXT = '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。';
const WRITE_QUERY_TEXT = '删除案例库中的全部数据';

function runtimeInput(redactedText) {
  return {
    runId: 'run-v1-confirmation',
    sessionId: 'session-v1-confirmation',
    ownerId: 'test-owner',
    piiRedacted: true,
    redactedText,
    clarificationRound: 0,
    knownFacts: {}
  };
}

function createService({ withExecutionLog = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-confirmation-test-'));
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'v1-confirmation-test',
    idFactory: () => 'v1-session-1',
    clock: () => '2026-07-21T03:00:00.000Z',
    autoCleanup: false,
    v1Runtime: createV1DemoQueryRuntime(),
    executionLog: withExecutionLog
      ? createDemoExecutionLog({ filePath: path.join(directory, 'v1-execution-log.jsonl') })
      : undefined
  });
  return {
    service,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

function startRequest(userText) {
  return {
    userText,
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  };
}

test('runtime plan presents a verified read-only plan without executing', () => {
  const runtime = createV1DemoQueryRuntime();
  const planned = runtime.plan(runtimeInput(PROFESSIONAL_QUERY_TEXT));

  assert.equal(planned.status, 'awaiting_confirmation');
  assert.equal(planned.executionAttempted, false);
  assert.equal(planned.plan.status, 'verified');
  assert.equal(planned.plan.readOnly, true);
  assert.equal(planned.plan.schemaVerified, true);
  assert.equal(planned.plan.requiresConfirmation, true);
  assert.match(planned.plan.sql, /^SELECT/);
  assert.equal(planned.result, undefined);
  assert.equal(planned.chart, undefined);
  assert.equal(planned.artifact, undefined);
  assert.deepEqual(
    planned.trace.map((event) => event.type),
    ['v1.schema.loaded', 'v1.query.plan.verified', 'v1.query.plan.awaiting_confirmation']
  );
});

test('runtime execute records the confirmation and returns the full result', () => {
  const runtime = createV1DemoQueryRuntime();
  const planned = runtime.plan(runtimeInput(PROFESSIONAL_QUERY_TEXT));
  const executed = runtime.execute({
    ...runtimeInput(PROFESSIONAL_QUERY_TEXT),
    expectedPlanHash: planned.plan.planHash,
    expectedSchemaFingerprint: planned.plan.schemaFingerprint
  });

  assert.equal(executed.status, 'completed');
  assert.equal(executed.result.rows.length, 3);
  assert.equal(executed.chart.type, 'bar');
  assert.equal(executed.artifact.type, 'analysis-document');
  assert.equal(executed.plan.requiresConfirmation, true);
  const confirmationEvents = executed.trace.filter(
    (event) => event.type === 'v1.query.confirmation.recorded'
  );
  assert.equal(confirmationEvents.length, 1);
  assert.deepEqual(confirmationEvents[0].data, { confirmed: true });
});

test('write operations are rejected by plan, execute, and run without executing', async () => {
  const runtime = createV1DemoQueryRuntime();
  for (const result of [
    runtime.plan(runtimeInput(WRITE_QUERY_TEXT)),
    runtime.execute(runtimeInput(WRITE_QUERY_TEXT)),
    await runtime.run(runtimeInput(WRITE_QUERY_TEXT))
  ]) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.executionAttempted, false);
    assert.equal(result.safety.writeAttempted, true);
  }
});

test('runtime rejects confirmation when the stored plan or schema fingerprint drifts', () => {
  const runtime = createV1DemoQueryRuntime();
  const planned = runtime.plan(runtimeInput(PROFESSIONAL_QUERY_TEXT));
  const drifted = runtime.execute({
    ...runtimeInput(PROFESSIONAL_QUERY_TEXT),
    expectedPlanHash: `${planned.plan.planHash.slice(0, -1)}0`,
    expectedSchemaFingerprint: planned.plan.schemaFingerprint
  });
  assert.equal(drifted.status, 'rejected');
  assert.equal(drifted.executionAttempted, false);
  assert.match(drifted.reason, /发生变化/);
  assert.equal(drifted.trace[0].type, 'v1.query.plan-drift.rejected');
});

test('first V1 submission stores an awaiting_confirmation plan and refuses answers', () => {
  const { service, cleanup } = createService();
  try {
    const result = service.start(startRequest(PROFESSIONAL_QUERY_TEXT));

    assert.equal(result.status, 'awaiting_confirmation');
    assert.equal(result.taskType, 'professional_data_query');
    assert.equal(result.v1.status, 'awaiting_confirmation');
    assert.match(result.v1.plan.sql, /^SELECT/);
    assert.equal(result.v1.plan.requiresConfirmation, true);
    assert.equal(result.v1.result, null);
    assert.equal(result.v1.chart, null);
    assert.equal(result.v1.artifact, null);

    const stored = service.getSession(result.sessionId);
    assert.equal(stored.status, 'awaiting_confirmation');
    assert.equal(stored.v1.plan.readOnly, true);
    assert.equal(JSON.stringify(stored.v1).includes(PROFESSIONAL_QUERY_TEXT), false);
    assert.equal(JSON.stringify(result.trace).includes('胜诉率'), false);

    const lateAnswer = service.answer(result.sessionId, '继续执行查询。');
    assert.equal(lateAnswer.error.code, V0_ERROR_CODES.SESSION_NOT_ACCEPTING_INPUT);
    const logs = service.listV1ExecutionLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].operationType, 'plan');
    assert.equal(logs[0].status, 'awaiting_confirmation');
    assert.equal(result.v1.planLogId, logs[0].entryId);
  } finally {
    cleanup();
  }
});

test('professional analysis asks only for missing metrics and time before planning', () => {
  const { service, cleanup } = createService();
  try {
    const started = service.start(
      startRequest('请分析案例库中的未签劳动合同案件。')
    );
    assert.equal(started.taskType, 'professional_data_query');
    assert.equal(started.status, 'needs_clarification');
    assert.deepEqual(started.missingFields, ['analysisMetrics', 'analysisTimeRange']);
    assert.deepEqual(
      started.questionContracts.map((question) => question.questionId),
      ['analysis-metrics', 'analysis-time-range']
    );

    const planned = service.answer(started.sessionId, '胜诉率和案件数量，近三年。');
    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.v1.plan.readOnly, true);
    assert.equal(planned.v1.result, null);
    const history = service.getHistory(started.sessionId);
    assert.deepEqual(history.messages.map((message) => message.messageType), [
      'user_input',
      'clarification',
      'user_input',
      'data_plan'
    ]);
  } finally {
    cleanup();
  }
});

test('confirmed execution completes the session and appends an immutable log entry', () => {
  const { service, cleanup } = createService();
  try {
    const started = service.start(startRequest(PROFESSIONAL_QUERY_TEXT));
    const confirmed = service.confirmV1Execution(started.sessionId, { confirmed: true });

    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.v1.status, 'completed');
    assert.equal(confirmed.v1.result.rows.length, 3);
    assert.equal(confirmed.v1.result.matchedCaseCount, 672);
    assert.equal(confirmed.v1.chart.type, 'bar');
    assert.equal(confirmed.v1.artifact.type, 'analysis-document');
    assert.equal(confirmed.v1.confirmedAt, '2026-07-21T03:00:00.000Z');

    const stored = service.getSession(started.sessionId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.v1.result.rowCount, 3);

    const logs = service.listV1ExecutionLogs();
    assert.equal(logs.length, 2);
    const executionLog = logs.find((log) => log.operationType === 'execute');
    assert.equal(executionLog.sessionId, started.sessionId);
    assert.match(executionLog.actorId, /^actor-sha256-[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(logs).includes('v1-confirmation-test'), false);
    assert.equal(executionLog.status, 'completed');
    assert.equal(executionLog.rowCount, 3);
    assert.equal(typeof executionLog.durationMs, 'number');
    assert.match(executionLog.sql, /^SELECT/);
    assert.equal(typeof executionLog.loggedAt, 'string');
    assert.equal(executionLog.planHash, confirmed.v1.plan.planHash);
    assert.equal(executionLog.schemaFingerprint, confirmed.v1.plan.schemaFingerprint);
    assert.equal(executionLog.artifactId, confirmed.v1.artifact.artifactId);
    assert.equal(executionLog.artifactSha256, confirmed.v1.artifact.contentSha256);
    assert.equal(confirmed.v1.executionLogId, executionLog.entryId);
    assert.equal(service.getV1ExecutionLogIntegrity().status, 'verified');

    const repeated = service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(repeated.status, 'failed');
    assert.equal(repeated.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');
    assert.equal(service.listV1ExecutionLogs().length, 2);
  } finally {
    cleanup();
  }
});

test('declined confirmation cancels the session into a terminal state with a log entry', () => {
  const { service, cleanup } = createService();
  try {
    const started = service.start(startRequest(PROFESSIONAL_QUERY_TEXT));
    const cancelled = service.confirmV1Execution(started.sessionId, { confirmed: false });

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.v1.status, 'cancelled');
    assert.equal(cancelled.v1.result, null);
    assert.equal(cancelled.v1.cancelledAt, '2026-07-21T03:00:00.000Z');

    const stored = service.getSession(started.sessionId);
    assert.equal(stored.status, 'cancelled');

    const lateAnswer = service.answer(started.sessionId, '还是帮我查一下。');
    assert.equal(lateAnswer.error.code, V0_ERROR_CODES.SESSION_NOT_ACCEPTING_INPUT);

    const logs = service.listV1ExecutionLogs({ status: 'cancelled' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].operationType, 'cancel');
    assert.equal(logs[0].sessionId, started.sessionId);

    const repeated = service.confirmV1Execution(started.sessionId, { confirmed: true });
    assert.equal(repeated.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');
  } finally {
    cleanup();
  }
});

test('write operations stay rejected at submission and are logged as rejected plans', () => {
  const { service, cleanup } = createService();
  try {
    const result = service.start(startRequest(WRITE_QUERY_TEXT));

    assert.equal(result.status, 'rejected');
    assert.equal(result.v1.status, 'rejected');
    assert.equal(result.v1.plan, null);
    assert.match(result.v1.reason, /只读查询/);

    const stored = service.getSession(result.sessionId);
    assert.equal(stored.status, 'rejected');

    const logs = service.listV1ExecutionLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].operationType, 'plan');
    assert.equal(logs[0].status, 'rejected');
    assert.match(logs[0].error, /只读查询/);

    const confirmed = service.confirmV1Execution(result.sessionId, { confirmed: true });
    assert.equal(confirmed.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');
  } finally {
    cleanup();
  }
});

test('confirmation on unknown or non-V1 sessions is rejected without logging', () => {
  const { service, cleanup } = createService();
  try {
    const missing = service.confirmV1Execution('no-such-session', { confirmed: true });
    assert.equal(missing.error.code, V0_ERROR_CODES.SESSION_NOT_FOUND);

    const v0 = service.start(startRequest('老板让我明天不用来了。'));
    const notV1 = service.confirmV1Execution(v0.sessionId, { confirmed: true });
    assert.equal(notV1.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');
    assert.deepEqual(service.listV1ExecutionLogs(), []);
  } finally {
    cleanup();
  }
});

test('refuses to enable V1 without the mandatory append-only execution log', () => {
  assert.throws(
    () => createService({ withExecutionLog: false }),
    /V1 runtime requires an append-only executionLog/
  );
});

test('withholds an executed result when the audit log cannot be appended', () => {
  let appendCount = 0;
  const executionLog = {
    append(entry) {
      appendCount += 1;
      if (appendCount === 2) throw new Error('disk unavailable');
      return { ...entry, entryId: 'plan-log-1' };
    },
    list() {
      return [];
    },
    verifyIntegrity() {
      return { status: 'verified', recordCount: 1, verifiedCount: 1, legacyCount: 0 };
    }
  };
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'v1-audit-failure-test',
    idFactory: () => 'v1-session-audit-failure',
    clock: () => '2026-07-21T03:00:00.000Z',
    autoCleanup: false,
    v1Runtime: createV1DemoQueryRuntime(),
    executionLog
  });

  const started = service.start(startRequest(PROFESSIONAL_QUERY_TEXT));
  const confirmed = service.confirmV1Execution(started.sessionId, { confirmed: true });
  assert.equal(confirmed.status, 'failed');
  assert.equal(confirmed.v1.status, 'failed');
  assert.match(confirmed.v1.reason, /结果已停止发布/);
  assert.equal(confirmed.v1.result, null);
  assert.equal(confirmed.v1.chart, null);
  assert.equal(confirmed.v1.artifact, null);
  assert.equal(confirmed.trace.at(-1).type, 'v1.execution-log.append.failed');
});

test('withholds an executed result when Artifact Store persistence fails', async () => {
  const executionLog = {
    entries: [],
    append(entry) {
      const stored = { ...entry, entryId: `log-${this.entries.length + 1}` };
      this.entries.push(stored);
      return stored;
    },
    list() {
      return [...this.entries].reverse();
    },
    verifyIntegrity() {
      return { status: 'verified', recordCount: this.entries.length };
    }
  };
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'v1-artifact-failure-test',
    idFactory: () => 'v1-session-artifact-failure',
    clock: () => '2026-08-03T08:00:00.000Z',
    autoCleanup: false,
    v1Runtime: createV1DemoQueryRuntime(),
    executionLog,
    artifactRepository: {
      async storeAnalysisArtifact() {
        throw new Error('private filesystem unavailable');
      }
    }
  });

  const started = service.start(startRequest(PROFESSIONAL_QUERY_TEXT));
  const confirmed = await service.confirmV1Execution(started.sessionId, { confirmed: true });
  assert.equal(confirmed.status, 'failed');
  assert.equal(confirmed.v1.status, 'failed');
  assert.equal(confirmed.v1.result, null);
  assert.equal(confirmed.v1.chart, null);
  assert.equal(confirmed.v1.artifact, null);
  assert.equal(
    confirmed.trace.some((event) => event.type === 'v1.artifact.persistence.failed'),
    true
  );
  assert.equal(executionLog.entries.at(-1).status, 'failed');
});
