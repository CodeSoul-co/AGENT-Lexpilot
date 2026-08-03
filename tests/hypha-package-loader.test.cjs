const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  loadHyphaAdaptersLocal,
  loadHyphaCore,
  loadHyphaPackage
} = require('../scripts/hypha-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('loads the pinned read-only Hypha Core execution contracts', () => {
  const core = loadHyphaCore(projectRoot);
  assert.equal(typeof core.validateWorkspaceSpec, 'function');
  assert.equal(typeof core.validateExecutionEnvironmentSpec, 'function');
  assert.equal(typeof core.DefaultExecutionRiskEvaluator, 'function');
  assert.equal(typeof core.ArtifactStoreProviderRegistry, 'function');
});

test('loads the pinned local adapters and performs a real in-memory SQLite query', () => {
  const adapters = loadHyphaAdaptersLocal(projectRoot);
  assert.equal(typeof adapters.loadSqlite, 'function');
  assert.equal(typeof adapters.DockerSandboxProviderFactory, 'function');
  assert.equal(typeof adapters.LocalFilesystemExecutionArtifactStore, 'function');

  const sqlite = adapters.loadSqlite(true);
  const database = new sqlite.DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE readiness_check (value INTEGER NOT NULL);');
    database.exec('INSERT INTO readiness_check (value) VALUES (1);');
    const row = database.prepare('SELECT value FROM readiness_check;').get();
  assert.equal(row.value, 1);
  assert.equal(Object.keys(row).length, 1);
  } finally {
    database.close?.();
  }
});

test('refuses undeclared Hypha packages', () => {
  assert.throws(
    () => loadHyphaPackage('server', projectRoot),
    /Unsupported Hypha package: server/
  );
});
