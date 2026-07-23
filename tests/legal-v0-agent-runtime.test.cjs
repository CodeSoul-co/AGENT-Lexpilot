const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  LegalAgentRuntimeError,
  createLegalV0AgentRuntime
} = require('../src/agent/legal-v0-agent-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');

function validDecision(overrides = {}) {
  return {
    status: 'needs_clarification',
    legalDomain: 'labor',
    knownFacts: { issueType: 'dismissal' },
    missingFields: ['employmentDuration'],
    questions: ['您大约工作了多久？'],
    legalConclusionGenerated: false,
    ...overrides
  };
}

function inferenceReturning(decision, capture = []) {
  return {
    id: 'test-inference',
    async infer(request) {
      capture.push(request);
      return {
        id: 'test-response',
        output: { action: 'finish', output: decision }
      };
    }
  };
}

test('V0 Agent compiles the DomainPack and runs through Hypha ReAct', async () => {
  const captured = [];
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: inferenceReturning(validDecision(), captured)
  });

  const descriptor = runtime.describe();
  assert.equal(descriptor.runtime, 'hypha-react');
  assert.equal(descriptor.domainPackId, 'domain.legal-compliance.v0-v1');
  assert.equal(descriptor.workflowId, 'workflow.legal-self-check');
  assert.equal(descriptor.initialState, 'Intake');
  assert.ok(descriptor.toolRefs.includes('tool.verified-law-retriever'));

  const result = await runtime.run({
    runId: 'run_agent_test',
    sessionId: 'session_agent_test',
    ownerId: 'owner_agent_test',
    piiRedacted: true,
    redactedText: '公司通知[NAME_1]明天不用来了。',
    clarificationRound: 0,
    knownFacts: {}
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.runtime, 'hypha-react');
  assert.equal(result.runId, 'run_agent_test');
  assert.deepEqual(result.decision.questions, ['您大约工作了多久？']);
  assert.equal(result.decision.legalConclusionGenerated, false);
  assert.deepEqual(
    result.trace.map((step) => step.phase),
    ['observe', 'reason', 'select_action', 'verify', 'memory_sync', 'complete']
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].modelAlias, 'legal-compliance-v0');
  assert.match(captured[0].input.instructions, /JSON/);
  assert.match(captured[0].input.instructions, /直接问句/);
  assert.match(captured[0].input.instructions, /建议您/);
  assert.match(JSON.stringify(captured[0].input), /\[NAME_1\]/);
  assert.doesNotMatch(JSON.stringify(captured[0]), /13800138000/);
});

test('V0 Agent blocks inference unless the privacy gate has completed', async () => {
  const captured = [];
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: inferenceReturning(validDecision(), captured)
  });

  await assert.rejects(
    runtime.run({
      piiRedacted: false,
      redactedText: '公司通知我明天不用来了。'
    }),
    (error) =>
      error instanceof LegalAgentRuntimeError && error.code === 'AGENT_PRIVACY_GATE_REJECTED'
  );
  assert.equal(captured.length, 0);
});

test('V0 Agent blocks raw PII before calling the inference provider', async () => {
  const captured = [];
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: inferenceReturning(validDecision(), captured)
  });

  await assert.rejects(
    runtime.run({
      piiRedacted: true,
      redactedText: '我的手机号是13800138000，公司通知我明天不用来了。'
    }),
    (error) =>
      error instanceof LegalAgentRuntimeError && error.code === 'AGENT_PRIVACY_GATE_REJECTED'
  );
  assert.equal(captured.length, 0);
});

test('V0 Agent rejects more than two clarification questions', async () => {
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: inferenceReturning(
      validDecision({ questions: ['问题一？', '问题二？', '问题三？'] })
    )
  });

  await assert.rejects(
    runtime.run({
      piiRedacted: true,
      redactedText: '公司通知我明天不用来了。'
    }),
    (error) => error instanceof LegalAgentRuntimeError && error.code === 'AGENT_RUN_FAILED'
  );
});

test('V0 Agent rejects legal conclusions or extra advice fields', async () => {
  const runtime = await createLegalV0AgentRuntime({
    projectRoot,
    inference: inferenceReturning({
      ...validDecision(),
      legalConclusionGenerated: true,
      advice: '立即提起诉讼'
    })
  });

  await assert.rejects(
    runtime.run({
      piiRedacted: true,
      redactedText: '公司通知我明天不用来了。'
    }),
    (error) => error instanceof LegalAgentRuntimeError && error.code === 'AGENT_RUN_FAILED'
  );
});

test('V0 Agent rejects advice hidden in fact fields or clarification text', async () => {
  for (const decision of [
    validDecision({ knownFacts: { advice: '立即提起诉讼' } }),
    validDecision({ questions: ['建议您立即仲裁'] })
  ]) {
    const runtime = await createLegalV0AgentRuntime({
      projectRoot,
      inference: inferenceReturning(decision)
    });
    await assert.rejects(
      runtime.run({
        piiRedacted: true,
        redactedText: '公司通知我明天不用来了。'
      }),
      (error) => error instanceof LegalAgentRuntimeError && error.code === 'AGENT_RUN_FAILED'
    );
  }
});
