const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalSha256 } = require('./workflow-state-capability-map.cjs');

const DEFAULT_ARTIFACT_OUTPUT_BINDING = 'configs/capability-bindings/legal-v1-artifact-outputs.json';
const DEFAULT_STATE_CAPABILITY_BINDING = 'configs/capability-bindings/legal-workflow-state-capabilities.json';
const ARTIFACT_OUTPUT_BINDING_ID = 'binding.legal-v1-artifact-outputs';
const ARTIFACT_OUTPUT_BINDING_VERSION = '1.0.0';
const STATE_CAPABILITY_BINDING_ID = 'binding.legal-workflow-state-capabilities';
const STATE_CAPABILITY_BINDING_VERSION = '1.0.0';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTENT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const EXPECTED_BACKEND = 'hypha.LocalFilesystemExecutionArtifactStore';
const EXPECTED_VISIBILITY = 'private-local';
const ANALYSIS_ARTIFACT_KEYS = Object.freeze([
  'artifactId',
  'type',
  'fileName',
  'mimeType',
  'executionTimeMs',
  'content',
  'contentSha256'
]);
const STORAGE_RECEIPT_KEYS = Object.freeze([
  'storeId',
  'objectKey',
  'versionId',
  'etag',
  'contentSha256',
  'sizeBytes',
  'backend'
]);
const REQUIRED_STORAGE_RECEIPT_KEYS = Object.freeze(
  STORAGE_RECEIPT_KEYS.filter((key) => key !== 'versionId')
);

