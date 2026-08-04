const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readDataSourceManifest } = require('./data-source-config.cjs');
const { INITIAL_SCHEMA_SNAPSHOT_CONTRACT } = require('./data-source-admin.cjs');
const { readNetworkDataSourceManifest } = require('./network-data-source-config.cjs');

const DEFAULT_BINDING_MANIFEST = path.join(
  'configs',
  'capability-bindings',
  'legal-v1-data-sources.json'
);
const DEFAULT_DOMAIN_PACK = path.join(
  'configs',
  'domain-packs',
  'legal-compliance.domain.json'
);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{2,127}$/;
const PROFILE_KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_RUNTIMES = Object.freeze(['demo', 'sqlite', 'postgresql', 'mysql']);

class DataSourceSchemaProfileError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DataSourceSchemaProfileError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DataSourceSchemaProfileError(code, message, cause ? { cause } : undefined);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const object = requireObject(value, label);
  const keys = Object.keys(object).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', `${label} fields are invalid.`);
  }
  return object;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function readJson(filename, missingCode) {
  let text;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    fail(missingCode, 'Required versioned configuration is unavailable.', error);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Versioned configuration is not valid JSON.', error);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireDomainPackReference(value) {
  const reference = requireExactKeys(value, ['id', 'version'], 'domainPackRef');
  return Object.freeze({
    id: requireIdentifier(reference.id, 'domainPackRef.id'),
    version: requireVersion(reference.version, 'domainPackRef.version')
  });
}

function requireSnapshotContract(value) {
  const contract = requireExactKeys(
    value,
    ['id', 'version', 'tableAttributes', 'columnAttributes', 'providerMetadataExposed'],
    'schemaSnapshotContract'
  );
  const expected = INITIAL_SCHEMA_SNAPSHOT_CONTRACT;
  if (
    contract.id !== expected.id ||
    contract.version !== expected.version ||
    !Array.isArray(contract.tableAttributes) ||
    !Array.isArray(contract.columnAttributes) ||
    JSON.stringify(contract.tableAttributes) !== JSON.stringify(expected.tableAttributes) ||
    JSON.stringify(contract.columnAttributes) !== JSON.stringify(expected.columnAttributes) ||
    contract.providerMetadataExposed !== expected.providerMetadataExposed
  ) {
    fail('DATA_SOURCE_SCHEMA_BINDING_DRIFT', 'Initial Schema snapshot contract has drifted.');
  }
  return deepFreeze({
    id: contract.id,
    version: contract.version,
    tableAttributes: [...contract.tableAttributes],
    columnAttributes: [...contract.columnAttributes],
    providerMetadataExposed: contract.providerMetadataExposed
  });
}

function requireManifestReference(value, label) {
  const reference = requireExactKeys(
    value,
    ['id', 'schemaVersion', 'engine', 'accessMode', 'canonicalSha256'],
    label
  );
  requireIdentifier(reference.id, `${label}.id`);
  if (
    reference.schemaVersion !== 1 ||
    !['sqlite', 'postgresql', 'mysql'].includes(reference.engine) ||
    !['read-only', 'read-write'].includes(reference.accessMode) ||
    !SHA256_PATTERN.test(reference.canonicalSha256)
  ) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', `${label} is invalid.`);
  }
  return reference;
}

function resolvePublicManifestPath(projectRoot, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
    !relativePath.startsWith('configs/data-sources/')
  ) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source manifest path is invalid.');
  }
  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source manifest must stay in the project.');
  }
  return resolved;
}

function validateAllowlist(manifest) {
  if (
    !Array.isArray(manifest.allowedTables) ||
    manifest.allowedTables.length !== 1 ||
    !Array.isArray(manifest.allowedColumns) ||
    manifest.allowedColumns.length === 0 ||
    manifest.allowedTables.some((name) => !IDENTIFIER_PATTERN.test(name)) ||
    manifest.allowedColumns.some((name) => !IDENTIFIER_PATTERN.test(name)) ||
    new Set(manifest.allowedColumns).size !== manifest.allowedColumns.length
  ) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source Schema allowlist is invalid.');
  }
  if (
    !Number.isInteger(manifest.timeoutMs) ||
    manifest.timeoutMs < 1 ||
    manifest.timeoutMs > 15_000 ||
    !Number.isInteger(manifest.maxRows) ||
    manifest.maxRows < 1 ||
    manifest.maxRows > 10_000 ||
    !Number.isInteger(manifest.maxOutputBytes) ||
    manifest.maxOutputBytes < 128 ||
    manifest.maxOutputBytes > 10_485_760
  ) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source execution limits are invalid.');
  }
}

