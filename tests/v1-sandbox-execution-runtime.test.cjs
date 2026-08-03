const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { loadHyphaCore } = require('../scripts/hypha-paths.cjs');
const { createSandboxArtifactRepository } = require('../src/v1/sandbox-artifact-repository.cjs');
const { createDockerSandboxProviderFactory } = require('../src/v1/docker-sandbox-provider-factory.cjs');
const { buildSandboxEnvironment, requireSandboxRequest, requireSafeScript } = require('../src/v1/sandbox-execution-policy.cjs');
const { REQUIRED_CAPABILITIES, createSandboxExecutionRuntime } = require('../src/v1/sandbox-execution-runtime.cjs');

const imageReference = 'python:3.12-alpine';
const imageDigest = `sha256:${'a'.repeat(64)}`;

function hash(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-sandbox-runtime-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const calls = [];
  let workspacePath;
  const providerFactory = async (value) => {
    workspacePath = value;
    if (options.factoryError) throw options.factoryError;
    let record = { id: 'sandbox.mock.1', revision: 1, status: 'created' };
    return {
      async health() {
        calls.push('health');
        return { status: options.unhealthy ? 'unhealthy' : 'healthy' };
      },
      async capabilities() {
        calls.push('capabilities');
        const capabilities = Object.fromEntries(REQUIRED_CAPABILITIES.map((name) => [name, true]));
        if (options.missingCapability) capabilities[options.missingCapability] = false;
        return capabilities;
      },
      async create(request) {
        calls.push(['create', request]);
        return record;
      },
      async start(request) {
        calls.push(['start', request]);
        record = { ...record, revision: 2, status: 'ready' };
        return record;
      },
      async execute(request) {
        calls.push(['execute', request]);
        if (options.executeError) throw options.executeError;
        const stagedInput = path.join(workspacePath, 'inputs', 'case.txt');
        if (fs.existsSync(stagedInput)) calls.push(['stagedInput', fs.readFileSync(stagedInput, 'utf8')]);
        const output = Buffer.from('generated-by-sandbox', 'utf8');
        fs.writeFileSync(path.join(workspacePath, 'result.txt'), output);
        return {
          status: 'completed',
          exitCode: 0,
          changedFiles: [{
            path: 'result.txt',
            operation: 'created',
            afterHash: hash(output),
            afterSizeBytes: output.byteLength,
            detectedAt: '2026-08-03T00:00:01.000Z'
          }],
          generatedArtifactRefs: [],
          stdoutArtifactRef: 'artifact:mock:stdout',
          externalReceipt: {
            id: 'receipt.mock.1',
            providerId: 'provider.mock',
            providerExecutionRef: 'private-container-reference',
            status: 'completed',
            issuedAt: '2026-08-03T00:00:01.000Z',
            receiptHash: hash('receipt'),
            metadata: { cleanupComplete: true }
          },
          metadata: {
            cleanup: { complete: true, containerAbsent: true, stopAttempted: true },
            processTreeTerminationVerified: true
          }
        };
      },
      async status() {
        calls.push('status');
        return record;
      },
      async terminate() {
        calls.push('terminate');
        record = { ...record, revision: 3, status: 'terminated' };
      },
      async cleanup() {
        calls.push('cleanup');
        record = { ...record, revision: 4, status: 'cleaned' };
      },
      async close() {
        calls.push('close');
      }
    };
  };
  const storedFiles = [];
  const artifactRepository = {
    async storeGeneratedFiles(input) {
      calls.push(['storeGeneratedFiles', input.changedFiles]);
      if (options.artifactError) throw options.artifactError;
      storedFiles.push(fs.readFileSync(path.join(input.workspacePath, 'result.txt'), 'utf8'));
      return ['artifact:mock:generated'];
    }
  };
  return {
    root,
    workspaceRoot,
    calls,
    storedFiles,
    providerFactory,
    artifactRepository,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

async function runtimeFor(value, extra = {}) {
  return createSandboxExecutionRuntime({
    workspaceRoot: value.workspaceRoot,
    imageReference,
    imageDigest,
    providerFactory: value.providerFactory,
    artifactRepository: value.artifactRepository,
    ...extra
  });
}

test('Sandbox policy is immutable, schema-valid, and fixed to the requirement limits', () => {
  const environment = buildSandboxEnvironment({ imageReference, imageDigest });
  const { validateExecutionEnvironmentSpec } = loadHyphaCore();
  assert.equal(validateExecutionEnvironmentSpec(environment).provider, 'docker');
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(environment.resources.cpuCores, 1);
  assert.equal(environment.resources.memoryMb, 512);
  assert.equal(environment.defaultTimeoutMs, 30_000);
  assert.equal(environment.network.mode, 'disabled');
  assert.equal(environment.network.dnsPolicy, 'disabled');
  assert.equal(environment.filesystem.rootFilesystem, 'read_only');
  assert.equal(environment.filesystem.allowHostPathMounts, false);
  assert.equal(environment.lifecycle.reuse, 'never');
  assert.equal(environment.security.privileged, false);
  assert.deepEqual(environment.security.dropCapabilities, ['ALL']);
  assert.throws(() => requireSafeScript({ language: 'python', script: 'print(1)', path: '../x' }), /undeclared/);
  assert.throws(
    () => requireSandboxRequest({
      language: 'python',
      script: 'print(1)',
      inputFiles: [{ path: '../escape.txt', contentBase64: '', contentSha256: hash('') }]
    }),
    /stay within/
  );
});

test('Docker factory consumes the pinned Hypha public provider without contacting Docker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-docker-factory-'));
  try {
    const factory = createDockerSandboxProviderFactory({
      artifactRepository: { outputArtifacts: { openStream() { throw new Error('not called'); } } }
    });
    const provider = await factory(root);
    const capabilities = await provider.capabilities();
    for (const name of REQUIRED_CAPABILITIES) assert.equal(capabilities[name], true);
    await provider.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Human Review blocks Python execution, then approval runs once and cleans every layer', async () => {
  const value = fixture();
  try {
    const runtime = await runtimeFor(value);
    const script = 'print("private-script-value")';
    const inputContent = 'private-input-file';
    const planned = await runtime.plan({
      language: 'python',
      script,
      inputFiles: [{
        path: 'inputs/case.txt',
        contentBase64: Buffer.from(inputContent).toString('base64'),
        contentSha256: hash(inputContent)
      }],
      runId: 'run-python',
      sessionId: 'session-python'
    });
    assert.equal(planned.status, 'awaiting_confirmation');
    assert.equal(planned.executionAttempted, false);
    assert.equal(planned.plan.language, 'python');
    assert.equal(planned.plan.scriptSha256, hash(script));
    assert.equal(planned.plan.inputFiles[0].contentSha256, hash(inputContent));
    assert.equal(planned.plan.policy.cpuCores, 1);
    assert.equal(planned.plan.policy.memoryMb, 512);
    assert.equal(planned.plan.policy.timeoutMs, 30_000);
    assert.equal(planned.plan.policy.network, 'disabled');
    assert.equal(JSON.stringify(planned).includes(script), false);
    assert.equal(JSON.stringify(planned).includes(inputContent), false);
    assert.deepEqual(value.calls, []);

    const approved = await runtime.approve({
      invocationId: planned.invocationId,
      runId: 'run-python',
      approvedAt: '2026-08-03T00:00:00.000Z'
    });
    assert.equal(approved.status, 'completed');
    assert.equal(approved.result.cleanupEvidence.executionContainerAbsent, true);
    assert.equal(approved.result.cleanupEvidence.processTreeTerminationVerified, true);
    assert.equal(approved.result.generatedArtifactRefs.includes('artifact:mock:generated'), true);
    assert.equal(approved.result.providerReceipt.providerExecutionRef, undefined);
    assert.equal(JSON.stringify(approved).includes('private-script-value'), false);
    assert.equal(JSON.stringify(approved).includes(inputContent), false);
    assert.deepEqual(value.storedFiles, ['generated-by-sandbox']);
    assert.deepEqual(value.calls.find((call) => Array.isArray(call) && call[0] === 'stagedInput'), ['stagedInput', inputContent]);
    const execute = value.calls.find((call) => Array.isArray(call) && call[0] === 'execute')[1];
    assert.equal(execute.executable, 'python3');
    assert.deepEqual(execute.args, ['/workspace/task.py']);
    assert.equal(execute.timeoutMs, 30_000);
    assert.equal(approved.governanceReceipt.eventTypes.includes('human.review.requested'), true);
    assert.equal(approved.governanceReceipt.eventTypes.includes('human.review.approved'), true);
    assert.equal(approved.governanceReceipt.eventTypes.includes('human.review.resolved'), true);
    assert.deepEqual(
      value.calls.filter((call) => typeof call === 'string'),
      ['health', 'capabilities', 'status', 'terminate', 'status', 'cleanup', 'close']
    );
    assert.deepEqual(fs.readdirSync(value.workspaceRoot), []);
  } finally {
    value.cleanup();
  }
});

