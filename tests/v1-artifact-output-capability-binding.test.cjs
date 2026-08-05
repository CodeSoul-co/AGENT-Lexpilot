const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ArtifactOutputCapabilityBindingError,
  artifactOutputBindingRef,
  loadArtifactOutputCapabilityBinding
} = require('../src/v1/artifact-output-capability-binding.cjs');
const { loadDataSourceSchemaProfile } = require('../src/v1/data-source-schema-profile.cjs');
const { createExecutionArtifactRepository } = require('../src/v1/execution-artifact-repository.cjs');
const { loadWorkflowStateCapabilityMap } = require('../src/v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');

const projectRoot = path.resolve(__dirname, '..');

function activeStateBinding(options = {}) {
  const workspace = loadWorkspaceExecutionProfile({ projectRoot });
  const dataSource = loadDataSourceSchemaProfile({ projectRoot }).resolveRuntime({ runtime: 'demo' });
  return loadWorkflowStateCapabilityMap({ projectRoot }).bindApplication({
    workspaceExecutionBinding: workspace.receipt,
    dataSourceSchemaBinding: dataSource.receipt,
    sandboxEnabled: options.sandboxEnabled ?? false
  });
}

function analysisArtifact(content = '# Bound analysis\n') {
  return {
    artifactId: 'artifact-0123456789ab',
    type: 'analysis-document',
    fileName: 'analysis.md',
    mimeType: 'text/markdown; charset=utf-8',
    executionTimeMs: 12,
    content,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex')
  };
}

function fakeAnalysisRepository(overrides = {}) {
  let calls = 0;
  let deleteCalls = 0;
  const descriptor = {
    storeId: 'lexpilot.execution-artifacts.local',
    backend: 'hypha.LocalFilesystemExecutionArtifactStore',
    visibility: 'private-local',
    maxObjectBytes: 1_048_576,
    rootPathExposed: false,
    ...(overrides.descriptor ?? {})
  };
  return {
    describe: () => descriptor,
    async storeAnalysisArtifact({ artifact }) {
      calls += 1;
      return {
        storeId: descriptor.storeId,
        objectKey: `analysis/${'a'.repeat(64)}.md`,
        versionId: undefined,
        etag: `sha256:${artifact.contentSha256}`,
        contentSha256: artifact.contentSha256,
        sizeBytes: Buffer.byteLength(artifact.content, 'utf8'),
        backend: descriptor.backend,
        ...(overrides.receipt ?? {})
      };
    },
    async readAnalysisArtifact() {},
    async deleteAnalysisArtifact() {
      deleteCalls += 1;
      return { status: 'deleted' };
    },
    async health() {},
    async stats() {},
    async close() {},
    calls: () => calls,
    deleteCalls: () => deleteCalls
  };
}

