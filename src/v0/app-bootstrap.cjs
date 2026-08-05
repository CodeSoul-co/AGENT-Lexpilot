const path = require('node:path');
const { AgentBackedConversationService } = require('../agent/agent-backed-conversation-service.cjs');
const { createAgentInferenceProvider } = require('../agent/inference-provider.cjs');
const { createLegalComplianceAgent } = require('../agent/legal-compliance-agent.cjs');
const { createDataSourceAdmin } = require('../v1/data-source-admin.cjs');
const { loadDataSourceSchemaProfile } = require('../v1/data-source-schema-profile.cjs');
const {
  artifactOutputBindingRef,
  loadArtifactOutputCapabilityBinding
} = require('../v1/artifact-output-capability-binding.cjs');
const {
  agentCapabilityPatchRef,
  capabilitySnapshotRef,
  createAgentCapabilityPatch,
  createCapabilityReferenceSnapshot
} = require('../v1/capability-reference-snapshot.cjs');
const { createAuditActorId, requireAuditActorId } = require('../v1/audit-identity.cjs');
const { createDemoExecutionLog } = require('../v1/demo-execution-log.cjs');
const { createExecutionArtifactRepository } = require('../v1/execution-artifact-repository.cjs');
const { createV1DemoQueryRuntime } = require('../v1/demo-query-runtime.cjs');
const { createConfiguredSQLiteDataSource } = require('../v1/data-source-config.cjs');
const { createConfiguredNetworkDataSource } = require('../v1/network-data-source-config.cjs');
const { createSandboxArtifactRepository } = require('../v1/sandbox-artifact-repository.cjs');
const { createDockerSandboxProviderFactory } = require('../v1/docker-sandbox-provider-factory.cjs');
const { createSandboxExecutionRuntime } = require('../v1/sandbox-execution-runtime.cjs');
const { createSandboxWebCoordinator } = require('../v1/sandbox-web-coordinator.cjs');
const { createV1SQLQueryRuntime } = require('../v1/sqlite-query-runtime.cjs');
const { loadWorkflowStateCapabilityMap } = require('../v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../v1/workspace-execution-profile.cjs');
const { LegalSelfCheckConversationService } = require('./conversation-service.cjs');
const { createLocalAccessControl } = require('../web/local-access-control.cjs');
const {
  EncryptedFileLegalSessionStore,
  parseBase64EncryptionKey
} = require('./encrypted-file-session-store.cjs');

