const fs = require('node:fs');
const path = require('node:path');
const { createSQLiteDataSource } = require('./sqlite-data-source.cjs');

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'engine',
  'databasePathEnv',
  'accessMode',
  'allowedTables',
  'timeoutMs',
  'maxRows',
  'maxOutputBytes'
]);
const ENV_NAME_PATTERN = /^LEGAL_[A-Z0-9_]+$/;

function readDataSourceManifest(manifestPath) {
  const resolvedPath = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error('Unable to read the V1 data-source manifest.', { cause: error });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('V1 data-source manifest must be an object.');
  }
  const undeclaredKeys = Object.keys(manifest).filter((key) => !MANIFEST_KEYS.has(key));
  if (undeclaredKeys.length > 0) {
    throw new TypeError(`V1 data-source manifest contains undeclared keys: ${undeclaredKeys.join(', ')}`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new TypeError('V1 data-source manifest schemaVersion must be 1.');
  }
  if (manifest.engine !== 'sqlite' || manifest.accessMode !== 'read-only') {
    throw new TypeError('V1 data source must use the read-only SQLite profile.');
  }
  if (
    typeof manifest.databasePathEnv !== 'string' ||
    !ENV_NAME_PATTERN.test(manifest.databasePathEnv)
  ) {
    throw new TypeError('databasePathEnv must be a LEGAL_* environment variable name.');
  }
  if (!Array.isArray(manifest.allowedTables)) {
    throw new TypeError('allowedTables must be an array.');
  }
  return Object.freeze({ ...manifest, allowedTables: Object.freeze([...manifest.allowedTables]) });
}

function createConfiguredSQLiteDataSource(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const manifestPath = path.resolve(
    options.manifestPath ??
      path.join(projectRoot, 'configs', 'data-sources', 'legal-cases.sqlite.json')
  );
  const manifest = readDataSourceManifest(manifestPath);
  const environment = options.env ?? process.env;
  const configuredPath = environment[manifest.databasePathEnv];
  if (typeof configuredPath !== 'string' || configuredPath.trim().length === 0) {
    throw new Error(`${manifest.databasePathEnv} is required to enable the SQLite V1 runtime.`);
  }
  const databasePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
  return createSQLiteDataSource({
    id: manifest.id,
    databasePath,
    allowedTables: manifest.allowedTables,
    timeoutMs: manifest.timeoutMs,
    maxRows: manifest.maxRows,
    maxOutputBytes: manifest.maxOutputBytes,
    projectRoot
  });
}

module.exports = { createConfiguredSQLiteDataSource, readDataSourceManifest };
