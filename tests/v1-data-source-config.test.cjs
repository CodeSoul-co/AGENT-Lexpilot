const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaAdaptersLocal } = require('../scripts/hypha-paths.cjs');
const {
  createConfiguredSQLiteDataSource,
  readDataSourceManifest
} = require('../src/v1/data-source-config.cjs');

const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(
  projectRoot,
  'configs',
  'data-sources',
  'legal-cases.sqlite.json'
);
const writeManifestPath = path.join(
  projectRoot,
  'configs',
  'data-sources',
  'legal-cases-write.sqlite.json'
);

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-config-'));
  const databasePath = path.join(directory, 'configured.sqlite');
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec('CREATE TABLE labor_cases (case_id TEXT PRIMARY KEY, year INTEGER NOT NULL);');
  database.close?.();
  return { directory, databasePath };
}

test('public manifest contains policy and an environment reference, never a local path', () => {
  const manifest = readDataSourceManifest(manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.engine, 'sqlite');
  assert.equal(manifest.accessMode, 'read-only');
  assert.equal(manifest.databasePathEnv, 'LEGAL_V1_SQLITE_PATH');
  assert.deepEqual(manifest.allowedTables, ['labor_cases']);
  assert.deepEqual(manifest.allowedColumns, [
    'year',
    'issue_type',
    'outcome',
    'compensation_amount'
  ]);
  assert.equal(Object.hasOwn(manifest, 'databasePath'), false);
  assert.equal(Object.hasOwn(manifest, 'credentials'), false);
});

test('creates the configured data source from an untracked environment path', async () => {
  const fixture = createDatabase();
  try {
    const source = createConfiguredSQLiteDataSource({
      projectRoot,
      manifestPath,
      env: { LEGAL_V1_SQLITE_PATH: fixture.databasePath }
    });
    assert.equal(source.describe().mode, 'read-only');
    assert.equal((await source.testConnection()).status, 'connected');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('write profile exposes governance controls but never a database path or credential', () => {
  const manifest = readDataSourceManifest(writeManifestPath);
  assert.equal(manifest.accessMode, 'read-write');
  assert.equal(manifest.databasePathEnv, 'LEGAL_V1_SQLITE_WRITE_PATH');
  assert.deepEqual(manifest.allowedWriteOperations, ['insert', 'update', 'delete']);
  assert.equal(manifest.requiresHumanReview, true);
  assert.equal(manifest.maxAffectedRows, 1);
  assert.equal(Object.hasOwn(manifest, 'databasePath'), false);
  assert.equal(Object.hasOwn(manifest, 'credentials'), false);
});

test('fails closed when the database environment reference is absent', () => {
  assert.throws(
    () => createConfiguredSQLiteDataSource({ projectRoot, manifestPath, env: {} }),
    /LEGAL_V1_SQLITE_PATH is required/
  );
});

test('rejects undeclared manifest fields instead of accepting inline secrets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-manifest-'));
  const unsafeManifestPath = path.join(directory, 'unsafe.json');
  try {
    fs.writeFileSync(
      unsafeManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'unsafe',
        engine: 'sqlite',
        databasePathEnv: 'LEGAL_V1_SQLITE_PATH',
        accessMode: 'read-only',
        allowedTables: ['labor_cases'],
        allowedColumns: ['year'],
        timeoutMs: 15000,
        maxRows: 500,
        maxOutputBytes: 1048576,
        password: '[REJECTED]'
      })
    );
    assert.throws(() => readDataSourceManifest(unsafeManifestPath), /undeclared keys: password/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