const ENVIRONMENT_KEYS = Object.freeze({
  encryptionKey: 'LEGAL_SESSION_KEY_BASE64',
  ownerId: 'LEGAL_SESSION_OWNER_ID',
  localRole: 'LEGAL_LOCAL_ROLE',
  dataDirectory: 'LEGAL_SESSION_DATA_DIR',
  v1Runtime: 'LEGAL_V1_RUNTIME',
  sandboxEnabled: 'LEGAL_V1_SANDBOX_ENABLED',
  sandboxImage: 'LEGAL_V1_SANDBOX_IMAGE',
  sandboxImageDigest: 'LEGAL_V1_SANDBOX_IMAGE_DIGEST'
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

function assertV1RuntimeBinding(v1Runtime, bindingReceipt) {
  if (!v1Runtime || typeof v1Runtime.describe !== 'function') {
    throw new Error('V1 runtime must expose a descriptor for DataSource binding validation.');
  }
  const descriptor = v1Runtime.describe();
  if (
    !descriptor ||
    descriptor.runtime !== bindingReceipt.expectedRuntime ||
    (bindingReceipt.selectedProfile !== null &&
      descriptor.dataSource !== bindingReceipt.selectedProfile.id)
  ) {
    throw new Error('V1 runtime has drifted from the selected DataSource/Schema Profile.');
  }
}

function createDefaultCapabilitySnapshot(options, environment, projectRoot) {
  const workspaceExecutionProfile = loadWorkspaceExecutionProfile({
    projectRoot,
    manifestPath: options.workspaceExecutionManifestPath,
    domainPackPath: options.domainPackPath
  });
  const dataSourceSchemaProfile = loadDataSourceSchemaProfile({
    projectRoot,
    bindingPath: options.dataSourceSchemaBindingPath,
    domainPackPath: options.domainPackPath
  });
  const workflowStateCapabilityMap = loadWorkflowStateCapabilityMap({
    projectRoot,
    manifestPath: options.workflowStateCapabilityManifestPath,
    domainPackPath: options.domainPackPath,
    workspaceExecutionPath: options.workspaceExecutionManifestPath,
    dataSourceSchemaPath: options.dataSourceSchemaBindingPath
  });
  const v1Mode = environment[ENVIRONMENT_KEYS.v1Runtime]?.trim() || 'demo';
  const dataSourceSchemaBinding = dataSourceSchemaProfile.resolveRuntime({
    runtime: v1Mode,
    configuredManifest:
      v1Mode === 'sqlite' ? environment.LEGAL_V1_SQLITE_MANIFEST : undefined
  });
  const sandboxEnabled =
    options.sandboxCoordinator !== undefined ||
    options.sandboxRuntime !== undefined ||
    environment[ENVIRONMENT_KEYS.sandboxEnabled]?.trim().toLowerCase() === 'true';
  const workflowStateCapabilityBinding = workflowStateCapabilityMap.bindApplication({
    workspaceExecutionBinding: workspaceExecutionProfile.receipt,
    dataSourceSchemaBinding: dataSourceSchemaBinding.receipt,
    sandboxEnabled
  });
  return createCapabilityReferenceSnapshot(workflowStateCapabilityBinding);
}

function createLocalLegalAgent(options = {}) {
  const environment = options.environment ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const capabilitySnapshot =
    options.capabilitySnapshot ??
    createDefaultCapabilitySnapshot(options, environment, projectRoot);
  const ownerId = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.ownerId);
  const encodedKey = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.encryptionKey);
  const dataDirectory = resolveDataDirectory(
    projectRoot,
    options.dataDirectory ?? environment[ENVIRONMENT_KEYS.dataDirectory]
  );
  const encryptionKey = parseBase64EncryptionKey(encodedKey);
  let auditActorId;
  let store;
  try {
    auditActorId = requireAuditActorId(
      options.auditActorId ?? createAuditActorId(ownerId, encryptionKey)
    );
    store = new EncryptedFileLegalSessionStore({ directory: dataDirectory, encryptionKey });
  } finally {
    encryptionKey.fill(0);
  }
  const executionLog =
    options.executionLog ??
    createDemoExecutionLog({
      filePath: resolveExecutionLogFilePath(
        projectRoot,
        options.dataDirectory ?? environment[ENVIRONMENT_KEYS.dataDirectory],
        options.executionLogFilePath ?? environment.LEGAL_V1_EXECUTION_LOG_FILE
      )
    });
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId,
    auditActorId,
    clock: options.clock,
    idFactory: options.idFactory,
    autoCleanup: options.autoCleanup,
    retentionDays: options.retentionDays,
    v1Runtime: options.v1Runtime,
    executionLog,
    artifactRepository: options.artifactRepository,
    capabilitySnapshot
  });
  return { service, dataDirectory, capabilitySnapshotRef: capabilitySnapshotRef(capabilitySnapshot) };
}

