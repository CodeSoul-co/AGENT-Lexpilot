const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE_CAPABILITY_MANIFEST =
  'configs/capability-bindings/legal-workflow-state-capabilities.json';
const DEFAULT_DOMAIN_PACK = 'configs/domain-packs/legal-compliance.domain.json';
const DEFAULT_WORKSPACE_EXECUTION_MANIFEST =
  'configs/execution-profiles/legal-v1-sandbox.json';
const DEFAULT_DATA_SOURCE_SCHEMA_MANIFEST =
  'configs/capability-bindings/legal-v1-data-sources.json';
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_STATE_IDS = Object.freeze([
  'INITIAL',
  'LOAD_SCHEMA',
  'GENERATE_PLAN',
  'POLICY_CHECK',
  'HUMAN_REVIEW',
  'EXECUTE_SELECT',
  'EXECUTE_WRITE',
  'EXECUTE_SCRIPT',
  'BUILD_ARTIFACT',
  'APPEND_LOG',
  'COMPLETED',
  'FAILED'
]);
const RUNTIME_TRANSITIONS = Object.freeze([
  'INITIAL|LOAD_SCHEMA|start',
  'LOAD_SCHEMA|GENERATE_PLAN|schema-loaded',
  'GENERATE_PLAN|POLICY_CHECK|plan-generated',
  'POLICY_CHECK|EXECUTE_SELECT|read-only',
  'POLICY_CHECK|HUMAN_REVIEW|write-or-script',
  'POLICY_CHECK|APPEND_LOG|blocked',
  'HUMAN_REVIEW|EXECUTE_WRITE|write-approved',
  'HUMAN_REVIEW|EXECUTE_SCRIPT|script-approved',
  'HUMAN_REVIEW|APPEND_LOG|rejected-or-timeout',
  'EXECUTE_SELECT|BUILD_ARTIFACT|completed',
  'EXECUTE_WRITE|BUILD_ARTIFACT|completed',
  'EXECUTE_SCRIPT|BUILD_ARTIFACT|completed',
  'BUILD_ARTIFACT|APPEND_LOG|artifact-stored',
  'APPEND_LOG|COMPLETED|success-recorded',
  'APPEND_LOG|FAILED|failure-recorded'
]);
const CAPABILITY_REFERENCE_KEYS = Object.freeze([
  'workspaceProfileRef',
  'executionProfileRef',
  'dataSourceProfileRef',
  'artifactProfileRef',
  'outputContractRef'
]);

