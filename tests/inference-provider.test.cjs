const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  AgentProviderConfigurationError,
  DEEPSEEK_PRO_MODEL,
  createAgentInferenceProvider,
  createDemoInferenceProvider,
  createFallbackInferenceProvider,
  createModelBackedInferenceProvider,
  parseStructuredContent
} = require('../src/agent/inference-provider.cjs');

const projectRoot = path.resolve(__dirname, '..');

function inferenceRequest(redactedText, clarificationRound = 0) {
  return {
    runId: 'run_provider_test',
    stepId: 'v0-fact-analysis',
    modelAlias: 'legal-compliance-v0',
    input: {
      instructions: 'Return JSON.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ redactedText, clarificationRound, knownFacts: {} })
        }
      ]
    },
    metadata: {
      domainPackId: 'domain.legal-compliance.v0-v1',
      workflowId: 'workflow.legal-self-check'
    }
  };
}

test('demo inference returns a bounded legal clarification decision', async () => {
  const provider = createDemoInferenceProvider();
  const response = await provider.infer(inferenceRequest('老板让我明天不用来了。'));

  assert.equal(provider.mode, 'demo');
  assert.equal(response.output.action, 'finish');
  assert.equal(response.output.output.status, 'needs_clarification');
  assert.equal(response.output.output.legalDomain, 'labor');
  assert.ok(response.output.output.questions.length <= 2);
  assert.equal(response.output.output.legalConclusionGenerated, false);
});

test('retryable DeepSeek failures use demo fallback and open a local circuit', async () => {
  let attempts = 0;
  const retryableError = Object.assign(new Error('network unavailable'), { retryable: true });
  const provider = createFallbackInferenceProvider(
    {
      id: 'primary-test', mode: 'deepseek', model: 'deepseek-v4-pro',
      async infer() { attempts += 1; throw retryableError; }
    },
    createDemoInferenceProvider()
  );
  const first = await provider.infer(inferenceRequest('老板让我明天不用来了。'));
  const secondRequest = inferenceRequest('老板让我明天不用来了。');
  secondRequest.runId = 'run_provider_test_2';
  const second = await provider.infer(secondRequest);

  assert.equal(first.metadata.providerMode, 'demo-fallback');
  assert.equal(second.metadata.providerMode, 'demo-fallback');
  assert.equal(attempts, 1);
  assert.equal(provider.getRunStatus('run_provider_test').fallbackUsed, true);
  assert.equal(provider.getRunStatus('run_provider_test_2').fallbackUsed, true);
});