test('Shell uses a literal argv and rejected review never creates a Provider', async () => {
  const value = fixture();
  try {
    const runtime = await runtimeFor(value);
    const shellPlan = await runtime.plan({ language: 'shell', script: 'printf ok', runId: 'run-shell', sessionId: 'session-shell' });
    const approved = await runtime.approve({ invocationId: shellPlan.invocationId, runId: 'run-shell' });
    assert.equal(approved.status, 'completed');
    const execute = value.calls.find((call) => Array.isArray(call) && call[0] === 'execute')[1];
    assert.equal(execute.executable, '/bin/sh');
    assert.deepEqual(execute.args, ['/workspace/task.sh']);

    value.calls.length = 0;
    const rejectedPlan = await runtime.plan({ language: 'python', script: 'print(1)', runId: 'run-reject', sessionId: 'session-reject' });
    const rejected = await runtime.reject({ invocationId: rejectedPlan.invocationId, runId: 'run-reject' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.executionAttempted, false);
    assert.equal(rejected.governanceReceipt.eventTypes.includes('human.review.rejected'), true);
    assert.deepEqual(value.calls, []);
  } finally {
    value.cleanup();
  }
});

test('Provider failures fail closed and still remove the independent Workspace', async () => {
  for (const failure of [
    { unhealthy: true },
    { missingCapability: 'networkIsolation' },
    { executeError: new Error('mock execution failed') },
    { factoryError: new Error('mock factory failed') }
  ]) {
    const value = fixture(failure);
    try {
      const runtime = await runtimeFor(value);
      const planned = await runtime.plan({ language: 'python', script: 'print(1)', runId: `run-fail-${Object.keys(failure)[0]}`, sessionId: 'session-fail' });
      const completed = await runtime.approve({ invocationId: planned.invocationId, runId: `run-fail-${Object.keys(failure)[0]}` });
      assert.equal(completed.status, 'failed');
      assert.deepEqual(fs.readdirSync(value.workspaceRoot), []);
      if (!failure.factoryError) assert.equal(value.calls.includes('close'), true);
      if (failure.executeError) {
        assert.equal(value.calls.includes('terminate'), true);
        assert.equal(value.calls.includes('cleanup'), true);
      }
    } finally {
      value.cleanup();
    }
  }
});

test('Artifact persistence failure is safe, visible, and retains cleanup evidence', async () => {
  const value = fixture({ artifactError: new Error('private artifact path') });
  try {
    const runtime = await runtimeFor(value);
    const planned = await runtime.plan({ language: 'python', script: 'print(1)', runId: 'run-artifact-fail', sessionId: 'session-artifact-fail' });
    const completed = await runtime.approve({ invocationId: planned.invocationId, runId: 'run-artifact-fail' });
    assert.equal(completed.status, 'failed');
    assert.equal(completed.result.errorCode, 'ARTIFACT_PERSISTENCE_FAILED');
    assert.equal(completed.result.cleanupEvidence.executionContainerAbsent, true);
    assert.equal(JSON.stringify(completed).includes('private artifact path'), false);
    assert.deepEqual(fs.readdirSync(value.workspaceRoot), []);
  } finally {
    value.cleanup();
  }
});

test('generated files use Hypha ArtifactStoreProvider and traversal is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-sandbox-artifact-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const repository = createSandboxArtifactRepository({ rootPath: path.join(root, 'artifacts') });
  try {
    const content = Buffer.from('artifact-content');
    fs.writeFileSync(path.join(workspace, 'report.txt'), content);
    const refs = await repository.storeGeneratedFiles({
      workspacePath: workspace,
      executionId: 'execution-artifact',
      runId: 'run-artifact',
      changedFiles: [{ path: 'report.txt', operation: 'created', afterHash: hash(content) }]
    });
    assert.equal(refs.length, 1);
    assert.match(refs[0], /^artifact:lexpilot\.sandbox-artifacts\.local:sandbox-generated\//);
    const stream = repository.outputArtifacts.openStream({ executionId: 'execution-output', stream: 'stdout' });
    await stream.append(Buffer.from('stdout-content'));
    const outputRef = await stream.complete();
    assert.match(outputRef, /^artifact:lexpilot\.sandbox-artifacts\.local:sandbox-output\//);
    assert.equal(repository.describe().backend, 'hypha.LocalFilesystemExecutionArtifactStore');
    await assert.rejects(
      repository.storeGeneratedFiles({
        workspacePath: workspace,
        executionId: 'execution-escape',
        runId: 'run-escape',
        changedFiles: [{ path: '../outside.txt', operation: 'created' }]
      }),
      /stay within/
    );
  } finally {
    await repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
