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
  'allowedColumns',
  'timeoutMs',
  'maxRows',
  'maxOutputBytes',
  'allowedWriteOperations',
  'requiresHumanReview',
  'maxAffectedRows'
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
  if (manifest.engine !== 'sqlite' || !['read-only', 'read-write'].includes(manifest.accessMode)) {
    throw new TypeError('V1 data source must use a supported SQLite access profile.');
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
  if (!Array.isArray(manifest.allowedColumns)) {
    throw new TypeError('allowedColumns must be an array.');
  }
  if (manifest.accessMode === 'read-write') {
    const operations = manifest.allowedWriteOperations;
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      operations.some((operation) => !['insert', 'update', 'delete'].includes(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      throw new TypeError('read-write SQLite profiles require unique INSERT/UPDATE/DELETE operations.');
    }
    if (manifest.requiresHumanReview !== true) {
      throw new TypeError('read-write SQLite profiles must require Human Review.');
    }
    if (!Number.isInteger(manifest.maxAffectedRows) || manifest.maxAffectedRows !== 1) {
      throw new TypeError('read-write SQLite profiles must limit affected rows to 1.');
    }
  } else if (
    manifest.allowedWriteOperations !== undefined ||
    manifest.requiresHumanReview !== undefined ||
    manifest.maxAffectedRows !== undefined
  ) {
    throw new TypeError('read-only SQLite profiles must not declare write controls.');
  }
  return Object.freeze({
    ...manifest,
    allowedTables: Object.freeze([...manifest.allowedTables]),
    allowedColumns: Object.freeze([...manifest.allowedColumns]),
    ...(manifest.allowedWriteOperations
      ? { allowedWriteOperations: Object.freeze([...manifest.allowedWriteOperations]) }
      : {})
  });
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
    allowedColumns: manifest.allowedColumns,
    accessMode: manifest.accessMode,
    allowedWriteOperations: manifest.allowedWriteOperations,
    requiresHumanReview: manifest.requiresHumanReview,
    maxAffectedRows: manifest.maxAffectedRows,
    timeoutMs: manifest.timeoutMs,
    maxRows: manifest.maxRows,
    maxOutputBytes: manifest.maxOutputBytes,
    projectRoot
  });
}

module.exports = { createConfiguredSQLiteDataSource, readDataSourceManifest };
