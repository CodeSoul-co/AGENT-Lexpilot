const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DataSourceSchemaProfileError,
  loadDataSourceSchemaProfile
} = require('../src/v1/data-source-schema-profile.cjs');

const projectRoot = path.resolve(__dirname, '..');

function withConfigProject(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-data-source-binding-'));
  const capabilityDirectory = path.join(directory, 'configs', 'capability-bindings');
  const dataSourceDirectory = path.join(directory, 'configs', 'data-sources');
  const domainDirectory = path.join(directory, 'configs', 'domain-packs');
  fs.mkdirSync(capabilityDirectory, { recursive: true });
  fs.mkdirSync(dataSourceDirectory, { recursive: true });
  fs.mkdirSync(domainDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, 'configs', 'capability-bindings', 'legal-v1-data-sources.json'),
    path.join(capabilityDirectory, 'legal-v1-data-sources.json')
  );
  for (const name of [
    'legal-cases.sqlite.json',
    'legal-cases-write.sqlite.json',
    'legal-cases.postgresql.json',
    'legal-cases.mysql.json'
  ]) {
    fs.copyFileSync(
      path.join(projectRoot, 'configs', 'data-sources', name),
      path.join(dataSourceDirectory, name)
    );
  }
  fs.copyFileSync(
    path.join(projectRoot, 'configs', 'domain-packs', 'legal-compliance.domain.json'),
    path.join(domainDirectory, 'legal-compliance.domain.json')
  );
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('loads four bound manifests and resolves only their declared runtime profiles', () => {
  const profile = loadDataSourceSchemaProfile({ projectRoot });
  assert.equal(profile.receipt.profiles.length, 4);
  assert.deepEqual(profile.receipt.schemaSnapshotContractRef, {
    id: 'schema-snapshot.allowlisted.v1',
    version: '1.0.0'
  });
  assert.equal(profile.receipt.connectionValuesExposed, false);
  assert.equal(profile.receipt.hyphaSourceModified, false);
  assert.equal(Object.isFrozen(profile.receipt), true);
  assert.equal(Object.isFrozen(profile.receipt.profiles), true);

  assert.equal(profile.resolveRuntime({ runtime: 'demo' }).receipt.selectedProfile, null);
  assert.equal(
    profile.resolveRuntime({ runtime: 'demo' }).receipt.expectedRuntime,
    'business-demo-readonly'
  );
  assert.equal(
    profile.resolveRuntime({ runtime: 'sqlite' }).receipt.selectedProfile.id,
    'local.legal_cases'
  );
  assert.equal(
    profile.resolveRuntime({ runtime: 'sqlite' }).receipt.expectedRuntime,
    'sqlite-readonly'
  );
  assert.equal(
    profile.resolveRuntime({
      runtime: 'sqlite',
      configuredManifest: 'configs/data-sources/legal-cases-write.sqlite.json'
    }).receipt.selectedProfile.id,
    'local.legal_cases.write'
  );
  assert.equal(
    profile.resolveRuntime({
      runtime: 'sqlite',
      configuredManifest: 'configs/data-sources/legal-cases-write.sqlite.json'
    }).receipt.expectedRuntime,
    'sqlite-governed-write'
  );
  assert.equal(
    profile.resolveRuntime({ runtime: 'postgresql' }).receipt.selectedProfile.id,
    'network.legal_cases.postgresql'
  );
  assert.equal(
    profile.resolveRuntime({ runtime: 'mysql' }).receipt.selectedProfile.id,
    'network.legal_cases.mysql'
  );
  const serialized = JSON.stringify(profile.receipt);
  assert.equal(serialized.includes(projectRoot), false);
  assert.equal(serialized.includes('LEGAL_V1_PG_PASSWORD'), false);
});

test('fails closed when a bound manifest changes without updating its canonical reference', () => {
  withConfigProject((temporaryProjectRoot) => {
    const filename = path.join(
      temporaryProjectRoot,
      'configs',
      'data-sources',
      'legal-cases.sqlite.json'
    );
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    manifest.allowedColumns.push('private_unbound_column');
    fs.writeFileSync(filename, JSON.stringify(manifest));
    assert.throws(
      () => loadDataSourceSchemaProfile({ projectRoot: temporaryProjectRoot }),
      (error) =>
        error instanceof DataSourceSchemaProfileError &&
        error.code === 'DATA_SOURCE_SCHEMA_BINDING_DRIFT'
    );
  });
});

test('fails closed when the snapshot contract or required profile set drifts', () => {
  withConfigProject((temporaryProjectRoot) => {
    const filename = path.join(
      temporaryProjectRoot,
      'configs',
      'capability-bindings',
      'legal-v1-data-sources.json'
    );
    const binding = JSON.parse(fs.readFileSync(filename, 'utf8'));
    binding.schemaSnapshotContract.columnAttributes = ['name', 'type'];
    fs.writeFileSync(filename, JSON.stringify(binding));
    assert.throws(
      () => loadDataSourceSchemaProfile({ projectRoot: temporaryProjectRoot }),
      (error) => error.code === 'DATA_SOURCE_SCHEMA_BINDING_DRIFT'
    );

    binding.schemaSnapshotContract.columnAttributes = [
      'name',
      'type',
      'nullable',
      'primaryKeyPosition'
    ];
    binding.profiles.pop();
    fs.writeFileSync(filename, JSON.stringify(binding));
    assert.throws(
      () => loadDataSourceSchemaProfile({ projectRoot: temporaryProjectRoot }),
      (error) => error.code === 'DATA_SOURCE_SCHEMA_PROFILE_INVALID'
    );
  });
});

test('rejects unbound manifest paths and unsupported runtimes without exposing the path', () => {
  const profile = loadDataSourceSchemaProfile({ projectRoot });
  const privatePath = 'D:/private/customer-data-source.json';
  for (const run of [
    () => profile.resolveRuntime({ runtime: 'sqlite', configuredManifest: privatePath }),
    () => profile.resolveRuntime({ runtime: 'oracle' })
  ]) {
    assert.throws(run, (error) => {
      assert.equal(error instanceof DataSourceSchemaProfileError, true);
      assert.equal(error.message.includes(privatePath), false);
      return true;
    });
  }
});
