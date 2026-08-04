const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadHyphaCore } = require('../../scripts/hypha-paths.cjs');
const {
  MAX_CPU_CORES,
  MAX_EXECUTION_MS,
  MAX_MEMORY_MB
} = require('./sandbox-execution-policy.cjs');

const DEFAULT_MANIFEST = path.join(
  'configs',
  'execution-profiles',
  'legal-v1-sandbox.json'
);
const DEFAULT_DOMAIN_PACK = path.join(
  'configs',
  'domain-packs',
  'legal-compliance.domain.json'
);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{2,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;

class WorkspaceExecutionProfileError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WorkspaceExecutionProfileError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new WorkspaceExecutionProfileError(code, message, cause ? { cause } : undefined);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const object = requireObject(value, label);
  const keys = Object.keys(object).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', `${label} fields are invalid.`);
  }
  return object;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function requireReference(value, label) {
  const reference = requireExactKeys(value, ['id', 'version'], label);
  return Object.freeze({
    id: requireIdentifier(reference.id, `${label}.id`),
    version: requireVersion(reference.version, `${label}.version`)
  });
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
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Versioned configuration is not valid JSON.', error);
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readEnvironmentString(environment, name) {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) {
    fail('WORKSPACE_EXECUTION_ENVIRONMENT_INVALID', `Environment value is invalid: ${name}`);
  }
  return value.trim();
}

function validateWorkspaceProfile(profile, reference) {
  requireExactKeys(
    profile,
    ['id', 'version', 'rootEnvironmentName', 'defaultRelativeRoot', 'isolation', 'mount'],
    'workspaceProfile'
  );
  if (profile.id !== reference.id || profile.version !== reference.version) {
    fail('WORKSPACE_EXECUTION_BINDING_DRIFT', 'Workspace Profile reference does not match its definition.');
  }
  if (!ENVIRONMENT_NAME_PATTERN.test(profile.rootEnvironmentName)) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Workspace root environment name is invalid.');
  }
  if (
    typeof profile.defaultRelativeRoot !== 'string' ||
    profile.defaultRelativeRoot.length === 0 ||
    path.isAbsolute(profile.defaultRelativeRoot) ||
    profile.defaultRelativeRoot.includes('\\') ||
    profile.defaultRelativeRoot.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Default Workspace root must be a portable relative path.');
  }
  if (profile.isolation !== 'per-run') {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Workspace isolation must be per-run.');
  }
  const mount = requireExactKeys(
    profile.mount,
    ['sourceRef', 'targetPath', 'mode', 'type'],
    'workspaceProfile.mount'
  );
  if (
    mount.sourceRef !== 'workspace:current' ||
    mount.targetPath !== '/workspace' ||
    mount.mode !== 'rw' ||
    mount.type !== 'workspace'
  ) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Workspace mount policy is invalid.');
  }
}

function executionEnvironmentFromProfile(profile, environment, usePlaceholders = false) {
  const image = requireExactKeys(
    profile.image,
    ['referenceEnvironmentName', 'digestEnvironmentName', 'pullPolicy', 'requireDigestPin'],
    'executionProfile.image'
  );
  if (
    !ENVIRONMENT_NAME_PATTERN.test(image.referenceEnvironmentName) ||
    !ENVIRONMENT_NAME_PATTERN.test(image.digestEnvironmentName)
  ) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Execution image environment names are invalid.');
  }
  const imageReference = usePlaceholders
    ? 'registry.invalid/lexpilot/sandbox'
    : readEnvironmentString(environment, image.referenceEnvironmentName);
  const imageDigest = usePlaceholders
    ? `sha256:${'0'.repeat(64)}`
    : readEnvironmentString(environment, image.digestEnvironmentName);
  if (!imageReference) {
    fail('WORKSPACE_EXECUTION_ENVIRONMENT_MISSING', `Required environment variable is missing: ${image.referenceEnvironmentName}`);
  }
  if (imageReference.length > 512 || /[\u0000-\u001f\u007f]/.test(imageReference)) {
    fail('WORKSPACE_EXECUTION_ENVIRONMENT_INVALID', 'Execution image reference is invalid.');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? '')) {
    fail('WORKSPACE_EXECUTION_ENVIRONMENT_MISSING', `Required immutable image digest is missing: ${image.digestEnvironmentName}`);
  }

  const { image: ignoredImage, ...base } = profile;
  const unresolved = {
    ...base,
    image: {
      reference: imageReference,
      digest: imageDigest,
      pullPolicy: image.pullPolicy,
      requireDigestPin: image.requireDigestPin
    }
  };
  const revision = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(unresolved)))
    .digest('hex');
  const candidate = { ...unresolved, revision };
  try {
    return loadHyphaCore().validateExecutionEnvironmentSpec(candidate);
  } catch (error) {
    fail(
      'WORKSPACE_EXECUTION_PROFILE_INVALID',
      'Execution Profile does not satisfy the pinned Hypha ExecutionEnvironmentSpec.',
      error
    );
  }
}

