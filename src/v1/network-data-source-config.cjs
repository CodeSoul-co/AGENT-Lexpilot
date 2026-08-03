const fs = require('node:fs');
const path = require('node:path');
const { createNetworkSQLDataSource } = require('./network-sql-data-source.cjs');

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'engine',
  'schemaName',
  'accessMode',
  'connectionEnv',
  'allowedTables',
  'allowedColumns',
  'timeoutMs',
  'maxRows',
  'maxOutputBytes'
]);
const CONNECTION_KEYS = Object.freeze(['host', 'port', 'database', 'user', 'password', 'tlsMode']);
const ENV_NAME_PATTERN = /^LEGAL_[A-Z0-9_]+$/;

function readNetworkDataSourceManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  } catch (error) {
    throw new Error('Unable to read the network data-source manifest.', { cause: error });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Network data-source manifest must be an object.');
  }
  const undeclared = Object.keys(manifest).filter((key) => !MANIFEST_KEYS.has(key));
  if (undeclared.length > 0) {
    throw new TypeError(`Network data-source manifest contains undeclared keys: ${undeclared.join(', ')}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    !['mysql', 'postgresql'].includes(manifest.engine) ||
    manifest.accessMode !== 'read-only'
  ) {
    throw new TypeError('Network data-source manifest must declare a supported read-only profile.');
  }
  if (!manifest.connectionEnv || typeof manifest.connectionEnv !== 'object') {
    throw new TypeError('connectionEnv must be an object.');
  }
  const connectionKeys = Object.keys(manifest.connectionEnv);
  if (
    connectionKeys.length !== CONNECTION_KEYS.length ||
    CONNECTION_KEYS.some((key) => !connectionKeys.includes(key))
  ) {
    throw new TypeError(`connectionEnv must contain exactly: ${CONNECTION_KEYS.join(', ')}.`);
  }
  for (const key of CONNECTION_KEYS) {
    if (
      typeof manifest.connectionEnv[key] !== 'string' ||
      !ENV_NAME_PATTERN.test(manifest.connectionEnv[key])
    ) {
      throw new TypeError(`connectionEnv.${key} must be a LEGAL_* environment variable name.`);
    }
  }
  if (!Array.isArray(manifest.allowedTables) || !Array.isArray(manifest.allowedColumns)) {
    throw new TypeError('allowedTables and allowedColumns must be arrays.');
  }
  return Object.freeze({
    ...manifest,
    connectionEnv: Object.freeze({ ...manifest.connectionEnv }),
    allowedTables: Object.freeze([...manifest.allowedTables]),
    allowedColumns: Object.freeze([...manifest.allowedColumns])
  });
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required to enable this network data source.`);
  }
  return value.trim();
}

function createConfiguredNetworkDataSource(options = {}) {
  const manifest = readNetworkDataSourceManifest(options.manifestPath);
  const environment = options.env ?? process.env;
  const connection = Object.fromEntries(
    CONNECTION_KEYS.map((key) => [
      key,
      key === 'tlsMode'
        ? environment[manifest.connectionEnv[key]]?.trim() || 'require'
        : requiredEnvironmentValue(environment, manifest.connectionEnv[key])
    ])
  );
  const port = Number(connection.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`${manifest.connectionEnv.port} must be a valid TCP port.`);
  }
  return createNetworkSQLDataSource({
    id: manifest.id,
    engine: manifest.engine,
    schemaName: manifest.schemaName,
    host: connection.host,
    port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    tlsMode: connection.tlsMode,
    allowedTables: manifest.allowedTables,
    allowedColumns: manifest.allowedColumns,
    timeoutMs: manifest.timeoutMs,
    maxRows: manifest.maxRows,
    maxOutputBytes: manifest.maxOutputBytes,
    clientFactory: options.clientFactory,
    dependencies: options.dependencies
  });
}

module.exports = { createConfiguredNetworkDataSource, readNetworkDataSourceManifest };
