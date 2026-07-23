const path = require('node:path');
const { loadHyphaModels } = require('../../scripts/hypha-paths.cjs');
const { analyzeInformationReadiness } = require('../v0/clarification-planner.cjs');

const PROVIDER_MODES = Object.freeze({
  DEMO: 'demo',
  OPENAI_COMPATIBLE: 'openai-compatible',
  DEEPSEEK: 'deepseek'
});
const DEFAULT_MODEL_ALIAS = 'legal-compliance-v0';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro';
const JSON_OBJECT_CONTRACT_REF = Object.freeze({ id: 'contract.legal-agent-decision' });
const FALLBACK_MODES = Object.freeze({ NONE: 'none', DEMO: 'demo' });
// Reasoning models (e.g. deepseek-v4-pro) bill reasoning into completion
// tokens; a small cap truncates the response before any content is emitted.
const DEFAULT_MAX_TOKENS = 4096;

class AgentProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentProviderConfigurationError';
    this.code = 'AGENT_PROVIDER_CONFIGURATION_INVALID';
  }
}

function requiredValue(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentProviderConfigurationError(`Required environment variable is missing: ${key}`);
  }
  return value.trim();
}

function parseTimeout(value) {
  if (value === undefined || value === '') return 30_000;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new AgentProviderConfigurationError(
      'LEGAL_AGENT_TIMEOUT_MS must be an integer between 1000 and 120000.'
    );
  }
  return timeoutMs;
}

function parseMaxTokens(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_TOKENS;
  const maxTokens = Number(value);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32_768) {
    throw new AgentProviderConfigurationError(
      'LEGAL_AGENT_MAX_TOKENS must be an integer between 256 and 32768.'
    );
  }
  return maxTokens;
}

function parseStructuredContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Model response content is empty.');
  }
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function extractDemoPayload(request) {
  const messages = request?.input?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Demo inference requires Hypha Agent messages.');
  }
  const message = [...messages].reverse().find((item) => item?.role === 'user');
  if (!message || typeof message.content !== 'string') {
    throw new Error('Demo inference could not find the sanitized user payload.');
  }
  const payload = JSON.parse(message.content);
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof payload.redactedText !== 'string' ||
    !Number.isInteger(payload.clarificationRound) ||
    !payload.knownFacts ||
    typeof payload.knownFacts !== 'object' ||
    Array.isArray(payload.knownFacts)
  ) {
    throw new Error('Demo inference received an invalid sanitized payload.');
  }
  return payload;
}

function decisionFromAnalysis(analysis) {
  return {
    status: analysis.status,
    legalDomain: analysis.legalDomain,
    knownFacts: analysis.knownFacts ?? {},
    missingFields: analysis.missingFields ?? [],
    questions: analysis.questions ?? [],
    legalConclusionGenerated: false
  };
}

function createDemoInferenceProvider() {
  return Object.freeze({
    id: 'legal-demo-inference',
    mode: PROVIDER_MODES.DEMO,
    model: 'deterministic-legal-demo',
    async infer(request) {
      const payload = extractDemoPayload(request);
      const analysis = analyzeInformationReadiness(
        {
          status: 'ready',
          piiRedacted: true,
          redactedText: payload.redactedText
        },
        {
          clarificationRound: payload.clarificationRound,
          existingKnownFacts: payload.knownFacts
        }
      );
      return {
        id: `${request.runId}:${request.stepId}:demo`,
        output: { action: 'finish', output: decisionFromAnalysis(analysis) },
        metadata: { providerMode: PROVIDER_MODES.DEMO }
      };
    }
  });
}

function createFallbackInferenceProvider(primary, fallback, options = {}) {
  if (!primary || typeof primary.infer !== 'function') {
    throw new AgentProviderConfigurationError('primary inference provider is invalid.');
  }
  if (!fallback || typeof fallback.infer !== 'function') {
    throw new AgentProviderConfigurationError('fallback inference provider is invalid.');
  }
  const circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 60_000;
  const runStatus = new Map();
  // 0 means the circuit is closed; otherwise the timestamp when it last opened.
  let circuitOpenedAt = 0;

  function record(runId, status) {
    runStatus.set(runId, Object.freeze({ ...status }));
    if (runStatus.size > 100) runStatus.delete(runStatus.keys().next().value);
  }

  return Object.freeze({
    id: `${primary.id}-with-${fallback.id}-fallback`,
    mode: primary.mode,
    model: primary.model,
    fallbackMode: FALLBACK_MODES.DEMO,
    getRunStatus(runId) {
      return runStatus.get(runId);
    },
    async infer(request) {
      // After the cooldown window a single half-open probe is allowed through:
      // success closes the circuit, a retryable failure reopens it.
      const halfOpenProbe =
        circuitOpenedAt !== 0 && Date.now() - circuitOpenedAt >= circuitBreakerCooldownMs;
      if (circuitOpenedAt === 0 || halfOpenProbe) {
        try {
          const response = await primary.infer(request);
          circuitOpenedAt = 0;
          record(request.runId, { providerMode: primary.mode, fallbackUsed: false });
          return response;
        } catch (error) {
          if (error?.retryable !== true) throw error;
          circuitOpenedAt = Date.now();
        }
      }
      const response = await fallback.infer(request);
      record(request.runId, {
        providerMode: 'demo-fallback',
        requestedProviderMode: primary.mode,
        fallbackUsed: true,
        fallbackReason: 'provider_unavailable'
      });
      return {
        ...response,
        metadata: {
          ...response.metadata,
          providerMode: 'demo-fallback',
          requestedProviderMode: primary.mode,
          fallbackReason: 'provider_unavailable'
        }
      };
    }
  });
}