class ArtifactOutputCapabilityBindingError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ArtifactOutputCapabilityBindingError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ArtifactOutputCapabilityBindingError(code, message, cause ? { cause } : {});
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireObject(value, label, code = 'ARTIFACT_OUTPUT_BINDING_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, keys, label, code = 'ARTIFACT_OUTPUT_BINDING_INVALID') {
  const object = requireObject(value, label, code);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} contains undeclared fields.`);
  }
  return object;
}

function requireString(value, label, code = 'ARTIFACT_OUTPUT_BINDING_INVALID') {
  if (typeof value !== 'string' || value.length === 0) fail(code, `${label} is invalid.`);
  return value;
}

function requireReference(value, label) {
  const reference = requireExactKeys(value, ['id', 'version'], label);
  if (!VERSION_PATTERN.test(reference.version)) fail('ARTIFACT_OUTPUT_BINDING_INVALID', `${label} is invalid.`);
  return deepFreeze({ id: requireString(reference.id, `${label}.id`), version: reference.version });
}

function sameReference(left, right) {
  return left?.id === right?.id && left?.version === right?.version;
}

function readJson(filePath, missingCode) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(missingCode, 'Artifact output binding file is unavailable.', error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Artifact output binding JSON is invalid.', error);
  }
}

function requireStringArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item) => typeof item !== 'string')) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', `${label} is invalid.`);
  }
  if ([...value].sort().join('|') !== [...expected].sort().join('|')) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', `${label} has drifted.`);
  }
  return Object.freeze([...value]);
}

function validateStoreDefinitions(stores, stateProfile) {
  if (!Array.isArray(stores) || stores.length !== 2) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Artifact output binding must declare analysis and sandbox stores.');
  }
  const stateStores = new Map((stateProfile.stores ?? []).map((store) => [store.role, store]));
  const normalized = {};
  for (const raw of stores) {
    const store = requireExactKeys(
      raw,
      ['role', 'storeId', 'backend', 'visibility', 'maxObjectBytes'],
      'stores[]'
    );
    if (!['analysis', 'sandbox'].includes(store.role) || normalized[store.role]) {
      fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Artifact store roles are invalid or duplicated.');
    }
    const stateStore = stateStores.get(store.role);
    if (
      !stateStore ||
      stateStore.storeId !== store.storeId ||
      stateStore.backend !== store.backend ||
      stateStore.visibility !== store.visibility ||
      store.backend !== EXPECTED_BACKEND ||
      store.visibility !== EXPECTED_VISIBILITY ||
      !Number.isSafeInteger(store.maxObjectBytes) ||
      store.maxObjectBytes < 1
    ) {
      fail('ARTIFACT_OUTPUT_BINDING_DRIFT', 'Artifact store definition has drifted from the Workflow State profile.');
    }
    normalized[store.role] = deepFreeze({ ...store });
  }
  return deepFreeze(normalized);
}

function validateAnalysisContract(value) {
  const contract = requireExactKeys(
    value,
    [
      'artifactType',
      'mimeType',
      'objectKeyPattern',
      'contentSha256Pattern',
      'readBackVerificationRequired',
      'immutableCreateRequired'
    ],
    'analysisArtifactContract'
  );
  if (
    contract.artifactType !== 'analysis-document' ||
    contract.mimeType !== 'text/markdown; charset=utf-8' ||
    contract.objectKeyPattern !== '^analysis/[0-9a-f]{64}\\.md$' ||
    contract.contentSha256Pattern !== '^[0-9a-f]{64}$' ||
    contract.readBackVerificationRequired !== true ||
    contract.immutableCreateRequired !== true
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Analysis Artifact contract is unsafe or unsupported.');
  }
  return deepFreeze({ ...contract });
}

function validatePublicationContract(value, stateOutput) {
  const contract = requireExactKeys(
    value,
    [
      'completedStatus',
      'executionAttemptedRequired',
      'requiredArtifactFields',
      'requiredStorageReceiptFields',
      'optionalStorageReceiptFields',
      'resultWithheldOnPersistenceFailure',
      'rawPathValuesAllowed',
      'rawConnectionValuesAllowed',
      'rawUserTextAllowed'
    ],
    'publicationContract'
  );
  requireStringArray(contract.requiredArtifactFields, ANALYSIS_ARTIFACT_KEYS, 'requiredArtifactFields');
  requireStringArray(
    contract.requiredStorageReceiptFields,
    REQUIRED_STORAGE_RECEIPT_KEYS,
    'requiredStorageReceiptFields'
  );
  requireStringArray(contract.optionalStorageReceiptFields, ['versionId'], 'optionalStorageReceiptFields');
  const expectedStatuses = ['awaiting_confirmation', 'completed', 'failed', 'rejected'];
  const expectedReceiptFields = ['executionAttempted', 'status'];
  if (
    contract.completedStatus !== 'completed' ||
    contract.executionAttemptedRequired !== true ||
    contract.resultWithheldOnPersistenceFailure !== true ||
    contract.rawPathValuesAllowed !== false ||
    contract.rawConnectionValuesAllowed !== false ||
    contract.rawUserTextAllowed !== false ||
    [...(stateOutput.statuses ?? [])].sort().join('|') !== expectedStatuses.join('|') ||
    [...(stateOutput.requiredReceiptFields ?? [])].sort().join('|') !== expectedReceiptFields.join('|') ||
    stateOutput.rawConnectionValuesAllowed !== false ||
    stateOutput.rawUserTextAllowed !== false
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_DRIFT', 'Artifact publication contract has drifted from the Workflow State output contract.');
  }
  return deepFreeze({
    ...contract,
    requiredArtifactFields: Object.freeze([...contract.requiredArtifactFields]),
    requiredStorageReceiptFields: Object.freeze([...contract.requiredStorageReceiptFields]),
    optionalStorageReceiptFields: Object.freeze([...contract.optionalStorageReceiptFields])
  });
}

function validateRepositoryDescriptor(repository, store, role) {
  if (!repository || typeof repository.describe !== 'function') {
    fail('ARTIFACT_OUTPUT_REPOSITORY_MISSING', `${role} Artifact Repository is unavailable.`);
  }
  const descriptor = repository.describe();
  const maxField = role === 'analysis' ? 'maxObjectBytes' : 'maxArtifactBytes';
  requireExactKeys(
    descriptor,
    ['storeId', 'backend', 'visibility', maxField, 'rootPathExposed'],
    `${role}Repository.describe()`,
    'ARTIFACT_OUTPUT_REPOSITORY_DRIFT'
  );
  if (
    descriptor.storeId !== store.storeId ||
    descriptor.backend !== store.backend ||
    descriptor.visibility !== store.visibility ||
    descriptor[maxField] !== store.maxObjectBytes ||
    descriptor.rootPathExposed !== false
  ) {
    fail('ARTIFACT_OUTPUT_REPOSITORY_DRIFT', `${role} Artifact Repository does not match the bound profile.`);
  }
  if (
    role === 'analysis' &&
    ['storeAnalysisArtifact', 'readAnalysisArtifact', 'health', 'stats', 'close'].some(
      (method) => typeof repository[method] !== 'function'
    )
  ) {
    fail('ARTIFACT_OUTPUT_REPOSITORY_DRIFT', 'Analysis Artifact Repository interface is incomplete.');
  }
  return deepFreeze({ ...descriptor });
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertPublicationInput(input, contract, maxObjectBytes) {
  const publication = requireExactKeys(
    input.publication,
    ['status', 'executionAttempted'],
    'publication',
    'ARTIFACT_OUTPUT_PUBLICATION_REJECTED'
  );
  if (publication.status !== 'completed' || publication.executionAttempted !== true) {
    fail('ARTIFACT_OUTPUT_PUBLICATION_REJECTED', 'Only successfully executed results may publish an Analysis Artifact.');
  }
  const artifact = requireExactKeys(
    input.artifact,
    ANALYSIS_ARTIFACT_KEYS,
    'artifact',
    'ARTIFACT_OUTPUT_PUBLICATION_REJECTED'
  );
  const content = requireString(artifact.content, 'artifact.content', 'ARTIFACT_OUTPUT_PUBLICATION_REJECTED');
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (
    !/^artifact-[0-9a-f]{12}$/.test(artifact.artifactId) ||
    artifact.type !== contract.artifactType ||
    typeof artifact.fileName !== 'string' ||
    !/^[^\\/\0]+\.md$/.test(artifact.fileName) ||
    artifact.mimeType !== contract.mimeType ||
    !Number.isSafeInteger(artifact.executionTimeMs) ||
    artifact.executionTimeMs < 0 ||
    !CONTENT_SHA256_PATTERN.test(artifact.contentSha256) ||
    sha256(content) !== artifact.contentSha256 ||
    contentBytes > maxObjectBytes
  ) {
    fail('ARTIFACT_OUTPUT_PUBLICATION_REJECTED', 'Analysis Artifact does not satisfy the bound output contract.');
  }
  return artifact;
}

function assertStorageReceipt(receipt, artifact, store, bindingRef, artifactProfileRef, outputContractRef) {
  requireExactKeys(
    receipt,
    STORAGE_RECEIPT_KEYS,
    'storageReceipt',
    'ARTIFACT_OUTPUT_RECEIPT_DRIFT'
  );
  if (
    receipt.storeId !== store.storeId ||
    receipt.backend !== store.backend ||
    !new RegExp('^analysis/[0-9a-f]{64}\\.md$').test(receipt.objectKey) ||
    (receipt.versionId !== undefined &&
      (typeof receipt.versionId !== 'string' || receipt.versionId.length === 0)) ||
    typeof receipt.etag !== 'string' ||
    receipt.etag.length === 0 ||
    receipt.contentSha256 !== artifact.contentSha256 ||
    receipt.sizeBytes !== Buffer.byteLength(artifact.content, 'utf8')
  ) {
    fail('ARTIFACT_OUTPUT_RECEIPT_DRIFT', 'Artifact Store receipt does not match the bound output contract.');
  }
  return deepFreeze({
    ...receipt,
    artifactOutputBindingRef: bindingRef,
    artifactProfileRef,
    outputContractRef
  });
}

function createBoundAnalysisRepository(repository, definition) {
  const descriptor = definition.descriptor;
  return Object.freeze({
    describe() {
      return deepFreeze({
        ...descriptor,
        artifactOutputBindingRef: definition.bindingRef,
        artifactProfileRef: definition.artifactProfileRef,
        outputContractRef: definition.outputContractRef
      });
    },
    async storeAnalysisArtifact(input) {
      const artifact = assertPublicationInput(
        requireObject(input, 'artifact publication', 'ARTIFACT_OUTPUT_PUBLICATION_REJECTED'),
        definition.analysisContract,
        definition.store.maxObjectBytes
      );
      let receipt;
      try {
        receipt = await repository.storeAnalysisArtifact(input);
      } catch (error) {
        fail('ARTIFACT_OUTPUT_STORE_FAILED', 'Bound Analysis Artifact could not be persisted.', error);
      }
      return assertStorageReceipt(
        receipt,
        artifact,
        definition.store,
        definition.bindingRef,
        definition.artifactProfileRef,
        definition.outputContractRef
      );
    },
    readAnalysisArtifact(receipt) {
      return repository.readAnalysisArtifact(receipt);
    },
    health() {
      return repository.health();
    },
    stats() {
      return repository.stats();
    },
    close() {
      return repository.close();
    }
  });
}

function artifactOutputBindingRef(receipt) {
  const value = requireObject(receipt, 'artifact output receipt');
  if (
    value.bindingId !== ARTIFACT_OUTPUT_BINDING_ID ||
    value.bindingVersion !== ARTIFACT_OUTPUT_BINDING_VERSION ||
    !SHA256_PATTERN.test(value.manifestCanonicalSha256)
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Artifact output receipt hash is invalid.');
  }
  return deepFreeze({
    id: requireString(value.bindingId, 'receipt.bindingId'),
    version: requireString(value.bindingVersion, 'receipt.bindingVersion'),
    manifestCanonicalSha256: value.manifestCanonicalSha256
  });
}

function loadArtifactOutputCapabilityBinding(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const manifestPath = path.resolve(projectRoot, options.manifestPath ?? DEFAULT_ARTIFACT_OUTPUT_BINDING);
  const statePath = path.resolve(projectRoot, options.stateCapabilityPath ?? DEFAULT_STATE_CAPABILITY_BINDING);
  const manifest = readJson(manifestPath, 'ARTIFACT_OUTPUT_BINDING_MISSING');
  requireExactKeys(
    manifest,
    [
      'schemaVersion',
      'id',
      'version',
      'stateCapabilityBindingRef',
      'artifactProfileRef',
      'outputContractRef',
      'stores',
      'analysisArtifactContract',
      'publicationContract'
    ],
    'manifest'
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== ARTIFACT_OUTPUT_BINDING_ID ||
    manifest.version !== ARTIFACT_OUTPUT_BINDING_VERSION
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'Artifact output binding version is unsupported.');
  }
  const stateRef = requireExactKeys(
    manifest.stateCapabilityBindingRef,
    ['id', 'version', 'canonicalSha256'],
    'stateCapabilityBindingRef'
  );
  if (!SHA256_PATTERN.test(stateRef.canonicalSha256)) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'State capability binding hash is invalid.');
  }
  if (
    stateRef.id !== STATE_CAPABILITY_BINDING_ID ||
    stateRef.version !== STATE_CAPABILITY_BINDING_VERSION
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'State capability binding reference is unsupported.');
  }
  const stateManifest = readJson(statePath, 'WORKFLOW_STATE_CAPABILITY_MAP_MISSING');
  if (
    stateManifest.id !== stateRef.id ||
    stateManifest.version !== stateRef.version ||
    canonicalSha256(stateManifest) !== stateRef.canonicalSha256
  ) {
    fail('ARTIFACT_OUTPUT_BINDING_DRIFT', 'Workflow State capability binding has drifted.');
  }
  const artifactProfileRef = requireReference(manifest.artifactProfileRef, 'artifactProfileRef');
  const outputContractRef = requireReference(manifest.outputContractRef, 'outputContractRef');
  const stateProfile = stateManifest.artifactProfiles?.find((profile) => sameReference(profile, artifactProfileRef));
  const stateOutput = sameReference(stateManifest.outputContracts?.professionalQuery, outputContractRef)
    ? stateManifest.outputContracts.professionalQuery
    : null;
  if (!stateProfile || !stateOutput) {
    fail('ARTIFACT_OUTPUT_BINDING_DRIFT', 'Artifact profile or output contract is not retained by Workflow State.');
  }
  const stores = validateStoreDefinitions(manifest.stores, stateProfile);
  const analysisContract = validateAnalysisContract(manifest.analysisArtifactContract);
  const publicationContract = validatePublicationContract(manifest.publicationContract, stateOutput);
  const receipt = deepFreeze({
    bindingId: manifest.id,
    bindingVersion: manifest.version,
    stateCapabilityBindingRef: { id: stateRef.id, version: stateRef.version },
    artifactProfileRef,
    outputContractRef,
    storeRefs: {
      analysis: { storeId: stores.analysis.storeId, backend: stores.analysis.backend },
      sandbox: { storeId: stores.sandbox.storeId, backend: stores.sandbox.backend }
    },
    manifestCanonicalSha256: canonicalSha256(manifest),
    readBackVerificationRequired: true,
    immutableCreateRequired: true,
    resultWithheldOnPersistenceFailure: true,
    sensitiveValuesExposed: false,
    hyphaSourceModified: false
  });

  return Object.freeze({
    receipt,
    bindApplication(input = {}) {
      const stateBinding = requireObject(input.stateCapabilityBinding, 'stateCapabilityBinding');
      if (
        stateBinding.bindingId !== stateRef.id ||
        stateBinding.bindingVersion !== stateRef.version ||
        !sameReference(stateBinding.artifactProfileRef, artifactProfileRef) ||
        !sameReference(stateBinding.outputContractRef, outputContractRef)
      ) {
        fail('ARTIFACT_OUTPUT_BINDING_DRIFT', 'Active Workflow State binding does not match the Artifact output binding.');
      }
      const analysisDescriptor = validateRepositoryDescriptor(input.analysisRepository, stores.analysis, 'analysis');
      let sandboxDescriptor = null;
      if (input.sandboxEnabled === true) {
        sandboxDescriptor = validateRepositoryDescriptor(input.sandboxRepository, stores.sandbox, 'sandbox');
      } else if (input.sandboxEnabled !== false) {
        fail('ARTIFACT_OUTPUT_BINDING_INVALID', 'sandboxEnabled must be boolean.');
      }
      const bindingRef = artifactOutputBindingRef(receipt);
      const applicationReceipt = deepFreeze({
        ...receipt,
        activeStores: sandboxDescriptor ? ['analysis', 'sandbox'] : ['analysis'],
        repositoryDescriptorsValidated: true
      });
      const analysisRepository = createBoundAnalysisRepository(input.analysisRepository, {
        descriptor: analysisDescriptor,
        store: stores.analysis,
        analysisContract,
        publicationContract,
        bindingRef,
        artifactProfileRef,
        outputContractRef
      });
      return Object.freeze({ receipt: applicationReceipt, analysisRepository });
    }
  });
}

module.exports = {
  ARTIFACT_OUTPUT_BINDING_ID,
  ARTIFACT_OUTPUT_BINDING_VERSION,
  ArtifactOutputCapabilityBindingError,
  DEFAULT_ARTIFACT_OUTPUT_BINDING,
  DEFAULT_STATE_CAPABILITY_BINDING,
  artifactOutputBindingRef,
  loadArtifactOutputCapabilityBinding
};