test('non-retryable provider errors never fall back', async () => {
  const provider = createFallbackInferenceProvider(
    {
      id: 'primary-test', mode: 'deepseek', model: 'deepseek-v4-pro',
      async infer() { throw Object.assign(new Error('invalid key'), { retryable: false }); }
    },
    createDemoInferenceProvider()
  );
  await assert.rejects(() => provider.infer(inferenceRequest('老板让我明天不用来了。')), /invalid key/);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('circuit half-open probe after cooldown restores primary model calls', async () => {
  let attempts = 0;
  const retryableError = Object.assign(new Error('network unavailable'), { retryable: true });
  const provider = createFallbackInferenceProvider(
    {
      id: 'primary-test', mode: 'deepseek', model: 'deepseek-v4-pro',
      async infer() {
        attempts += 1;
        if (attempts === 1) throw retryableError;
        return { id: 'primary-ok', output: { action: 'finish' }, metadata: { providerMode: 'deepseek' } };
      }
    },
    createDemoInferenceProvider(),
    { circuitBreakerCooldownMs: 20 }
  );

  const first = await provider.infer(inferenceRequest('老板让我明天不用来了。'));
  await sleep(30);
  const secondRequest = inferenceRequest('老板让我明天不用来了。');
  secondRequest.runId = 'run_provider_test_2';
  const second = await provider.infer(secondRequest);
  const thirdRequest = inferenceRequest('老板让我明天不用来了。');
  thirdRequest.runId = 'run_provider_test_3';
  const third = await provider.infer(thirdRequest);

  assert.equal(first.metadata.providerMode, 'demo-fallback');
  assert.equal(second.metadata.providerMode, 'deepseek');
  assert.equal(third.metadata.providerMode, 'deepseek');
  assert.equal(attempts, 3);
  assert.equal(provider.getRunStatus('run_provider_test').fallbackUsed, true);
  assert.equal(provider.getRunStatus('run_provider_test_2').fallbackUsed, false);
  assert.equal(provider.getRunStatus('run_provider_test_3').fallbackUsed, false);
});

test('failed half-open probe reopens the circuit and keeps cooling down', async () => {
  let attempts = 0;
  const retryableError = Object.assign(new Error('network unavailable'), { retryable: true });
  const provider = createFallbackInferenceProvider(
    {
      id: 'primary-test', mode: 'deepseek', model: 'deepseek-v4-pro',
      async infer() { attempts += 1; throw retryableError; }
    },
    createDemoInferenceProvider(),
    { circuitBreakerCooldownMs: 20 }
  );

  const first = await provider.infer(inferenceRequest('老板让我明天不用来了。'));
  const secondRequest = inferenceRequest('老板让我明天不用来了。');
  secondRequest.runId = 'run_provider_test_2';
  const second = await provider.infer(secondRequest);
  await sleep(30);
  const thirdRequest = inferenceRequest('老板让我明天不用来了。');
  thirdRequest.runId = 'run_provider_test_3';
  const third = await provider.infer(thirdRequest);
  const fourthRequest = inferenceRequest('老板让我明天不用来了。');
  fourthRequest.runId = 'run_provider_test_4';
  const fourth = await provider.infer(fourthRequest);

  assert.equal(first.metadata.providerMode, 'demo-fallback');
  assert.equal(second.metadata.providerMode, 'demo-fallback');
  assert.equal(third.metadata.providerMode, 'demo-fallback');
  assert.equal(fourth.metadata.providerMode, 'demo-fallback');
  // first failure + one failed probe; the second and fourth requests stayed in cooldown.
  assert.equal(attempts, 2);
  assert.equal(provider.getRunStatus('run_provider_test_4').fallbackUsed, true);
});

test('model-backed inference adapts Hypha ModelProvider JSON content', async () => {
  const captured = [];
  const provider = createModelBackedInferenceProvider({
    id: 'model-backed-test',
    model: 'test-model',
    modelProvider: {
      async generate(request) {
        captured.push(request);
        return {
          id: 'model-response',
          providerId: 'test-provider',
          model: 'test-model',
          content:
            '```json\n{"action":"finish","output":{"status":"information_ready"}}\n```'
        };
      }
    }
  });
  const response = await provider.infer(inferenceRequest('已脱敏事实。'));

  assert.equal(response.output.action, 'finish');
  assert.equal(response.output.output.status, 'information_ready');
  assert.equal(captured[0].temperature, 0);
  assert.deepEqual(captured[0].responseFormat, { id: 'contract.legal-agent-decision' });
  assert.equal(JSON.stringify(captured[0].metadata).includes('已脱敏事实'), false);
});

test('DeepSeek preset uses the current Pro model and requires a runtime key', () => {
  assert.throws(
    () =>
      createAgentInferenceProvider({
        projectRoot,
        environment: { LEGAL_AGENT_PROVIDER: 'deepseek' }
      }),
    (error) =>
      error instanceof AgentProviderConfigurationError &&
      error.message.includes('LEGAL_AGENT_API_KEY')
  );
  const provider = createAgentInferenceProvider({
    projectRoot,
    environment: {
      LEGAL_AGENT_PROVIDER: 'deepseek',
      LEGAL_AGENT_API_KEY: 'test-only-key'
    }
  });
  assert.equal(provider.mode, 'deepseek');
  assert.equal(provider.model, DEEPSEEK_PRO_MODEL);
});

test('provider factory defaults to demo and validates live configuration', () => {
  assert.equal(createAgentInferenceProvider({ projectRoot, environment: {} }).mode, 'demo');
  assert.throws(
    () =>
      createAgentInferenceProvider({
        projectRoot,
        environment: { LEGAL_AGENT_PROVIDER: 'openai-compatible' }
      }),
    (error) =>
      error instanceof AgentProviderConfigurationError &&
      error.code === 'AGENT_PROVIDER_CONFIGURATION_INVALID'
  );
});

test('structured model response parser accepts plain and fenced JSON only', () => {
  assert.deepEqual(parseStructuredContent('{"action":"finish"}'), { action: 'finish' });
  assert.deepEqual(parseStructuredContent('```json\n{"action":"finish"}\n```'), {
    action: 'finish'
  });
  assert.throws(() => parseStructuredContent('not json'));
});