function assertExecutionPolicy(environment, workspaceProfile, reference) {
  if (environment.id !== reference.id || environment.version !== reference.version) {
    fail('WORKSPACE_EXECUTION_BINDING_DRIFT', 'Execution Profile reference does not match its definition.');
  }
  const workspaceMounts = environment.filesystem.mounts.filter(
    (mount) => mount.type === 'workspace'
  );
  const workspaceMount = workspaceMounts[0];
  if (
    environment.provider !== 'docker' ||
    environment.image?.requireDigestPin !== true ||
    environment.process.shellEnabled !== false ||
    environment.process.inheritHostEnvironment !== false ||
    environment.resources.cpuCores !== MAX_CPU_CORES ||
    environment.resources.memoryMb !== MAX_MEMORY_MB ||
    environment.defaultTimeoutMs !== MAX_EXECUTION_MS ||
    environment.filesystem.rootFilesystem !== 'read_only' ||
    environment.filesystem.allowDeviceAccess !== false ||
    environment.filesystem.allowHostPathMounts !== false ||
    workspaceMounts.length !== 1 ||
    workspaceMount.sourceRef !== workspaceProfile.mount.sourceRef ||
    workspaceMount.targetPath !== workspaceProfile.mount.targetPath ||
    workspaceMount.mode !== workspaceProfile.mount.mode ||
    environment.network.mode !== 'disabled' ||
    environment.network.dnsPolicy !== 'disabled' ||
    environment.security.nonRootRequired !== true ||
    environment.security.noNewPrivileges !== true ||
    environment.security.privileged !== false ||
    !environment.security.dropCapabilities.includes('ALL') ||
    environment.secrets.injectionMode !== 'none' ||
    environment.secrets.redactFromOutput !== true ||
    environment.secrets.redactFromEvents !== true ||
    environment.lifecycle.reuse !== 'never' ||
    environment.lifecycle.cleanupOnSuccess !== true ||
    environment.lifecycle.cleanupOnFailure !== true ||
    environment.workingDirectoryPolicy !== 'workspace_only'
  ) {
    fail('WORKSPACE_EXECUTION_BINDING_DRIFT', 'Workspace/Execution security binding has drifted.');
  }
}

function resolveWorkspaceRoot(projectRoot, profile, environment) {
  const configured = readEnvironmentString(environment, profile.rootEnvironmentName);
  const root = path.resolve(projectRoot, configured || profile.defaultRelativeRoot);
  if (root === path.parse(root).root || root === projectRoot) {
    fail('WORKSPACE_EXECUTION_ENVIRONMENT_INVALID', 'Configured Workspace root is too broad.');
  }
  return root;
}

function loadWorkspaceExecutionProfile(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const manifestPath = path.resolve(projectRoot, options.manifestPath ?? DEFAULT_MANIFEST);
  const domainPackPath = path.resolve(projectRoot, options.domainPackPath ?? DEFAULT_DOMAIN_PACK);
  const { value: manifest, text: manifestText } = readJson(
    manifestPath,
    'WORKSPACE_EXECUTION_PROFILE_MISSING'
  );
  requireExactKeys(
    manifest,
    ['schemaVersion', 'id', 'version', 'bindings', 'workspaceProfile', 'executionProfile'],
    'manifest'
  );
  if (manifest.schemaVersion !== 1) {
    fail('WORKSPACE_EXECUTION_PROFILE_INVALID', 'Workspace/Execution manifest schemaVersion is unsupported.');
  }
  requireIdentifier(manifest.id, 'manifest.id');
  requireVersion(manifest.version, 'manifest.version');
  const bindings = requireExactKeys(
    manifest.bindings,
    ['domainPackRef', 'workspaceProfileRef', 'executionProfileRef'],
    'bindings'
  );
  const domainPackRef = requireReference(bindings.domainPackRef, 'bindings.domainPackRef');
  const workspaceProfileRef = requireReference(
    bindings.workspaceProfileRef,
    'bindings.workspaceProfileRef'
  );
  const executionProfileRef = requireReference(
    bindings.executionProfileRef,
    'bindings.executionProfileRef'
  );
  requireIdentifier(manifest.workspaceProfile?.id, 'workspaceProfile.id');
  requireVersion(manifest.workspaceProfile?.version, 'workspaceProfile.version');
  validateWorkspaceProfile(manifest.workspaceProfile, workspaceProfileRef);
  requireIdentifier(manifest.executionProfile?.id, 'executionProfile.id');
  requireVersion(manifest.executionProfile?.version, 'executionProfile.version');

  const { value: domainPack } = readJson(domainPackPath, 'DOMAIN_PACK_BINDING_MISSING');
  if (domainPack.id !== domainPackRef.id || domainPack.version !== domainPackRef.version) {
    fail('WORKSPACE_EXECUTION_BINDING_DRIFT', 'DomainPack reference has drifted.');
  }
  const staticEnvironment = executionEnvironmentFromProfile(
    manifest.executionProfile,
    {},
    true
  );
  assertExecutionPolicy(staticEnvironment, manifest.workspaceProfile, executionProfileRef);

  const receipt = deepFreeze({
    bindingId: manifest.id,
    bindingVersion: manifest.version,
    domainPackRef,
    workspaceProfileRef,
    executionProfileRef,
    provider: staticEnvironment.provider,
    workspaceIsolation: manifest.workspaceProfile.isolation,
    manifestSha256: sha256(manifestText),
    hyphaExecutionEnvironmentValidated: true,
    hyphaSourceModified: false
  });

  return Object.freeze({
    receipt,
    resolve(environment = process.env) {
      const executionEnvironment = executionEnvironmentFromProfile(
        manifest.executionProfile,
        environment
      );
      assertExecutionPolicy(executionEnvironment, manifest.workspaceProfile, executionProfileRef);
      return Object.freeze({
        workspaceRoot: resolveWorkspaceRoot(projectRoot, manifest.workspaceProfile, environment),
        executionEnvironment: deepFreeze(executionEnvironment),
        receipt
      });
    }
  });
}

module.exports = {
  DEFAULT_DOMAIN_PACK,
  DEFAULT_MANIFEST,
  WorkspaceExecutionProfileError,
  loadWorkspaceExecutionProfile
};