test('binds the versioned Artifact profile to the real Hypha repository and verified publication receipt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-output-binding-'));
  const rawRepository = createExecutionArtifactRepository({ rootPath: directory, projectRoot });
  try {
    const profile = loadArtifactOutputCapabilityBinding({ projectRoot });
    const bound = profile.bindApplication({
      stateCapabilityBinding: activeStateBinding(),
      analysisRepository: rawRepository,
      sandboxEnabled: false
    });
    assert.deepEqual(bound.receipt.activeStores, ['analysis']);
    assert.equal(bound.receipt.repositoryDescriptorsValidated, true);
    assert.equal(Object.isFrozen(bound.receipt), true);
    assert.deepEqual(artifactOutputBindingRef(bound.receipt), {
      id: 'binding.legal-v1-artifact-outputs',
      version: '1.0.0',
      manifestCanonicalSha256: bound.receipt.manifestCanonicalSha256
    });

    const artifact = analysisArtifact();
    const receipt = await bound.analysisRepository.storeAnalysisArtifact({
      sessionId: 'private-session',
      runId: 'private-run',
      artifact,
      publication: { status: 'completed', executionAttempted: true }
    });
    assert.equal(receipt.storeId, 'lexpilot.execution-artifacts.local');
    assert.deepEqual(receipt.artifactProfileRef, {
      id: 'artifact-profile.lexpilot.v1-output',
      version: '1.0.0'
    });
    assert.deepEqual(receipt.outputContractRef, {
      id: 'output.legal-professional-query',
      version: '1.0.0'
    });
    assert.equal(JSON.stringify(receipt).includes(directory), false);
    const stored = await bound.analysisRepository.readAnalysisArtifact(receipt);
    assert.equal(stored.content, artifact.content);
    const deletion = await bound.analysisRepository.deleteAnalysisArtifact(receipt);
    assert.equal(deletion.status, 'deleted');
    assert.equal((await rawRepository.stats()).objects, 0);
  } finally {
    await rawRepository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when the Workflow State manifest or declared Artifact store drifts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-output-drift-'));
  try {
    const statePath = path.join(directory, 'state.json');
    const bindingPath = path.join(directory, 'artifact-output.json');
    const state = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'configs/capability-bindings/legal-workflow-state-capabilities.json'), 'utf8')
    );
    const binding = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'configs/capability-bindings/legal-v1-artifact-outputs.json'), 'utf8')
    );
    state.runtimeWorkflow.states[0].id = 'DRIFTED';
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(bindingPath, JSON.stringify(binding));
    assert.throws(
      () =>
        loadArtifactOutputCapabilityBinding({
          projectRoot,
          manifestPath: bindingPath,
          stateCapabilityPath: statePath
        }),
      (error) =>
        error instanceof ArtifactOutputCapabilityBindingError &&
        error.code === 'ARTIFACT_OUTPUT_BINDING_DRIFT'
    );

    fs.writeFileSync(
      statePath,
      fs.readFileSync(path.join(projectRoot, 'configs/capability-bindings/legal-workflow-state-capabilities.json'))
    );
    binding.stores[0].storeId = 'private.unbound.store';
    fs.writeFileSync(bindingPath, JSON.stringify(binding));
    assert.throws(
      () =>
        loadArtifactOutputCapabilityBinding({
          projectRoot,
          manifestPath: bindingPath,
          stateCapabilityPath: statePath
        }),
      (error) => error?.code === 'ARTIFACT_OUTPUT_BINDING_DRIFT'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects runtime Repository drift and requires the Sandbox store when it is activated', () => {
  const profile = loadArtifactOutputCapabilityBinding({ projectRoot });
  assert.throws(
    () =>
      profile.bindApplication({
        stateCapabilityBinding: activeStateBinding(),
        analysisRepository: fakeAnalysisRepository({
          descriptor: { storeId: 'private.unbound.store' }
        }),
        sandboxEnabled: false
      }),
    (error) => error?.code === 'ARTIFACT_OUTPUT_REPOSITORY_DRIFT'
  );
  assert.throws(
    () =>
      profile.bindApplication({
        stateCapabilityBinding: activeStateBinding({ sandboxEnabled: true }),
        analysisRepository: fakeAnalysisRepository(),
        sandboxEnabled: true
      }),
    (error) => error?.code === 'ARTIFACT_OUTPUT_REPOSITORY_MISSING'
  );
});

test('blocks unsafe publication before Store access and rejects a drifted Store receipt', async () => {
  const profile = loadArtifactOutputCapabilityBinding({ projectRoot });
  const repository = fakeAnalysisRepository();
  const bound = profile.bindApplication({
    stateCapabilityBinding: activeStateBinding(),
    analysisRepository: repository,
    sandboxEnabled: false
  });
  await assert.rejects(
    bound.analysisRepository.storeAnalysisArtifact({
      sessionId: 'session',
      runId: 'run',
      artifact: { ...analysisArtifact(), mimeType: 'text/html' },
      publication: { status: 'completed', executionAttempted: true }
    }),
    (error) => error?.code === 'ARTIFACT_OUTPUT_PUBLICATION_REJECTED'
  );
  assert.equal(repository.calls(), 0);

  const driftedRepository = fakeAnalysisRepository({ receipt: { storeId: 'private.unbound.store' } });
  const drifted = profile.bindApplication({
    stateCapabilityBinding: activeStateBinding(),
    analysisRepository: driftedRepository,
    sandboxEnabled: false
  });
  await assert.rejects(
    drifted.analysisRepository.storeAnalysisArtifact({
      sessionId: 'session',
      runId: 'run',
      artifact: analysisArtifact(),
      publication: { status: 'completed', executionAttempted: true }
    }),
    (error) => error?.code === 'ARTIFACT_OUTPUT_RECEIPT_DRIFT'
  );
  assert.equal(driftedRepository.calls(), 1);

  const receipt = await bound.analysisRepository.storeAnalysisArtifact({
    sessionId: 'session',
    runId: 'run-2',
    artifact: analysisArtifact(),
    publication: { status: 'completed', executionAttempted: true }
  });
  await assert.rejects(
    bound.analysisRepository.deleteAnalysisArtifact({
      ...receipt,
      artifactOutputBindingRef: {
        ...receipt.artifactOutputBindingRef,
        manifestCanonicalSha256: `sha256:${'0'.repeat(64)}`
      }
    }),
    (error) => error?.code === 'ARTIFACT_OUTPUT_RECEIPT_DRIFT'
  );
  assert.equal(repository.deleteCalls(), 0);
});
