const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WorkspaceExecutionProfileError,
  loadWorkspaceExecutionProfile
} = require('../src/v1/workspace-execution-profile.cjs');

const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(
  projectRoot,
  'configs',
  'execution-profiles',
  'legal-v1-sandbox.json'
);
const domainPackPath = path.join(
  projectRoot,
  'configs',
  'domain-packs',
  'legal-compliance.domain.json'
);

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-workspace-execution-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

test('loads a versioned binding and resolves a Hypha-validated execution environment', () => {
  const profile = loadWorkspaceExecutionProfile({ projectRoot });
  assert.deepEqual(profile.receipt.domainPackRef, {
    id: 'domain.legal-compliance.v0-v1',
    version: '0.16.0'
  });
  assert.deepEqual(profile.receipt.workspaceProfileRef, {
    id: 'workspace.legal-v1-sandbox',
    version: '1.0.0'
  });
  assert.deepEqual(profile.receipt.executionProfileRef, {
    id: 'execution-environment.lexpilot.scripts',
    version: '1.0.0'
  });
  assert.equal(profile.receipt.hyphaExecutionEnvironmentValidated, true);
  assert.equal(profile.receipt.hyphaSourceModified, false);
  assert.equal(Object.isFrozen(profile.receipt), true);

  const privateImage = 'private-registry.invalid/lexpilot:acceptance';
  const privateDigest = `sha256:${'a'.repeat(64)}`;
  const resolved = profile.resolve({
    LEGAL_V1_SANDBOX_IMAGE: privateImage,
    LEGAL_V1_SANDBOX_IMAGE_DIGEST: privateDigest
  });
  assert.equal(
    resolved.workspaceRoot,
    path.join(projectRoot, 'data', 'sandbox-workspaces')
  );
  assert.equal(resolved.executionEnvironment.image.reference, privateImage);
  assert.equal(resolved.executionEnvironment.image.digest, privateDigest);
  assert.equal(resolved.executionEnvironment.network.mode, 'disabled');
  assert.equal(resolved.executionEnvironment.filesystem.rootFilesystem, 'read_only');
  assert.equal(resolved.executionEnvironment.lifecycle.reuse, 'never');
  assert.match(resolved.executionEnvironment.revision, /^[0-9a-f]{64}$/);
  const receiptText = JSON.stringify(profile.receipt);
  assert.equal(receiptText.includes(privateImage), false);
  assert.equal(receiptText.includes(projectRoot), false);
});

test('fails closed when DomainPack and binding versions drift', () => {
  withTemporaryDirectory((directory) => {
    const driftedDomain = readJson(domainPackPath);
    driftedDomain.version = '0.17.0';
    const driftedDomainPath = path.join(directory, 'domain.json');
    fs.writeFileSync(driftedDomainPath, JSON.stringify(driftedDomain));

    assert.throws(
      () =>
        loadWorkspaceExecutionProfile({
          projectRoot,
          manifestPath,
          domainPackPath: driftedDomainPath
        }),
      (error) =>
        error instanceof WorkspaceExecutionProfileError &&
        error.code === 'WORKSPACE_EXECUTION_BINDING_DRIFT'
    );
  });
});

test('fails closed when the Workspace reference or execution security policy drifts', () => {
  withTemporaryDirectory((directory) => {
    const referenceDrift = readJson(manifestPath);
    referenceDrift.bindings.workspaceProfileRef.version = '1.0.1';
    const referencePath = path.join(directory, 'reference-drift.json');
    fs.writeFileSync(referencePath, JSON.stringify(referenceDrift));
    assert.throws(
      () => loadWorkspaceExecutionProfile({ projectRoot, manifestPath: referencePath }),
      (error) => error.code === 'WORKSPACE_EXECUTION_BINDING_DRIFT'
    );

    const securityDrift = readJson(manifestPath);
    securityDrift.executionProfile.network.mode = 'host';
    const securityPath = path.join(directory, 'security-drift.json');
    fs.writeFileSync(securityPath, JSON.stringify(securityDrift));
    assert.throws(
      () => loadWorkspaceExecutionProfile({ projectRoot, manifestPath: securityPath }),
      (error) =>
        ['WORKSPACE_EXECUTION_PROFILE_INVALID', 'WORKSPACE_EXECUTION_BINDING_DRIFT'].includes(
          error.code
        )
    );
  });
});

test('rejects undeclared manifest fields, missing files, missing image pins, and broad roots', () => {
  withTemporaryDirectory((directory) => {
    const undeclared = readJson(manifestPath);
    undeclared.privateHostPath = 'D:/private/customer';
    const undeclaredPath = path.join(directory, 'undeclared.json');
    fs.writeFileSync(undeclaredPath, JSON.stringify(undeclared));
    assert.throws(
      () => loadWorkspaceExecutionProfile({ projectRoot, manifestPath: undeclaredPath }),
      (error) => error.code === 'WORKSPACE_EXECUTION_PROFILE_INVALID'
    );
    assert.throws(
      () => loadWorkspaceExecutionProfile({ projectRoot, manifestPath: path.join(directory, 'missing.json') }),
      (error) => error.code === 'WORKSPACE_EXECUTION_PROFILE_MISSING'
    );

    const profile = loadWorkspaceExecutionProfile({ projectRoot });
    assert.throws(
      () => profile.resolve({ LEGAL_V1_SANDBOX_IMAGE: 'lexpilot:test' }),
      (error) => error.code === 'WORKSPACE_EXECUTION_ENVIRONMENT_MISSING'
    );
    assert.throws(
      () =>
        profile.resolve({
          LEGAL_V1_SANDBOX_IMAGE: 'lexpilot:test',
          LEGAL_V1_SANDBOX_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
          LEGAL_V1_SANDBOX_WORKSPACE_ROOT: path.parse(projectRoot).root
        }),
      (error) => error.code === 'WORKSPACE_EXECUTION_ENVIRONMENT_INVALID'
    );
  });
});