function loadBoundProfile(projectRoot, definition) {
  requireExactKeys(
    definition,
    ['profileKey', 'runtime', 'defaultForRuntime', 'manifest', 'manifestRef'],
    'profile'
  );
  if (!PROFILE_KEY_PATTERN.test(definition.profileKey)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'profileKey is invalid.');
  }
  if (!['sqlite', 'postgresql', 'mysql'].includes(definition.runtime)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source runtime is invalid.');
  }
  if (typeof definition.defaultForRuntime !== 'boolean') {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'defaultForRuntime must be boolean.');
  }
  const reference = requireManifestReference(definition.manifestRef, 'profile.manifestRef');
  if (reference.engine !== definition.runtime) {
    fail('DATA_SOURCE_SCHEMA_BINDING_DRIFT', 'Runtime and manifest engine do not match.');
  }
  const manifestPath = resolvePublicManifestPath(projectRoot, definition.manifest);
  const { value: rawManifest } = readJson(
    manifestPath,
    'DATA_SOURCE_SCHEMA_MANIFEST_MISSING'
  );
  let manifest;
  try {
    manifest =
      reference.engine === 'sqlite'
        ? readDataSourceManifest(manifestPath)
        : readNetworkDataSourceManifest(manifestPath);
  } catch (error) {
    fail(
      'DATA_SOURCE_SCHEMA_PROFILE_INVALID',
      'Bound data-source manifest failed its runtime parser.',
      error
    );
  }
  validateAllowlist(manifest);
  if (
    manifest.id !== reference.id ||
    manifest.schemaVersion !== reference.schemaVersion ||
    manifest.engine !== reference.engine ||
    manifest.accessMode !== reference.accessMode ||
    canonicalSha256(rawManifest) !== reference.canonicalSha256
  ) {
    fail('DATA_SOURCE_SCHEMA_BINDING_DRIFT', 'Bound data-source manifest has drifted.');
  }
  return Object.freeze({
    profileKey: definition.profileKey,
    runtime: definition.runtime,
    defaultForRuntime: definition.defaultForRuntime,
    manifestPath,
    manifest,
    public: deepFreeze({
      profileKey: definition.profileKey,
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      engine: manifest.engine,
      accessMode: manifest.accessMode,
      canonicalSha256: reference.canonicalSha256,
      allowedTableCount: manifest.allowedTables.length,
      allowedColumnCount: manifest.allowedColumns.length
    })
  });
}

function validateProfileSet(profiles) {
  if (profiles.length !== 4) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Exactly four data-source profiles are required.');
  }
  if (new Set(profiles.map((profile) => profile.profileKey)).size !== profiles.length) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source profile keys must be unique.');
  }
  if (new Set(profiles.map((profile) => profile.manifest.id)).size !== profiles.length) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Data-source profile ids must be unique.');
  }
  const required = new Set([
    'sqlite:read-only',
    'sqlite:read-write',
    'postgresql:read-only',
    'mysql:read-only'
  ]);
  for (const profile of profiles) required.delete(`${profile.runtime}:${profile.manifest.accessMode}`);
  if (required.size > 0) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Required data-source profiles are missing.');
  }
  for (const runtime of ['sqlite', 'postgresql', 'mysql']) {
    if (profiles.filter((profile) => profile.runtime === runtime && profile.defaultForRuntime).length !== 1) {
      fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Each data-source runtime requires one default profile.');
    }
  }
  if (profiles.some((profile) => profile.defaultForRuntime && profile.manifest.accessMode !== 'read-only')) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'Default data-source profiles must be read-only.');
  }
}

