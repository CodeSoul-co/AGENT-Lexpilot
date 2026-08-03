const path = require('node:path');
const { AgentBackedConversationService } = require('../agent/agent-backed-conversation-service.cjs');
const { createAgentInferenceProvider } = require('../agent/inference-provider.cjs');
const { createLegalComplianceAgent } = require('../agent/legal-compliance-agent.cjs');
const { createDemoExecutionLog } = require('../v1/demo-execution-log.cjs');
const { createExecutionArtifactRepository } = require('../v1/execution-artifact-repository.cjs');
const { createV1DemoQueryRuntime } = require('../v1/demo-query-runtime.cjs');
const { createConfiguredSQLiteDataSource } = require('../v1/data-source-config.cjs');
const { createConfiguredNetworkDataSource } = require('../v1/network-data-source-config.cjs');
const { createV1SQLQueryRuntime } = require('../v1/sqlite-query-runtime.cjs');
const { LegalSelfCheckConversationService } = require('./conversation-service.cjs');
const {
  EncryptedFileLegalSessionStore,
  parseBase64EncryptionKey
} = require('./encrypted-file-session-store.cjs');

const ENVIRONMENT_KEYS = Object.freeze({
  encryptionKey: 'LEGAL_SESSION_KEY_BASE64',
  ownerId: 'LEGAL_SESSION_OWNER_ID',
  dataDirectory: 'LEGAL_SESSION_DATA_DIR',
  v1Runtime: 'LEGAL_V1_RUNTIME'
});

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Required environment variable is missing: ${name}`);
  }
  return value.trim();
}

function resolveDataDirectory(projectRoot, configuredDirectory) {
  if (configuredDirectory === undefined || configuredDirectory.trim().length === 0) {
    return path.join(projectRoot, 'data', 'sessions');
  }
  return path.resolve(projectRoot, configuredDirectory.trim());
}

function resolveExecutionLogFilePath(projectRoot, configuredDirectory, configuredFilePath) {
  if (typeof configuredFilePath === 'string' && configuredFilePath.trim().length > 0) {
    return path.resolve(projectRoot, configuredFilePath.trim());
  }
  if (typeof configuredDirectory === 'string' && configuredDirectory.trim().length > 0) {
    return path.join(resolveDataDirectory(projectRoot, configuredDirectory), 'v1-execution-log.jsonl');
  }
  return path.join(projectRoot, 'data', 'web-demo', 'v1-execution-log.jsonl');
}

function createLocalLegalAgent(options = {}) {
  const environment = options.environment ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const ownerId = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.ownerId);
  const encodedKey = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.encryptionKey);
  const dataDirectory = resolveDataDirectory(
    projectRoot,
    options.dataDirectory ?? environment[ENVIRONMENT_KEYS.dataDirectory]
  );
  const encryptionKey = parseBase64EncryptionKey(encodedKey);
  let store;
  try {
    store = new EncryptedFileLegalSessionStore({ directory: dataDirectory, encryptionKey });
  } finally {
    encryptionKey.fill(0);
  }
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId,
    clock: options.clock,
    idFactory: options.idFactory,
    autoCleanup: options.autoCleanup,
    retentionDays: options.retentionDays,
    v1Runtime: options.v1Runtime,
    executionLog: options.executionLog,
    artifactRepository: options.artifactRepository
  });
  return { service, dataDirectory };
}

async function createLocalLegalAgentApplication(options = {}) {
  const environment = options.environment ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const ownerId = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.ownerId);
  const v1Mode = environment[ENVIRONMENT_KEYS.v1Runtime]?.trim() || 'demo';
  let v1Runtime = options.v1Runtime;
  if (!v1Runtime) {
    if (v1Mode === 'demo') {
      v1Runtime = createV1DemoQueryRuntime();
    } else if (v1Mode === 'sqlite') {
      const dataSource =
        options.v1DataSource ?? createConfiguredSQLiteDataSource({ env: environment, projectRoot });
      v1Runtime = await createV1SQLQueryRuntime({ dataSource });
    } else if (v1Mode === 'postgresql' || v1Mode === 'mysql') {
      const manifestPath = path.join(
        projectRoot,
        'configs',
        'data-sources',
        `legal-cases.${v1Mode}.json`
      );
      const dataSource =
        options.v1DataSource ??
        createConfiguredNetworkDataSource({ env: environment, manifestPath });
      v1Runtime = await createV1SQLQueryRuntime({ dataSource });
    } else {
      throw new Error('LEGAL_V1_RUNTIME must be demo, sqlite, postgresql, or mysql.');
    }
  }
  const executionLogFilePath = resolveExecutionLogFilePath(
    projectRoot,
    options.dataDirectory ?? environment[ENVIRONMENT_KEYS.dataDirectory],
    options.executionLogFilePath ?? environment.LEGAL_V1_EXECUTION_LOG_FILE
  );
  const executionLog = createDemoExecutionLog({ filePath: executionLogFilePath });
  const artifactDirectory = path.resolve(
    projectRoot,
    environment.LEGAL_V1_ARTIFACT_DIR?.trim() || 'data/web-demo/v1-artifacts'
  );
  const artifactRepository =
    options.artifactRepository ??
    createExecutionArtifactRepository({ rootPath: artifactDirectory, projectRoot });
  const local = createLocalLegalAgent({
    ...options,
    environment,
    projectRoot,
    v1Runtime,
    executionLog,
    artifactRepository
  });
  const inference = createAgentInferenceProvider({ environment, projectRoot });
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference,
    v1Runtime,
    v0ModelAlias: environment.LEGAL_AGENT_MODEL_ALIAS
  });
  const service = new AgentBackedConversationService({
    service: local.service,
    agent,
    ownerId,
    inference,
    inferenceDescriptor: {
      mode: inference.mode,
      model: inference.model,
      fallbackMode: inference.fallbackMode ?? 'none'
    }
  });
  return {
    ...local,
    service,
    agentDescriptor: service.describe(),
    v1Descriptor: v1Runtime.describe(),
    executionLogFilePath,
    artifactDirectory,
    async close() {
      await artifactRepository.close?.();
    }
  };
}

module.exports = {
  ENVIRONMENT_KEYS,
  createLocalLegalAgent,
  createLocalLegalAgentApplication,
  resolveDataDirectory,
  resolveExecutionLogFilePath
};
