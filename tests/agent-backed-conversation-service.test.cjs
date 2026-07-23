const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentBackedConversationService } = require('../src/agent/agent-backed-conversation-service.cjs');
const { createAgentInferenceProvider } = require('../src/agent/inference-provider.cjs');
const { createLegalComplianceAgent } = require('../src/agent/legal-compliance-agent.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const { createV1DemoQueryRuntime } = require('../src/v1/demo-query-runtime.cjs');

async function createService() {
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'agent-web-test',
    idFactory: () => 'agent-web-session',
    autoCleanup: false
  });
  const inference = createAgentInferenceProvider({ environment: {} });
  const agent = await createLegalComplianceAgent({
    inference,
    v1Runtime: createV1DemoQueryRuntime()
  });
  return new AgentBackedConversationService({
    service: businessService,
    agent,
    ownerId: 'agent-web-test',
    inferenceDescriptor: { mode: inference.mode, model: inference.model }
  });
}

function request(userText) {
  return { userText, privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION };
}

test('V0 web conversation is executed by the unified Hypha Agent', async () => {
  const service = await createService();
  const result = await service.start(request('老板让我明天不用来了。'));

  assert.equal(result.taskType, 'legal_self_check');
  assert.equal(result.agentExecution.connected, true);
  assert.equal(result.agentExecution.agentId, 'agent.legal-compliance');
  assert.equal(result.agentExecution.runtime, 'hypha-react');
  assert.equal(result.agentExecution.providerMode, 'demo');
  assert.ok(result.questions.length <= 2);
});

test('V1 web conversation uses the same Agent and returns demonstrable artifacts', async () => {
  const service = await createService();
  const result = await service.start(
    request('统计近三年案例库未签劳动合同的胜诉率和赔偿中位数，生成图表。')
  );

  assert.equal(result.taskType, 'professional_data_query');
  assert.equal(result.agentExecution.agentId, 'agent.legal-compliance');
  assert.equal(result.v1.status, 'completed');
  assert.equal(result.v1.plan.readOnly, true);
  assert.equal(result.v1.result.rows.length, 3);
  assert.equal(result.v1.artifact.type, 'analysis-document');
  assert.doesNotMatch(result.assistantMessage, /\bV[01]\b/);
});

test('Agent-backed conversation keeps recognized terse medical facts', async () => {
  const service = await createService();
  const started = await service.start(
    request('我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。')
  );
  const answered = await service.answer(started.sessionId, '没有多给，已结束');

  assert.equal(answered.knownFacts.medicalPeriodStatus, 'ended');
  assert.equal(answered.agentDecision.knownFacts.medicalPeriodStatus, 'ended');
  assert.deepEqual(answered.questions, [
    '公司有没有提前三十天书面告诉您？',
    '休养时间结束后，您是否既做不了原来的工作，也做不了公司另外安排的工作？'
  ]);
});

test('keeps state-machine questions authoritative when the model proposes different wording', async () => {
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'question-authority-test',
    idFactory: () => 'question-authority-session',
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
        decision: {
          status: 'needs_clarification',
          legalDomain: 'labor',
          knownFacts: {},
          missingFields: ['uncontrolled_model_field'],
          questions: ['请描述更多情况？'],
          legalConclusionGenerated: false
        },
        trace: []
      };
    }
  };
  const service = new AgentBackedConversationService({
    service: businessService,
    agent,
    ownerId: 'question-authority-test',
    inferenceDescriptor: { mode: 'deepseek', model: 'deepseek-v4-pro' }
  });

  const result = await service.start(request('老板让我明天不用来了。'));

  assert.deepEqual(result.questions, ['您大约工作了多久？', '双方有没有签过书面合同？']);
  assert.deepEqual(result.agentDecision.questions, ['请描述更多情况？']);
});

test('keeps the verified business result when a successful model output violates the Agent contract', async () => {
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'contract-fallback-test',
    idFactory: () => 'contract-fallback-session',
    autoCleanup: false
  });
  const inference = {
    getRunStatus() {
      return {
        providerMode: 'deepseek',
        requestedProviderMode: 'deepseek',
        fallbackUsed: false
      };
    }
  };
  const agent = {
    describe() {
      return {
        agentId: 'agent.legal-compliance',
        runtime: 'hypha-react'
      };
    },
    async run() {
      const error = new Error('unsafe model question');
      error.code = 'AGENT_RUN_FAILED';
      throw error;
    }
  };
  const service = new AgentBackedConversationService({
    service: businessService,
    agent,
    inference,
    ownerId: 'contract-fallback-test',
    inferenceDescriptor: { mode: 'deepseek', model: 'deepseek-v4-pro' }
  });

  const result = await service.start(
    request('我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。')
  );

  assert.equal(result.agentExecution.providerMode, 'deepseek');
  assert.equal(result.agentExecution.fallbackUsed, false);
  assert.equal(result.agentExecution.fallbackReason, undefined);
  assert.equal(result.agentExecution.outputAccepted, false);
  assert.equal(result.agentExecution.outputRejectionReason, 'contract_validation_failed');
  assert.deepEqual(result.agentDecision.knownFacts, result.knownFacts);
  assert.deepEqual(result.agentDecision.questions, result.questions);
});

test('keeps the verified business result when the Agent fails before provider status is available', async () => {
  const businessService = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'agent-failure-test',
    idFactory: () => 'agent-failure-session',
    autoCleanup: false
  });
  const agent = {
    describe() {
      return { agentId: 'agent.legal-compliance', runtime: 'hypha-react' };
    },
    async run() {
      const error = new Error('provider response could not be parsed');
      error.code = 'AGENT_RUN_FAILED';
      throw error;
    }
  };
  const service = new AgentBackedConversationService({
    service: businessService,
    agent,
    ownerId: 'agent-failure-test',
    inferenceDescriptor: { mode: 'deepseek', model: 'deepseek-v4-pro' }
  });

  const result = await service.start(
    request('我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。')
  );

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.agentExecution.providerMode, 'business-fallback');
  assert.equal(result.agentExecution.requestedProviderMode, 'deepseek');
  assert.equal(result.agentExecution.fallbackUsed, true);
  assert.equal(result.agentExecution.fallbackReason, 'agent_run_failed');
  assert.equal(result.agentExecution.outputRejectionReason, 'agent_run_failed');
  assert.deepEqual(result.agentDecision.questions, result.questions);
});
