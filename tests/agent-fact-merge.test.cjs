const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { AgentBackedConversationService } = require('../src/agent/agent-backed-conversation-service.cjs');
const {
  LegalAgentRuntimeError,
  createLegalV0AgentRuntime,
  filterSupplementalModelFacts,
  normalizeAgentInput
} = require('../src/agent/legal-v0-agent-runtime.cjs');
const { createLegalComplianceAgent } = require('../src/agent/legal-compliance-agent.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');

const projectRoot = path.resolve(__dirname, '..');

const START_TEXT = '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。';
const TERSE_ANSWER = '没有，还未结束';
const NOTICE_QUESTION = '公司有没有提前三十天书面告诉您，或者另外多给一个月工资？';
const MEDICAL_PERIOD_QUESTION = '公司规定的看病休养时间是否已经结束？';
const WORK_ARRANGEMENT_QUESTION =
  '休养时间结束后，您是否既做不了原来的工作，也做不了公司另外安排的工作？';

function request(userText) {
  return { userText, privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION };
}

function lastUserPayload(request_) {
  const message = [...request_.input.messages].reverse().find((item) => item?.role === 'user');
  return JSON.parse(message.content);
}

test('filterSupplementalModelFacts keeps only whitelisted enum facts that fill gaps', () => {
  const filtered = filterSupplementalModelFacts(
    {
      noticeOrPayStatus: 'neither',
      medicalPeriodStatus: 'not_ended',
      issueType: 'unpaid_wages',
      dismissalGround: 'unknown',
      salaryAmount: 8000,
      taxPeriod: '2025'
    },
    { issueType: 'dismissal' }
  );

  assert.deepEqual(filtered, {
    noticeOrPayStatus: 'neither',
    medicalPeriodStatus: 'not_ended'
  });
});

test('filterSupplementalModelFacts lets deterministic facts win on conflict', () => {
  const filtered = filterSupplementalModelFacts(
    { noticeOrPayStatus: 'written_notice_30_days' },
    { noticeOrPayStatus: 'neither' }
  );

  assert.deepEqual(filtered, {});
});

test('filterSupplementalModelFacts rejects non-object input without throwing', () => {
  assert.deepEqual(filterSupplementalModelFacts(null, {}), {});
  assert.deepEqual(filterSupplementalModelFacts([], {}), {});
  assert.deepEqual(filterSupplementalModelFacts({ issueType: 'dismissal' }, null), {});
});

test('normalizeAgentInput accepts at most two pending questions', () => {
  const input = normalizeAgentInput({
    piiRedacted: true,
    redactedText: TERSE_ANSWER,
    pendingQuestions: [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]
  });
  assert.deepEqual(input.pendingQuestions, [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]);

  assert.throws(
    () =>
      normalizeAgentInput({
        piiRedacted: true,
        redactedText: TERSE_ANSWER,
        pendingQuestions: [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION, WORK_ARRANGEMENT_QUESTION]
      }),
    (error) => error instanceof LegalAgentRuntimeError && error.code === 'AGENT_INPUT_INVALID'
  );
  assert.throws(
    () =>
      normalizeAgentInput({
        piiRedacted: true,
        redactedText: TERSE_ANSWER,
        pendingQuestions: '公司有没有提前通知？'
      }),
    (error) => error instanceof LegalAgentRuntimeError && error.code === 'AGENT_INPUT_INVALID'
  );
});

test('V0 runtime forwards pendingQuestions into the sanitized model payload', async () => {
  const captured = [];
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: {
      id: 'capture-inference',
      async infer(request_) {
        captured.push(request_);
        return {
          id: 'capture-response',
          output: {
            action: 'finish',
            output: {
              status: 'needs_clarification',
              legalDomain: 'labor',
              knownFacts: {},
              missingFields: ['noticeOrPayStatus'],
              questions: [NOTICE_QUESTION],
              legalConclusionGenerated: false
            }
          }
        };
      }
    }
  });

  await runtime.run({
    piiRedacted: true,
    redactedText: TERSE_ANSWER,
    clarificationRound: 1,
    knownFacts: {},
    pendingQuestions: [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]
  });

  const payload = lastUserPayload(captured[0]);
  assert.deepEqual(payload.pendingQuestions, [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]);
  assert.equal(payload.redactedText, TERSE_ANSWER);
});

function scriptedInference(captured) {
  return {
    id: 'scripted-deepseek-inference',
    mode: 'deepseek',
    model: 'deepseek-v4-pro',
    async infer(request_) {
      captured.push(request_);
      const payload = lastUserPayload(request_);
      const decision = payload.redactedText.includes(TERSE_ANSWER)
        ? {
            status: 'needs_clarification',
            legalDomain: 'labor',
            knownFacts: { noticeOrPayStatus: 'neither', medicalPeriodStatus: 'not_ended' },
            missingFields: ['workArrangementOutcome'],
            questions: [WORK_ARRANGEMENT_QUESTION],
            legalConclusionGenerated: false
          }
        : {
            status: 'needs_clarification',
            legalDomain: 'labor',
            knownFacts: {},
            missingFields: ['noticeOrPayStatus', 'medicalPeriodStatus'],
            questions: [NOTICE_QUESTION],
            legalConclusionGenerated: false
          };
      return { id: 'scripted-response', output: { action: 'finish', output: decision } };
    }
  };
}