function createModelBackedInferenceProvider(options) {
  const modelProvider = options.modelProvider;
  if (!modelProvider || typeof modelProvider.generate !== 'function') {
    throw new AgentProviderConfigurationError('modelProvider must expose generate(request).');
  }
  return Object.freeze({
    id: options.id,
    mode: options.mode ?? PROVIDER_MODES.OPENAI_COMPATIBLE,
    model: options.model,
    async infer(request) {
      const input = request.input ?? {};
      const response = await modelProvider.generate({
        runId: request.runId,
        stepId: request.stepId,
        modelAlias: request.modelAlias,
        instructions: input.instructions,
        input: input.messages,
        responseFormat: JSON_OBJECT_CONTRACT_REF,
        temperature: 0,
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        metadata: {
          domainPackId: request.metadata?.domainPackId,
          workflowId: request.metadata?.workflowId
        }
      });
      return {
        id: response.id,
        output: parseStructuredContent(response.content),
        usage: response.usage,
        metadata: {
          providerMode: options.mode ?? PROVIDER_MODES.OPENAI_COMPATIBLE,
          providerId: response.providerId,
          model: response.model
        }
      };
    }
  });
}

function createAgentInferenceProvider(options = {}) {
  const environment = options.environment ?? process.env;
  const mode = (environment.LEGAL_AGENT_PROVIDER ?? PROVIDER_MODES.DEMO).trim();
  if (mode === PROVIDER_MODES.DEMO) return createDemoInferenceProvider();
  if (![PROVIDER_MODES.OPENAI_COMPATIBLE, PROVIDER_MODES.DEEPSEEK].includes(mode)) {
    throw new AgentProviderConfigurationError(
      `LEGAL_AGENT_PROVIDER must be demo, deepseek, or openai-compatible, received: ${mode}`
    );
  }

  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const deepSeekMode = mode === PROVIDER_MODES.DEEPSEEK;
  const baseUrl = deepSeekMode
    ? environment.LEGAL_AGENT_BASE_URL?.trim() || DEEPSEEK_BASE_URL
    : requiredValue(environment, 'LEGAL_AGENT_BASE_URL');
  const model = deepSeekMode
    ? environment.LEGAL_AGENT_MODEL?.trim() || DEEPSEEK_PRO_MODEL
    : requiredValue(environment, 'LEGAL_AGENT_MODEL');
  const modelAlias = environment.LEGAL_AGENT_MODEL_ALIAS?.trim() || DEFAULT_MODEL_ALIAS;
  const apiKey = deepSeekMode
    ? requiredValue(environment, 'LEGAL_AGENT_API_KEY')
    : environment.LEGAL_AGENT_API_KEY?.trim() || undefined;
  const models = loadHyphaModels(projectRoot);
  const providerConfig = {
    id: deepSeekMode ? 'legal-deepseek' : 'legal-openai-compatible',
    baseUrl,
    apiKey,
    providerModelByAlias: { [modelAlias]: model },
    timeoutMs: parseTimeout(environment.LEGAL_AGENT_TIMEOUT_MS),
    capabilities: { chat: true, jsonMode: true }
  };
  const modelProvider = deepSeekMode
    ? models.createDeepSeekProvider(providerConfig)
    : new models.OpenAICompatibleModelProvider({ ...providerConfig, type: 'openai-compatible' });
  const primaryInference = createModelBackedInferenceProvider({
    id: deepSeekMode ? 'legal-deepseek-inference' : 'legal-openai-compatible-inference',
    mode,
    model,
    modelProvider,
    maxTokens: parseMaxTokens(environment.LEGAL_AGENT_MAX_TOKENS)
  });
  const fallbackMode = environment.LEGAL_AGENT_FALLBACK?.trim() || FALLBACK_MODES.NONE;
  if (fallbackMode === FALLBACK_MODES.NONE) return primaryInference;
  if (fallbackMode !== FALLBACK_MODES.DEMO) {
    throw new AgentProviderConfigurationError(
      `LEGAL_AGENT_FALLBACK must be none or demo, received: ${fallbackMode}`
    );
  }
  return createFallbackInferenceProvider(primaryInference, createDemoInferenceProvider(), {
    circuitBreakerCooldownMs: options.circuitBreakerCooldownMs
  });
}

module.exports = {
  DEFAULT_MODEL_ALIAS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PRO_MODEL,
  FALLBACK_MODES,
  JSON_OBJECT_CONTRACT_REF,
  PROVIDER_MODES,
  AgentProviderConfigurationError,
  createAgentInferenceProvider,
  createDemoInferenceProvider,
  createFallbackInferenceProvider,
  createModelBackedInferenceProvider,
  parseStructuredContent
};