class WorkflowStateCapabilityMapError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WorkflowStateCapabilityMapError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new WorkflowStateCapabilityMapError(code, message, cause ? { cause } : {});
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} contains undeclared fields.`);
  }
  return object;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireReference(value, label) {
  const reference = requireExactKeys(value, ['id', 'version'], label);
  return Object.freeze({
    id: requireIdentifier(reference.id, `${label}.id`),
    version: requireVersion(reference.version, `${label}.version`)
  });
}

function requirePinnedReference(value, label) {
  const reference = requireExactKeys(value, ['id', 'version', 'canonicalSha256'], label);
  return Object.freeze({
    id: requireIdentifier(reference.id, `${label}.id`),
    version: requireVersion(reference.version, `${label}.version`),
    canonicalSha256: requireSha256(
      reference.canonicalSha256,
      `${label}.canonicalSha256`
    )
  });
}

function sameReference(left, right) {
  return left?.id === right?.id && left?.version === right?.version;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function readJson(filename, missingCode) {
  let text;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    fail(missingCode, 'Required versioned configuration is unavailable.', error);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Versioned configuration is not valid JSON.', error);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireUniqueReferences(definitions, label) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} must be a non-empty array.`);
  }
  const references = definitions.map((definition, index) => {
    const object = requireObject(definition, `${label}[${index}]`);
    const id = requireIdentifier(object.id, `${label}[${index}].id`);
    const version = requireVersion(object.version, `${label}[${index}].version`);
    return { id, version, definition: object };
  });
  const keys = references.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} contains duplicate references.`);
  }
  return references;
}

function validateDependencyBinding(actual, reference, label) {
  if (
    actual.id !== reference.id ||
    actual.version !== reference.version ||
    canonicalSha256(actual) !== reference.canonicalSha256
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', `${label} binding has drifted.`);
  }
}

function validateDataSourceSelectors(definitions, dataSourceBindingRef) {
  const selectors = requireUniqueReferences(definitions, 'dataSourceSelectors');
  for (const selector of selectors) {
    const definition = requireExactKeys(
      selector.definition,
      ['id', 'version', 'bindingRef', 'selection'],
      `dataSourceSelectors.${selector.id}`
    );
    const bindingRef = requireReference(
      definition.bindingRef,
      `dataSourceSelectors.${selector.id}.bindingRef`
    );
    if (!sameReference(bindingRef, dataSourceBindingRef) || definition.selection !== 'active-runtime') {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'DataSource selector is not bound to the active runtime binding.');
    }
  }
  return selectors.map(({ id, version }) => Object.freeze({ id, version }));
}

function validateArtifactProfiles(definitions) {
  const profiles = requireUniqueReferences(definitions, 'artifactProfiles');
  for (const profile of profiles) {
    const definition = requireExactKeys(
      profile.definition,
      ['id', 'version', 'stores', 'pathValuesExposed', 'contentStoredInBinding'],
      `artifactProfiles.${profile.id}`
    );
    if (definition.pathValuesExposed !== false || definition.contentStoredInBinding !== false) {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Artifact profile may not expose paths or content.');
    }
    if (!Array.isArray(definition.stores) || definition.stores.length !== 2) {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Artifact profile must bind analysis and sandbox stores.');
    }
    const roles = [];
    for (const [index, rawStore] of definition.stores.entries()) {
      const store = requireExactKeys(
        rawStore,
        ['role', 'storeId', 'backend', 'visibility'],
        `artifactProfiles.${profile.id}.stores[${index}]`
      );
      if (!['analysis', 'sandbox'].includes(store.role)) {
        fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Artifact store role is unsupported.');
      }
      roles.push(store.role);
      requireIdentifier(store.storeId, 'artifact store id');
      if (
        store.backend !== 'hypha.LocalFilesystemExecutionArtifactStore' ||
        store.visibility !== 'private-local'
      ) {
        fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Artifact store security contract has drifted.');
      }
    }
    if (new Set(roles).size !== 2) {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Artifact profile store roles must be unique.');
    }
  }
  return profiles.map(({ id, version }) => Object.freeze({ id, version }));
}

function validateOutputContracts(outputContracts, domainOutput) {
  const definitions = requireExactKeys(
    outputContracts,
    ['domainRef', 'professionalQuery'],
    'outputContracts'
  );
  const domainRef = requirePinnedReference(definitions.domainRef, 'outputContracts.domainRef');
  if (
    domainOutput.id !== domainRef.id ||
    domainOutput.version !== domainRef.version ||
    canonicalSha256(domainOutput) !== domainRef.canonicalSha256
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Domain output contract has drifted.');
  }
  const professional = requireExactKeys(
    definitions.professionalQuery,
    [
      'id',
      'version',
      'statuses',
      'requiredReceiptFields',
      'rawConnectionValuesAllowed',
      'rawUserTextAllowed'
    ],
    'outputContracts.professionalQuery'
  );
  const professionalRef = Object.freeze({
    id: requireIdentifier(professional.id, 'outputContracts.professionalQuery.id'),
    version: requireVersion(professional.version, 'outputContracts.professionalQuery.version')
  });
  const expectedStatuses = ['awaiting_confirmation', 'completed', 'failed', 'rejected'];
  const expectedFields = ['executionAttempted', 'status'];
  if (
    !Array.isArray(professional.statuses) ||
    [...professional.statuses].sort().join('|') !== expectedStatuses.join('|') ||
    !Array.isArray(professional.requiredReceiptFields) ||
    [...professional.requiredReceiptFields].sort().join('|') !== expectedFields.join('|') ||
    professional.rawConnectionValuesAllowed !== false ||
    professional.rawUserTextAllowed !== false
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Professional-query output contract is unsafe or incomplete.');
  }
  return Object.freeze({
    domain: Object.freeze({ id: domainRef.id, version: domainRef.version }),
    professional: professionalRef
  });
}

function referenceKey(reference) {
  return `${reference.id}@${reference.version}`;
}

function validateCapabilityRefs(value, label, catalogs) {
  const object = requireObject(value, label);
  const keys = Object.keys(object);
  if (keys.some((key) => !CAPABILITY_REFERENCE_KEYS.includes(key))) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} contains an unsupported capability reference.`);
  }
  const resolved = {};
  for (const key of keys) {
    const reference = requireReference(object[key], `${label}.${key}`);
    let allowed;
    if (key === 'workspaceProfileRef') allowed = catalogs.workspaceProfiles;
    if (key === 'executionProfileRef') allowed = catalogs.executionProfiles;
    if (key === 'dataSourceProfileRef') allowed = catalogs.dataSourceSelectors;
    if (key === 'artifactProfileRef') allowed = catalogs.artifactProfiles;
    if (key === 'outputContractRef') allowed = catalogs.outputContracts;
    if (!allowed.some((candidate) => referenceKey(candidate) === referenceKey(reference))) {
      fail('WORKFLOW_STATE_CAPABILITY_REFERENCE_MISSING', `${label}.${key} is not declared.`);
    }
    resolved[key] = reference;
  }
  return deepFreeze(resolved);
}