function samePath(left, right) {
  const normalize = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function loadDataSourceSchemaProfile(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const bindingPath = path.resolve(projectRoot, options.bindingPath ?? DEFAULT_BINDING_MANIFEST);
  const domainPackPath = path.resolve(projectRoot, options.domainPackPath ?? DEFAULT_DOMAIN_PACK);
  const { value: binding, text: bindingText } = readJson(
    bindingPath,
    'DATA_SOURCE_SCHEMA_PROFILE_MISSING'
  );
  requireExactKeys(
    binding,
    ['schemaVersion', 'id', 'version', 'domainPackRef', 'schemaSnapshotContract', 'profiles'],
    'binding'
  );
  if (binding.schemaVersion !== 1) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'DataSource/Schema binding schemaVersion is unsupported.');
  }
  requireIdentifier(binding.id, 'binding.id');
  requireVersion(binding.version, 'binding.version');
  const domainPackRef = requireDomainPackReference(binding.domainPackRef);
  const snapshotContract = requireSnapshotContract(binding.schemaSnapshotContract);
  const { value: domainPack } = readJson(domainPackPath, 'DOMAIN_PACK_BINDING_MISSING');
  if (domainPack.id !== domainPackRef.id || domainPack.version !== domainPackRef.version) {
    fail('DATA_SOURCE_SCHEMA_BINDING_DRIFT', 'DomainPack reference has drifted.');
  }
  if (!Array.isArray(binding.profiles)) {
    fail('DATA_SOURCE_SCHEMA_PROFILE_INVALID', 'profiles must be an array.');
  }
  const profiles = binding.profiles.map((definition) => loadBoundProfile(projectRoot, definition));
  validateProfileSet(profiles);

  const receipt = deepFreeze({
    bindingId: binding.id,
    bindingVersion: binding.version,
    domainPackRef,
    schemaSnapshotContractRef: {
      id: snapshotContract.id,
      version: snapshotContract.version
    },
    profiles: profiles.map((profile) => profile.public),
    bindingManifestSha256: sha256(bindingText),
    connectionValuesExposed: false,
    hyphaSourceModified: false
  });

  return Object.freeze({
    receipt,
    resolveRuntime(input = {}) {
      const runtime = input.runtime ?? 'demo';
      if (!SUPPORTED_RUNTIMES.includes(runtime)) {
        fail('DATA_SOURCE_RUNTIME_UNSUPPORTED', 'V1 data-source runtime is unsupported.');
      }
      if (runtime === 'demo') {
        return Object.freeze({
          manifestPath: null,
          manifest: null,
          receipt: deepFreeze({
            bindingId: binding.id,
            bindingVersion: binding.version,
            runtime,
            expectedRuntime: 'business-demo-readonly',
            selectedProfile: null,
            schemaSnapshotContractRef: receipt.schemaSnapshotContractRef,
            connectionValuesExposed: false
          })
        });
      }
      let selected;
      if (runtime === 'sqlite' && input.configuredManifest !== undefined) {
        if (
          typeof input.configuredManifest !== 'string' ||
          input.configuredManifest.trim().length === 0 ||
          input.configuredManifest.includes('\0')
        ) {
          fail('DATA_SOURCE_MANIFEST_NOT_BOUND', 'Configured SQLite manifest is not bound.');
        }
        const requested = path.resolve(projectRoot, input.configuredManifest.trim());
        selected = profiles.find(
          (profile) => profile.runtime === runtime && samePath(profile.manifestPath, requested)
        );
      } else {
        selected = profiles.find(
          (profile) => profile.runtime === runtime && profile.defaultForRuntime
        );
      }
      if (!selected) {
        fail('DATA_SOURCE_MANIFEST_NOT_BOUND', 'Selected data-source manifest is not bound.');
      }
      return Object.freeze({
        manifestPath: selected.manifestPath,
        manifest: selected.manifest,
        receipt: deepFreeze({
          bindingId: binding.id,
          bindingVersion: binding.version,
          runtime,
          expectedRuntime:
            selected.manifest.accessMode === 'read-write'
              ? 'sqlite-governed-write'
              : `${selected.manifest.engine}-readonly`,
          selectedProfile: selected.public,
          schemaSnapshotContractRef: receipt.schemaSnapshotContractRef,
          connectionValuesExposed: false
        })
      });
    }
  });
}

module.exports = {
  DEFAULT_BINDING_MANIFEST,
  DEFAULT_DOMAIN_PACK,
  DataSourceSchemaProfileError,
  loadDataSourceSchemaProfile
};