test('end to end: model facts from a terse answer stop the repeated questions', async () => {
  const captured = [];
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'fact-merge-e2e',
    idFactory: () => 'fact-merge-session',
    autoCleanup: false
  });
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: scriptedInference(captured)
  });
  const service = new AgentBackedConversationService({
    service: businessService,
    agent,
    ownerId: 'fact-merge-e2e',
    inferenceDescriptor: { mode: 'deepseek', model: 'deepseek-v4-pro' }
  });

  const started = await service.start(request(START_TEXT));
  assert.deepEqual(started.questions, [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]);

  const answered = await service.answer(started.sessionId, TERSE_ANSWER);

  assert.equal(answered.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(answered.knownFacts.medicalPeriodStatus, 'not_ended');
  assert.deepEqual(answered.questions, []);
  assert.ok(!answered.questions.includes(NOTICE_QUESTION));
  assert.ok(!answered.questions.includes(MEDICAL_PERIOD_QUESTION));

  // 模型第二轮收到的上下文必须包含上一轮实际提出的问题，否则无法对齐简略回答。
  assert.equal(captured.length, 2);
  const secondPayload = lastUserPayload(captured[1]);
  assert.deepEqual(secondPayload.pendingQuestions, [NOTICE_QUESTION, MEDICAL_PERIOD_QUESTION]);

  // 合并后的事实已写入会话，下一轮确定性管线不会再追问同一字段。
  const session = businessService.getSession(started.sessionId);
  assert.equal(session.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(session.knownFacts.medicalPeriodStatus, 'not_ended');
});

function serviceWithMockAgent(decision, ownerId = 'fact-merge-mock') {
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId,
    idFactory: () => `${ownerId}-session`,
    autoCleanup: false
  });
  const agent = {
    describe() {
      return { agentId: 'agent.legal-compliance', runtime: 'hypha-react' };
    },
    async run(input) {
      return {
        agentId: 'agent.legal-compliance',
        runtime: 'hypha-react',
        runId: input.runId,
        taskType: 'legal_self_check',
        decision,
        trace: []
      };
    }
  };
  return new AgentBackedConversationService({
    service: businessService,
    agent,
    ownerId,
    inferenceDescriptor: { mode: 'deepseek', model: 'deepseek-v4-pro' }
  });
}

test('drops invalid model facts instead of merging them', async () => {
  const service = serviceWithMockAgent(
    {
      status: 'needs_clarification',
      legalDomain: 'labor',
      knownFacts: {
        noticeOrPayStatus: 'verbal_notice',
        salaryAmount: 8000,
        medicalPeriodStatus: 'not_ended'
      },
      missingFields: ['noticeOrPayStatus'],
      questions: [NOTICE_QUESTION],
      legalConclusionGenerated: false
    },
    'fact-merge-invalid'
  );

  const started = await service.start(request(START_TEXT));

  assert.equal(started.knownFacts.noticeOrPayStatus, undefined);
  assert.equal(started.knownFacts.salaryAmount, undefined);
  assert.equal(started.knownFacts.medicalPeriodStatus, 'not_ended');
});

test('never merges facts when the decision does not explicitly deny a legal conclusion', async () => {
  const service = serviceWithMockAgent(
    {
      status: 'needs_clarification',
      legalDomain: 'labor',
      knownFacts: { noticeOrPayStatus: 'neither', medicalPeriodStatus: 'not_ended' },
      missingFields: [],
      questions: [NOTICE_QUESTION],
      legalConclusionGenerated: true
    },
    'fact-merge-boundary'
  );

  const started = await service.start(request(START_TEXT));
  const answered = await service.answer(started.sessionId, TERSE_ANSWER);

  assert.equal(answered.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(answered.knownFacts.medicalPeriodStatus, 'not_ended');
  assert.deepEqual(answered.questions, []);
});

test('deterministic facts win when the model reports a conflicting value', async () => {
  const service = serviceWithMockAgent(
    {
      status: 'needs_clarification',
      legalDomain: 'labor',
      knownFacts: { noticeOrPayStatus: 'written_notice_30_days' },
      missingFields: ['medicalPeriodStatus'],
      questions: [MEDICAL_PERIOD_QUESTION],
      legalConclusionGenerated: false
    },
    'fact-merge-conflict'
  );

  const started = await service.start(request(START_TEXT));
  const answered = await service.answer(
    started.sessionId,
    '公司没有书面通知，也没有多给一个月工资'
  );

  assert.equal(answered.knownFacts.noticeOrPayStatus, 'neither');
});