function validateStateBindings(definitions, expectedStateIds, label, catalogs) {
  if (!Array.isArray(definitions)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} must be an array.`);
  }
  const bindings = definitions.map((raw, index) => {
    const definition = requireExactKeys(raw, ['id', 'capabilityRefs'], `${label}[${index}]`);
    if (typeof definition.id !== 'string' || !expectedStateIds.includes(definition.id)) {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label}[${index}].id is unknown.`);
    }
    return deepFreeze({
      id: definition.id,
      capabilityRefs: validateCapabilityRefs(
        definition.capabilityRefs,
        `${label}.${definition.id}.capabilityRefs`,
        catalogs
      )
    });
  });
  const actualIds = bindings.map((binding) => binding.id);
  if (
    new Set(actualIds).size !== actualIds.length ||
    [...actualIds].sort().join('|') !== [...expectedStateIds].sort().join('|')
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', `${label} must cover every workflow state exactly once.`);
  }
  return deepFreeze(bindings);
}

function validateRuntimeWorkflow(runtimeWorkflow, catalogs) {
  const workflow = requireExactKeys(
    runtimeWorkflow,
    ['id', 'version', 'initialState', 'terminalStates', 'states', 'transitions'],
    'runtimeWorkflow'
  );
  const workflowRef = Object.freeze({
    id: requireIdentifier(workflow.id, 'runtimeWorkflow.id'),
    version: requireVersion(workflow.version, 'runtimeWorkflow.version')
  });
  if (
    workflow.initialState !== 'INITIAL' ||
    !Array.isArray(workflow.terminalStates) ||
    [...workflow.terminalStates].sort().join('|') !== 'COMPLETED|FAILED'
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Runtime workflow boundaries have drifted.');
  }
  const states = validateStateBindings(
    workflow.states,
    RUNTIME_STATE_IDS,
    'runtimeWorkflow.states',
    catalogs
  );
  if (!Array.isArray(workflow.transitions)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'runtimeWorkflow.transitions must be an array.');
  }
  const transitions = workflow.transitions.map((raw, index) => {
    const transition = requireExactKeys(
      raw,
      ['from', 'to', 'route'],
      `runtimeWorkflow.transitions[${index}]`
    );
    if (
      !RUNTIME_STATE_IDS.includes(transition.from) ||
      !RUNTIME_STATE_IDS.includes(transition.to) ||
      typeof transition.route !== 'string' ||
      transition.route.length === 0
    ) {
      fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Runtime workflow transition is invalid.');
    }
    return deepFreeze({ from: transition.from, to: transition.to, route: transition.route });
  });
  const actualTransitions = transitions.map(
    (transition) => `${transition.from}|${transition.to}|${transition.route}`
  );
  if (
    new Set(actualTransitions).size !== actualTransitions.length ||
    [...actualTransitions].sort().join('\n') !== [...RUNTIME_TRANSITIONS].sort().join('\n')
  ) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Runtime workflow transitions have drifted.');
  }
  return deepFreeze({
    id: workflowRef.id,
    version: workflowRef.version,
    initialState: workflow.initialState,
    terminalStates: [...workflow.terminalStates],
    states,
    transitions
  });
}

