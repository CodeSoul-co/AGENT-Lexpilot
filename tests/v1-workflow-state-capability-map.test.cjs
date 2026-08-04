const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadDataSourceSchemaProfile } = require('../src/v1/data-source-schema-profile.cjs');
const {
  RUNTIME_STATE_IDS,
  loadWorkflowStateCapabilityMap
} = require('../src/v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');

const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(
  projectRoot,
  'configs',
  'capability-bindings',
  'legal-workflow-state-capabilities.json'
);
const domainPackPath = path.join(
  projectRoot,
  'configs',
  'domain-packs',
  'legal-compliance.domain.json'
);
const workspaceExecutionPath = path.join(
  projectRoot,
  'configs',
  'execution-profiles',
  'legal-v1-sandbox.json'
);
const dataSourceSchemaPath = path.join(
  projectRoot,
  'configs',
  'capability-bindings',
  'legal-v1-data-sources.json'
);

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function withTemporaryJson(sourcePath, mutate, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-state-capability-'));
  const filename = path.join(directory, path.basename(sourcePath));
  const value = readJson(sourcePath);
  mutate(value);
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    return run(filename, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function expectCode(run, code) {
  assert.throws(run, (error) => error?.code === code);
}

test('compiles every Domain and V1 runtime state while retaining all five capability reference types', () => {
  const capabilityMap = loadWorkflowStateCapabilityMap({ projectRoot });
  assert.equal(capabilityMap.receipt.bindingId, 'binding.legal-workflow-state-capabilities');
  assert.equal(capabilityMap.receipt.domainStateBindingCount, 13);
  assert.equal(capabilityMap.receipt.runtimeStateBindingCount, RUNTIME_STATE_IDS.length);
  assert.equal(capabilityMap.receipt.referencesRetained, true);
  assert.deepEqual(capabilityMap.receipt.retainedReferenceCounts, {
    workspaceProfileRef: 1,
    executionProfileRef: 1,
    dataSourceProfileRef: 5,
    artifactProfileRef: 3,
    outputContractRef: 6
  });
  assert.match(capabilityMap.receipt.compiledFsmSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(capabilityMap.receipt), true);
  assert.equal(Object.isFrozen(capabilityMap.compiledFsm), true);
  assert.equal(Object.isFrozen(capabilityMap.compiledFsm.stateBindings), true);
  assert.deepEqual(
    capabilityMap.compiledFsm.stateBindings.find((state) => state.id === 'EXECUTE_SCRIPT')
      .capabilityRefs,
    {
      workspaceProfileRef: { id: 'workspace.legal-v1-sandbox', version: '1.0.0' },
      executionProfileRef: {
        id: 'execution-environment.lexpilot.scripts',
        version: '1.0.0'
      },
      artifactProfileRef: {
        id: 'artifact-profile.lexpilot.v1-output',
        version: '1.0.0'
      }
    }
  );
  assert.equal(JSON.stringify(capabilityMap.receipt).includes(projectRoot), false);
});

test('binds the active demo or SQLite runtime without exposing connection or path values', () => {
  const capabilityMap = loadWorkflowStateCapabilityMap({ projectRoot });
  const workspace = loadWorkspaceExecutionProfile({ projectRoot }).receipt;
  const dataSources = loadDataSourceSchemaProfile({ projectRoot });
  const demo = capabilityMap.bindApplication({
    workspaceExecutionBinding: workspace,
    dataSourceSchemaBinding: dataSources.resolveRuntime({ runtime: 'demo' }).receipt,
    sandboxEnabled: false
  });
  assert.equal(demo.activeRuntime, 'demo');
  assert.equal(demo.activeDataSourceProfileRef, null);
  assert.equal(demo.sandboxCapabilityBound, false);
  assert.equal(demo.sensitiveValuesExposed, false);

  const sqlite = capabilityMap.bindApplication({
    workspaceExecutionBinding: workspace,
    dataSourceSchemaBinding: dataSources.resolveRuntime({ runtime: 'sqlite' }).receipt,
    sandboxEnabled: true
  });
  assert.deepEqual(sqlite.activeDataSourceProfileRef, {
    bindingId: 'binding.legal-v1-data-sources',
    bindingVersion: '1.0.0',
    profileKey: 'sqlite-read-only',
    id: 'local.legal_cases',
    schemaVersion: 1,
    canonicalSha256:
      'sha256:f47dd6f99d28ee7c3d545375ae13e17bfc6dad34cbd4e715dceb68180d2c610f'
  });
  assert.equal(sqlite.sandboxCapabilityBound, true);
  assert.equal(JSON.stringify(sqlite).includes(projectRoot), false);
});

test('fails closed when Domain workflow, Workspace/Execution, or DataSource/Schema content drifts', () => {
  withTemporaryJson(
    domainPackPath,
    (domainPack) => {
      domainPack.workflows[0].states[0].goal = 'drifted goal';
    },
    (filename) =>
      expectCode(
        () => loadWorkflowStateCapabilityMap({ projectRoot, domainPackPath: filename }),
        'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
      )
  );
  withTemporaryJson(
    workspaceExecutionPath,
    (manifest) => {
      manifest.executionProfile.resources.cpuCores = 2;
    },
    (filename) =>
      expectCode(
        () =>
          loadWorkflowStateCapabilityMap({
            projectRoot,
            workspaceExecutionPath: filename
          }),
        'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
      )
  );
  withTemporaryJson(
    dataSourceSchemaPath,
    (manifest) => {
      manifest.profiles[0].defaultForRuntime = false;
    },
    (filename) =>
      expectCode(
        () =>
          loadWorkflowStateCapabilityMap({
            projectRoot,
            dataSourceSchemaPath: filename
          }),
        'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
      )
  );
});

test('rejects missing state coverage, unknown references, and transition drift', () => {
  withTemporaryJson(
    manifestPath,
    (manifest) => {
      manifest.runtimeWorkflow.states = manifest.runtimeWorkflow.states.filter(
        (state) => state.id !== 'EXECUTE_SCRIPT'
      );
    },
    (filename) =>
      expectCode(
        () => loadWorkflowStateCapabilityMap({ projectRoot, manifestPath: filename }),
        'WORKFLOW_STATE_CAPABILITY_MAP_INVALID'
      )
  );
  withTemporaryJson(
    manifestPath,
    (manifest) => {
      manifest.runtimeWorkflow.states.find(
        (state) => state.id === 'BUILD_ARTIFACT'
      ).capabilityRefs.artifactProfileRef.id = 'artifact-profile.private-unbound';
    },
    (filename) =>
      expectCode(
        () => loadWorkflowStateCapabilityMap({ projectRoot, manifestPath: filename }),
        'WORKFLOW_STATE_CAPABILITY_REFERENCE_MISSING'
      )
  );
  withTemporaryJson(
    manifestPath,
    (manifest) => {
      manifest.runtimeWorkflow.transitions[0].route = 'drifted-route';
    },
    (filename) =>
      expectCode(
        () => loadWorkflowStateCapabilityMap({ projectRoot, manifestPath: filename }),
        'WORKFLOW_STATE_CAPABILITY_MAP_INVALID'
      )
  );
});

test('rejects active binding receipts that no longer match the compiled state map', () => {
  const capabilityMap = loadWorkflowStateCapabilityMap({ projectRoot });
  const workspace = loadWorkspaceExecutionProfile({ projectRoot }).receipt;
  const dataSources = loadDataSourceSchemaProfile({ projectRoot });
  expectCode(
    () =>
      capabilityMap.bindApplication({
        workspaceExecutionBinding: {
          ...workspace,
          executionProfileRef: { id: 'execution-environment.unbound', version: '1.0.0' }
        },
        dataSourceSchemaBinding: dataSources.resolveRuntime({ runtime: 'demo' }).receipt,
        sandboxEnabled: false
      }),
    'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
  );
  expectCode(
    () =>
      capabilityMap.bindApplication({
        workspaceExecutionBinding: workspace,
        dataSourceSchemaBinding: {
          ...dataSources.resolveRuntime({ runtime: 'sqlite' }).receipt,
          selectedProfile: {
            ...dataSources.resolveRuntime({ runtime: 'sqlite' }).receipt.selectedProfile,
            canonicalSha256: `sha256:${'0'.repeat(64)}`
          }
        },
        sandboxEnabled: false
      }),
    'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
  );
  expectCode(
    () =>
      capabilityMap.bindApplication({
        workspaceExecutionBinding: workspace,
        dataSourceSchemaBinding: {
          ...dataSources.resolveRuntime({ runtime: 'sqlite' }).receipt,
          runtime: 'mysql'
        },
        sandboxEnabled: false
      }),
    'WORKFLOW_STATE_CAPABILITY_BINDING_DRIFT'
  );
});