async function createLocalLegalAgentApplication(options = {}) {
  const environment = options.environment ?? process.env;
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const workspaceExecutionProfile = loadWorkspaceExecutionProfile({
    projectRoot,
    manifestPath: options.workspaceExecutionManifestPath,
    domainPackPath: options.domainPackPath
  });
  const dataSourceSchemaProfile = loadDataSourceSchemaProfile({
    projectRoot,
    bindingPath: options.dataSourceSchemaBindingPath,
    domainPackPath: options.domainPackPath
  });
  const workflowStateCapabilityMap = loadWorkflowStateCapabilityMap({
    projectRoot,
    manifestPath: options.workflowStateCapabilityManifestPath,
    domainPackPath: options.domainPackPath,
    workspaceExecutionPath: options.workspaceExecutionManifestPath,
    dataSourceSchemaPath: options.dataSourceSchemaBindingPath
  });
  const artifactOutputCapability = loadArtifactOutputCapabilityBinding({
    projectRoot,
    manifestPath: options.artifactOutputBindingPath,
    stateCapabilityPath: options.workflowStateCapabilityManifestPath
  });
  const v1Mode = environment[ENVIRONMENT_KEYS.v1Runtime]?.trim() || 'demo';
  const dataSourceSchemaBinding = dataSourceSchemaProfile.resolveRuntime({
    runtime: v1Mode,
    configuredManifest:
      v1Mode === 'sqlite' ? environment.LEGAL_V1_SQLITE_MANIFEST : undefined
  });
  const sandboxEnabled =
    options.sandboxCoordinator !== undefined ||
    options.sandboxRuntime !== undefined ||
    environment[ENVIRONMENT_KEYS.sandboxEnabled]?.trim().toLowerCase() === 'true';
  const workflowStateCapabilityBinding = workflowStateCapabilityMap.bindApplication({
    workspaceExecutionBinding: workspaceExecutionProfile.receipt,
    dataSourceSchemaBinding: dataSourceSchemaBinding.receipt,
    sandboxEnabled
  });
  const capabilitySnapshot = createCapabilityReferenceSnapshot(
    workflowStateCapabilityBinding
  );
  const capabilityPatch = createAgentCapabilityPatch(capabilitySnapshot);
  const ownerId = requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.ownerId);
  const accessControl =
    options.accessControl ??
    createLocalAccessControl({
      subjectId: ownerId,
      role: environment[ENVIRONMENT_KEYS.localRole]?.trim() || 'user'
    });
  const auditActorKey = parseBase64EncryptionKey(
    requiredEnvironmentValue(environment, ENVIRONMENT_KEYS.encryptionKey)
  );
  let auditActorId;
  try {
    auditActorId = requireAuditActorId(
      options.auditActorId ?? createAuditActorId(ownerId, auditActorKey)
    );
  } finally {
    auditActorKey.fill(0);
  }
  const resolvedWorkspaceExecution =
    sandboxEnabled && options.sandboxCoordinator === undefined && options.sandboxRuntime === undefined
      ? workspaceExecutionProfile.resolve(environment)
      : null;
  let v1Runtime = options.v1Runtime;
  if (!v1Runtime) {
    if (v1Mode === 'demo') {
      v1Runtime = createV1DemoQueryRuntime();
    } else if (v1Mode === 'sqlite') {
      const dataSource =
        options.v1DataSource ??
        createConfiguredSQLiteDataSource({
          env: environment,
          projectRoot,
          manifestPath: dataSourceSchemaBinding.manifestPath
        });
      v1Runtime = await createV1SQLQueryRuntime({ dataSource });
    } else if (v1Mode === 'postgresql' || v1Mode === 'mysql') {
      const dataSource =
        options.v1DataSource ??
        createConfiguredNetworkDataSource({
          env: environment,
          manifestPath: dataSourceSchemaBinding.manifestPath
        });
      v1Runtime = await createV1SQLQueryRuntime({ dataSource });
    } else {
      throw new Error('LEGAL_V1_RUNTIME must be demo, sqlite, postgresql, or mysql.');
    }
  }
  assertV1RuntimeBinding(v1Runtime, dataSourceSchemaBinding.receipt);
  const executionLogFilePath = resolveExecutionLogFilePath(
    projectRoot,
    options.dataDirectory ?? environment[ENVIRONMENT_KEYS.dataDirectory],
    options.executionLogFilePath ?? environment.LEGAL_V1_EXECUTION_LOG_FILE
  );
  const executionLog =
    options.executionLog ?? createDemoExecutionLog({ filePath: executionLogFilePath });
  const dataSourceAdmin =
    options.dataSourceAdmin ??
    createDataSourceAdmin({
      projectRoot,
      env: environment,
      sourceFactory: options.dataSourceAdminSourceFactory
    });
  const artifactDirectory = path.resolve(
    projectRoot,
    environment.LEGAL_V1_ARTIFACT_DIR?.trim() || 'data/web-demo/v1-artifacts'
  );
  const rawArtifactRepository =
    options.artifactRepository ??
    createExecutionArtifactRepository({ rootPath: artifactDirectory, projectRoot });
  let sandboxArtifactRepository = options.sandboxArtifactRepository;
  let sandboxCoordinator = options.sandboxCoordinator;
  if (sandboxEnabled && !sandboxCoordinator) {
    let sandboxRuntime = options.sandboxRuntime;
    if (!sandboxRuntime) {
      const executionEnvironment = resolvedWorkspaceExecution.executionEnvironment;
      const imageReference = executionEnvironment.image.reference;
      const imageDigest = executionEnvironment.image.digest;
      const sandboxArtifactDirectory = path.resolve(
        projectRoot,
        environment.LEGAL_V1_SANDBOX_ARTIFACT_ROOT?.trim() || 'data/sandbox-artifacts'
      );
      sandboxArtifactRepository =
        sandboxArtifactRepository ??
        createSandboxArtifactRepository({ rootPath: sandboxArtifactDirectory, projectRoot });
      const providerFactory =
        options.sandboxProviderFactory ??
        createDockerSandboxProviderFactory({
          projectRoot,
          artifactRepository: sandboxArtifactRepository,
          dockerPath: environment.LEGAL_V1_DOCKER_PATH?.trim() || undefined
        });
      sandboxRuntime = await createSandboxExecutionRuntime({
        workspaceRoot: resolvedWorkspaceExecution.workspaceRoot,
        imageReference,
        imageDigest,
        expectedExecutionEnvironment: executionEnvironment,
        providerFactory,
        artifactRepository: sandboxArtifactRepository
      });
    }
    sandboxCoordinator = createSandboxWebCoordinator({
      sandboxRuntime,
      executionLog,
      auditActorId
    });
  }
  const artifactOutputBinding = artifactOutputCapability.bindApplication({
    stateCapabilityBinding: workflowStateCapabilityBinding,
    analysisRepository: rawArtifactRepository,
    sandboxRepository: sandboxArtifactRepository,
    sandboxEnabled: sandboxArtifactRepository !== undefined
  });
  const artifactRepository = artifactOutputBinding.analysisRepository;
  const local = createLocalLegalAgent({
    ...options,
    environment,
    projectRoot,
    auditActorId,
    v1Runtime,
    executionLog,
    artifactRepository,
    capabilitySnapshot
  });
  const startupRetentionCleanup = await local.service.cleanupInactiveSessionsWithArtifacts();
  const inference = createAgentInferenceProvider({ environment, projectRoot });
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference,
    v1Runtime,
    v0ModelAlias: environment.LEGAL_AGENT_MODEL_ALIAS,
    capabilitySnapshot,
    capabilityPatch
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
    sandboxCoordinator: sandboxCoordinator ?? null,
    sandboxDescriptor: sandboxCoordinator?.describe() ?? { available: false },
    dataSourceAdmin,
    accessControl,
    dataSourceSchemaBinding: dataSourceSchemaBinding.receipt,
    workflowStateCapabilityBinding,
    artifactOutputBinding: artifactOutputBinding.receipt,
    artifactOutputBindingRef: artifactOutputBindingRef(artifactOutputBinding.receipt),
    capabilitySnapshotRef: capabilitySnapshotRef(capabilitySnapshot),
    agentCapabilityPatchRef: agentCapabilityPatchRef(capabilityPatch, capabilitySnapshot),
    workspaceExecutionBinding: workspaceExecutionProfile.receipt,
    executionLogFilePath,
    artifactDirectory,
    startupRetentionCleanup,
    async close() {
      await sandboxArtifactRepository?.close?.();
      await rawArtifactRepository.close?.();
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