function countReferences(stateBindings) {
  const counts = Object.fromEntries(CAPABILITY_REFERENCE_KEYS.map((key) => [key, 0]));
  for (const state of stateBindings) {
    for (const key of Object.keys(state.capabilityRefs)) counts[key] += 1;
  }
  return deepFreeze(counts);
}

function loadWorkflowStateCapabilityMap(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const manifestPath = path.resolve(
    projectRoot,
    options.manifestPath ?? DEFAULT_STATE_CAPABILITY_MANIFEST
  );
  const domainPackPath = path.resolve(projectRoot, options.domainPackPath ?? DEFAULT_DOMAIN_PACK);
  const workspaceExecutionPath = path.resolve(
    projectRoot,
    options.workspaceExecutionPath ?? DEFAULT_WORKSPACE_EXECUTION_MANIFEST
  );
  const dataSourceSchemaPath = path.resolve(
    projectRoot,
    options.dataSourceSchemaPath ?? DEFAULT_DATA_SOURCE_SCHEMA_MANIFEST
  );
  const { value: manifest } = readJson(
    manifestPath,
    'WORKFLOW_STATE_CAPABILITY_MAP_MISSING'
  );
  requireExactKeys(
    manifest,
    [
      'schemaVersion',
      'id',
      'version',
      'domainPackRef',
      'domainWorkflowRef',
      'dependencyBindings',
      'dataSourceSelectors',
      'artifactProfiles',
      'outputContracts',
      'domainStateBindings',
      'runtimeWorkflow'
    ],
    'manifest'
  );
  if (manifest.schemaVersion !== 1) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'State capability schemaVersion is unsupported.');
  }
  requireIdentifier(manifest.id, 'manifest.id');
  requireVersion(manifest.version, 'manifest.version');
  const domainPackRef = requireReference(manifest.domainPackRef, 'domainPackRef');
  const domainWorkflowRef = requirePinnedReference(
    manifest.domainWorkflowRef,
    'domainWorkflowRef'
  );
  const dependencyBindings = requireExactKeys(
    manifest.dependencyBindings,
    ['workspaceExecution', 'dataSourceSchema'],
    'dependencyBindings'
  );
  const workspaceBindingRef = requirePinnedReference(
    dependencyBindings.workspaceExecution,
    'dependencyBindings.workspaceExecution'
  );
  const dataSourceBindingRef = requirePinnedReference(
    dependencyBindings.dataSourceSchema,
    'dependencyBindings.dataSourceSchema'
  );

  const { value: domainPack } = readJson(domainPackPath, 'DOMAIN_PACK_BINDING_MISSING');
  if (!sameReference(domainPack, domainPackRef)) {
    fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'DomainPack reference has drifted.');
  }
  const domainWorkflow = domainPack.workflows?.find(
    (workflow) => sameReference(workflow, domainWorkflowRef)
  );
  if (!domainWorkflow || canonicalSha256(domainWorkflow) !== domainWorkflowRef.canonicalSha256) {
    fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Domain workflow has drifted.');
  }
  const domainOutput = domainPack.outputContracts?.find(
    (contract) => contract.id === manifest.outputContracts?.domainRef?.id
  );
  if (!domainOutput) {
    fail('WORKFLOW_STATE_CAPABILITY_REFERENCE_MISSING', 'Domain output contract is unavailable.');
  }

  const { value: workspaceBinding } = readJson(
    workspaceExecutionPath,
    'WORKSPACE_EXECUTION_PROFILE_MISSING'
  );
  const { value: dataSourceBinding } = readJson(
    dataSourceSchemaPath,
    'DATA_SOURCE_SCHEMA_PROFILE_MISSING'
  );
  validateDependencyBinding(workspaceBinding, workspaceBindingRef, 'Workspace/Execution');
  validateDependencyBinding(dataSourceBinding, dataSourceBindingRef, 'DataSource/Schema');
  const workspaceProfileRef = requireReference(
    workspaceBinding.bindings?.workspaceProfileRef,
    'workspace binding profile ref'
  );
  const executionProfileRef = requireReference(
    workspaceBinding.bindings?.executionProfileRef,
    'execution binding profile ref'
  );
  const dataSourceSelectors = validateDataSourceSelectors(
    manifest.dataSourceSelectors,
    dataSourceBindingRef
  );
  const artifactProfiles = validateArtifactProfiles(manifest.artifactProfiles);
  const outputContracts = validateOutputContracts(manifest.outputContracts, domainOutput);
  const catalogs = {
    workspaceProfiles: [workspaceProfileRef],
    executionProfiles: [executionProfileRef],
    dataSourceSelectors,
    artifactProfiles,
    outputContracts: [outputContracts.domain, outputContracts.professional]
  };
  const domainStateIds = domainWorkflow.states.map((state) => state.id);
  const domainStateBindings = validateStateBindings(
    manifest.domainStateBindings,
    domainStateIds,
    'domainStateBindings',
    catalogs
  );
  const runtimeWorkflow = validateRuntimeWorkflow(manifest.runtimeWorkflow, catalogs);
  const compiledFsm = deepFreeze({
    workflowRef: { id: runtimeWorkflow.id, version: runtimeWorkflow.version },
    initialState: runtimeWorkflow.initialState,
    terminalStates: runtimeWorkflow.terminalStates,
    stateBindings: runtimeWorkflow.states,
    transitions: runtimeWorkflow.transitions
  });
  const referenceCounts = countReferences([
    ...domainStateBindings,
    ...runtimeWorkflow.states
  ]);
  if (Object.values(referenceCounts).some((count) => count === 0)) {
    fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'Compiled state map must retain every capability reference type.');
  }
  const receipt = deepFreeze({
    bindingId: manifest.id,
    bindingVersion: manifest.version,
    domainPackRef,
    domainWorkflowRef: {
      id: domainWorkflowRef.id,
      version: domainWorkflowRef.version
    },
    runtimeWorkflowRef: { id: runtimeWorkflow.id, version: runtimeWorkflow.version },
    dependencyBindingRefs: {
      workspaceExecution: {
        id: workspaceBindingRef.id,
        version: workspaceBindingRef.version
      },
      dataSourceSchema: {
        id: dataSourceBindingRef.id,
        version: dataSourceBindingRef.version
      }
    },
    artifactProfileRefs: artifactProfiles,
    outputContractRefs: outputContracts,
    domainStateBindingCount: domainStateBindings.length,
    runtimeStateBindingCount: runtimeWorkflow.states.length,
    retainedReferenceCounts: referenceCounts,
    compiledFsmSha256: canonicalSha256(compiledFsm),
    manifestCanonicalSha256: canonicalSha256(manifest),
    referencesRetained: true,
    sensitiveValuesExposed: false,
    hyphaSourceModified: false
  });

  return Object.freeze({
    receipt,
    compiledFsm,
    bindApplication(input = {}) {
      const workspaceReceipt = requireObject(
        input.workspaceExecutionBinding,
        'workspaceExecutionBinding'
      );
      const dataSourceReceipt = requireObject(
        input.dataSourceSchemaBinding,
        'dataSourceSchemaBinding'
      );
      if (
        workspaceReceipt.bindingId !== workspaceBindingRef.id ||
        workspaceReceipt.bindingVersion !== workspaceBindingRef.version ||
        !sameReference(workspaceReceipt.workspaceProfileRef, workspaceProfileRef) ||
        !sameReference(workspaceReceipt.executionProfileRef, executionProfileRef) ||
        workspaceReceipt.hyphaExecutionEnvironmentValidated !== true
      ) {
        fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Active Workspace/Execution binding has drifted.');
      }
      if (
        dataSourceReceipt.bindingId !== dataSourceBindingRef.id ||
        dataSourceReceipt.bindingVersion !== dataSourceBindingRef.version ||
        typeof dataSourceReceipt.runtime !== 'string' ||
        !sameReference(
          dataSourceReceipt.schemaSnapshotContractRef,
          dataSourceBinding.schemaSnapshotContract
        ) ||
        dataSourceReceipt.connectionValuesExposed !== false
      ) {
        fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Active DataSource/Schema binding has drifted.');
      }
      let activeDataSourceProfileRef = null;
      if (dataSourceReceipt.runtime === 'demo') {
        if (dataSourceReceipt.selectedProfile !== null) {
          fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Demo runtime may not select a real DataSource profile.');
        }
      } else {
        const selected = requireObject(
          dataSourceReceipt.selectedProfile,
          'dataSourceSchemaBinding.selectedProfile'
        );
        const declared = dataSourceBinding.profiles.find(
          (profile) =>
            profile.profileKey === selected.profileKey &&
            profile.runtime === dataSourceReceipt.runtime &&
            profile.manifestRef?.id === selected.id &&
            profile.manifestRef?.schemaVersion === selected.schemaVersion &&
            profile.manifestRef?.engine === selected.engine &&
            profile.manifestRef?.accessMode === selected.accessMode &&
            profile.manifestRef?.canonicalSha256 === selected.canonicalSha256
        );
        if (!declared) {
          fail('WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT', 'Active DataSource profile is not retained by the state map.');
        }
        activeDataSourceProfileRef = deepFreeze({
          bindingId: dataSourceBindingRef.id,
          bindingVersion: dataSourceBindingRef.version,
          profileKey: selected.profileKey,
          id: selected.id,
          schemaVersion: selected.schemaVersion,
          canonicalSha256: selected.canonicalSha256
        });
      }
      if (input.sandboxEnabled !== true && input.sandboxEnabled !== false) {
        fail('WORKFLOW_STATE_CAPABILITY_MAP_INVALID', 'sandboxEnabled must be boolean.');
      }
      return deepFreeze({
        bindingId: manifest.id,
        bindingVersion: manifest.version,
        domainPackRef,
        runtimeWorkflowRef: receipt.runtimeWorkflowRef,
        activeRuntime: dataSourceReceipt.runtime,
        activeDataSourceProfileRef,
        workspaceProfileRef,
        executionProfileRef,
        artifactProfileRef: artifactProfiles[0],
        outputContractRef: outputContracts.professional,
        sandboxCapabilityBound: input.sandboxEnabled,
        compiledFsmSha256: receipt.compiledFsmSha256,
        domainStateBindingCount: receipt.domainStateBindingCount,
        runtimeStateBindingCount: receipt.runtimeStateBindingCount,
        referencesRetained: true,
        sensitiveValuesExposed: false
      });
    }
  });
}

module.exports = {
  DEFAULT_DATA_SOURCE_SCHEMA_MANIFEST,
  DEFAULT_DOMAIN_PACK,
  DEFAULT_STATE_CAPABILITY_MANIFEST,
  DEFAULT_WORKSPACE_EXECUTION_MANIFEST,
  RUNTIME_STATE_IDS,
  WorkflowStateCapabilityMapError,
  canonicalSha256,
  loadWorkflowStateCapabilityMap
};
