const { canonicalSha256 } = require('./workflow-state-capability-map.cjs');

const CAPABILITY_SNAPSHOT_ID = 'capability-snapshot.legal-session-agent';
const CAPABILITY_SNAPSHOT_VERSION = '1.0.0';
const AGENT_CAPABILITY_PATCH_ID = 'agent-patch.legal-capabilities';
const AGENT_CAPABILITY_PATCH_VERSION = '1.0.0';
const DOMAIN_PACK_REF = Object.freeze({
  id: 'domain.legal-compliance.v0-v1',
  version: '0.16.0'
});
const SESSION_PROFILE_REF = Object.freeze({
  id: 'session.legal-single-user',
  version: '0.16.0'
});
const AGENT_REF = Object.freeze({
  id: 'agent.legal-compliance',
  version: '0.16.0'
});
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_RUNTIMES = new Set(['demo', 'sqlite', 'postgresql', 'mysql']);
const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'version',
  'domainPackRef',
  'sessionProfileRef',
  'agentRef',
  'stateCapabilityBindingRef',
  'runtimeWorkflowRef',
  'workspaceProfileRef',
  'executionProfileRef',
  'dataSourceProfileRef',
  'artifactProfileRef',
  'outputContractRef',
  'activeRuntime',
  'sandboxCapabilityBound',
  'compiledFsmSha256',
  'sensitiveValuesExposed',
  'snapshotSha256'
]);
const PATCH_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'version',
  'agentRef',
  'capabilitySnapshotRef',
  'workspaceProfileRef',
  'executionProfileRef',
  'dataSourceProfileRef',
  'artifactProfileRef',
  'outputContractRef',
  'activeRuntime',
  'compiledFsmSha256',
  'patchSha256'
]);

class CapabilityReferenceSnapshotError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CapabilityReferenceSnapshotError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new CapabilityReferenceSnapshotError(code, message, cause ? { cause } : {});
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireObject(value, label, code = 'CAPABILITY_SNAPSHOT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label, code) {
  const object = requireObject(value, label, code);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} contains undeclared fields.`);
  }
  return object;
}

function requireReference(value, label, code = 'CAPABILITY_SNAPSHOT_INVALID') {
  const reference = requireExactKeys(value, ['id', 'version'], label, code);
  if (
    typeof reference.id !== 'string' ||
    reference.id.length === 0 ||
    typeof reference.version !== 'string' ||
    !VERSION_PATTERN.test(reference.version)
  ) {
    fail(code, `${label} is invalid.`);
  }
  return deepFreeze({ id: reference.id, version: reference.version });
}

function requireSha256(value, label, code = 'CAPABILITY_SNAPSHOT_INVALID') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function sameReference(left, right) {
  return left?.id === right?.id && left?.version === right?.version;
}

function sameValue(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

function requireDataSourceProfileRef(value, activeRuntime, code = 'CAPABILITY_SNAPSHOT_INVALID') {
  if (activeRuntime === 'demo') {
    if (value !== null) fail(code, 'Demo capability snapshot may not bind a real DataSource profile.');
    return null;
  }
  const reference = requireExactKeys(
    value,
    ['bindingId', 'bindingVersion', 'profileKey', 'id', 'schemaVersion', 'canonicalSha256'],
    'dataSourceProfileRef',
    code
  );
  if (
    typeof reference.bindingId !== 'string' ||
    typeof reference.bindingVersion !== 'string' ||
    !VERSION_PATTERN.test(reference.bindingVersion) ||
    typeof reference.profileKey !== 'string' ||
    typeof reference.id !== 'string' ||
    !Number.isInteger(reference.schemaVersion) ||
    reference.schemaVersion < 1
  ) {
    fail(code, 'dataSourceProfileRef is invalid.');
  }
  requireSha256(reference.canonicalSha256, 'dataSourceProfileRef.canonicalSha256', code);
  return deepFreeze({ ...reference });
}

function snapshotBody(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== 'snapshotSha256')
  );
}

function patchBody(patch) {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'patchSha256'));
}

function validateSnapshot(value) {
  const snapshot = requireExactKeys(
    value,
    SNAPSHOT_KEYS,
    'capabilitySnapshot',
    'CAPABILITY_SNAPSHOT_INVALID'
  );
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.id !== CAPABILITY_SNAPSHOT_ID ||
    snapshot.version !== CAPABILITY_SNAPSHOT_VERSION ||
    snapshot.sensitiveValuesExposed !== false ||
    typeof snapshot.sandboxCapabilityBound !== 'boolean' ||
    !SUPPORTED_RUNTIMES.has(snapshot.activeRuntime)
  ) {
    fail('CAPABILITY_SNAPSHOT_INVALID', 'Capability snapshot contract has drifted.');
  }
  const domainPackRef = requireReference(snapshot.domainPackRef, 'domainPackRef');
  const sessionProfileRef = requireReference(snapshot.sessionProfileRef, 'sessionProfileRef');
  const agentRef = requireReference(snapshot.agentRef, 'agentRef');
  if (
    !sameReference(domainPackRef, DOMAIN_PACK_REF) ||
    !sameReference(sessionProfileRef, SESSION_PROFILE_REF) ||
    !sameReference(agentRef, AGENT_REF)
  ) {
    fail('CAPABILITY_SNAPSHOT_INVALID', 'Domain, Session, or Agent reference has drifted.');
  }
  const normalized = {
    ...snapshotBody(snapshot),
    domainPackRef,
    sessionProfileRef,
    agentRef,
    stateCapabilityBindingRef: requireReference(
      snapshot.stateCapabilityBindingRef,
      'stateCapabilityBindingRef'
    ),
    runtimeWorkflowRef: requireReference(snapshot.runtimeWorkflowRef, 'runtimeWorkflowRef'),
    workspaceProfileRef: requireReference(snapshot.workspaceProfileRef, 'workspaceProfileRef'),
    executionProfileRef: requireReference(snapshot.executionProfileRef, 'executionProfileRef'),
    dataSourceProfileRef: requireDataSourceProfileRef(
      snapshot.dataSourceProfileRef,
      snapshot.activeRuntime
    ),
    artifactProfileRef: requireReference(snapshot.artifactProfileRef, 'artifactProfileRef'),
    outputContractRef: requireReference(snapshot.outputContractRef, 'outputContractRef'),
    compiledFsmSha256: requireSha256(snapshot.compiledFsmSha256, 'compiledFsmSha256')
  };
  const declaredHash = requireSha256(snapshot.snapshotSha256, 'snapshotSha256');
  if (canonicalSha256(normalized) !== declaredHash) {
    fail('CAPABILITY_SNAPSHOT_HASH_MISMATCH', 'Capability snapshot hash does not match its references.');
  }
  return deepFreeze({ ...normalized, snapshotSha256: declaredHash });
}

function createCapabilityReferenceSnapshot(stateCapabilityBinding) {
  const binding = requireObject(stateCapabilityBinding, 'stateCapabilityBinding');
  if (
    !sameReference(binding.domainPackRef, DOMAIN_PACK_REF) ||
    binding.referencesRetained !== true ||
    binding.sensitiveValuesExposed !== false
  ) {
    fail('CAPABILITY_SNAPSHOT_BINDING_DRIFT', 'State capability binding is incomplete or has drifted.');
  }
  const activeRuntime = binding.activeRuntime;
  if (!SUPPORTED_RUNTIMES.has(activeRuntime)) {
    fail('CAPABILITY_SNAPSHOT_BINDING_DRIFT', 'Active runtime is unsupported.');
  }
  const body = {
    schemaVersion: 1,
    id: CAPABILITY_SNAPSHOT_ID,
    version: CAPABILITY_SNAPSHOT_VERSION,
    domainPackRef: requireReference(binding.domainPackRef, 'binding.domainPackRef'),
    sessionProfileRef: SESSION_PROFILE_REF,
    agentRef: AGENT_REF,
    stateCapabilityBindingRef: requireReference(
      { id: binding.bindingId, version: binding.bindingVersion },
      'binding.stateCapabilityBindingRef'
    ),
    runtimeWorkflowRef: requireReference(binding.runtimeWorkflowRef, 'binding.runtimeWorkflowRef'),
    workspaceProfileRef: requireReference(binding.workspaceProfileRef, 'binding.workspaceProfileRef'),
    executionProfileRef: requireReference(binding.executionProfileRef, 'binding.executionProfileRef'),
    dataSourceProfileRef: requireDataSourceProfileRef(
      binding.activeDataSourceProfileRef,
      activeRuntime,
      'CAPABILITY_SNAPSHOT_BINDING_DRIFT'
    ),
    artifactProfileRef: requireReference(binding.artifactProfileRef, 'binding.artifactProfileRef'),
    outputContractRef: requireReference(binding.outputContractRef, 'binding.outputContractRef'),
    activeRuntime,
    sandboxCapabilityBound: binding.sandboxCapabilityBound,
    compiledFsmSha256: requireSha256(binding.compiledFsmSha256, 'binding.compiledFsmSha256'),
    sensitiveValuesExposed: false
  };
  return validateSnapshot({ ...body, snapshotSha256: canonicalSha256(body) });
}

function assertCapabilityReferenceSnapshot(actual, expected) {
  const normalized = validateSnapshot(actual);
  if (expected !== undefined) {
    const normalizedExpected = validateSnapshot(expected);
    if (normalized.snapshotSha256 !== normalizedExpected.snapshotSha256) {
      fail('CAPABILITY_SNAPSHOT_DRIFT', 'Session capability snapshot does not match the active application.');
    }
  }
  return normalized;
}

function capabilitySnapshotRef(snapshot) {
  const normalized = validateSnapshot(snapshot);
  return deepFreeze({
    id: normalized.id,
    version: normalized.version,
    snapshotSha256: normalized.snapshotSha256
  });
}

function validatePatch(value, expectedSnapshot) {
  const patch = requireExactKeys(
    value,
    PATCH_KEYS,
    'agentCapabilityPatch',
    'AGENT_CAPABILITY_PATCH_INVALID'
  );
  if (
    patch.schemaVersion !== 1 ||
    patch.id !== AGENT_CAPABILITY_PATCH_ID ||
    patch.version !== AGENT_CAPABILITY_PATCH_VERSION
  ) {
    fail('AGENT_CAPABILITY_PATCH_INVALID', 'Agent capability patch contract has drifted.');
  }
  const normalized = {
    ...patchBody(patch),
    agentRef: requireReference(patch.agentRef, 'patch.agentRef', 'AGENT_CAPABILITY_PATCH_INVALID'),
    capabilitySnapshotRef: requireExactKeys(
      patch.capabilitySnapshotRef,
      ['id', 'version', 'snapshotSha256'],
      'patch.capabilitySnapshotRef',
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    workspaceProfileRef: requireReference(
      patch.workspaceProfileRef,
      'patch.workspaceProfileRef',
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    executionProfileRef: requireReference(
      patch.executionProfileRef,
      'patch.executionProfileRef',
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    dataSourceProfileRef: requireDataSourceProfileRef(
      patch.dataSourceProfileRef,
      patch.activeRuntime,
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    artifactProfileRef: requireReference(
      patch.artifactProfileRef,
      'patch.artifactProfileRef',
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    outputContractRef: requireReference(
      patch.outputContractRef,
      'patch.outputContractRef',
      'AGENT_CAPABILITY_PATCH_INVALID'
    ),
    compiledFsmSha256: requireSha256(
      patch.compiledFsmSha256,
      'patch.compiledFsmSha256',
      'AGENT_CAPABILITY_PATCH_INVALID'
    )
  };
  requireSha256(
    normalized.capabilitySnapshotRef.snapshotSha256,
    'patch.capabilitySnapshotRef.snapshotSha256',
    'AGENT_CAPABILITY_PATCH_INVALID'
  );
  const declaredHash = requireSha256(
    patch.patchSha256,
    'patch.patchSha256',
    'AGENT_CAPABILITY_PATCH_INVALID'
  );
  if (canonicalSha256(normalized) !== declaredHash) {
    fail('AGENT_CAPABILITY_PATCH_HASH_MISMATCH', 'Agent capability patch hash is invalid.');
  }
  const snapshot = assertCapabilityReferenceSnapshot(expectedSnapshot);
  const expectedRef = capabilitySnapshotRef(snapshot);
  if (
    !sameValue(normalized.capabilitySnapshotRef, expectedRef) ||
    !sameReference(normalized.agentRef, snapshot.agentRef) ||
    !sameReference(normalized.workspaceProfileRef, snapshot.workspaceProfileRef) ||
    !sameReference(normalized.executionProfileRef, snapshot.executionProfileRef) ||
    !sameValue(normalized.dataSourceProfileRef, snapshot.dataSourceProfileRef) ||
    !sameReference(normalized.artifactProfileRef, snapshot.artifactProfileRef) ||
    !sameReference(normalized.outputContractRef, snapshot.outputContractRef) ||
    normalized.activeRuntime !== snapshot.activeRuntime ||
    normalized.compiledFsmSha256 !== snapshot.compiledFsmSha256
  ) {
    fail('AGENT_CAPABILITY_PATCH_DRIFT', 'Agent patch cannot replace the active capability snapshot.');
  }
  return deepFreeze({ ...normalized, patchSha256: declaredHash });
}

function createAgentCapabilityPatch(snapshot) {
  const normalized = assertCapabilityReferenceSnapshot(snapshot);
  const body = {
    schemaVersion: 1,
    id: AGENT_CAPABILITY_PATCH_ID,
    version: AGENT_CAPABILITY_PATCH_VERSION,
    agentRef: normalized.agentRef,
    capabilitySnapshotRef: capabilitySnapshotRef(normalized),
    workspaceProfileRef: normalized.workspaceProfileRef,
    executionProfileRef: normalized.executionProfileRef,
    dataSourceProfileRef: normalized.dataSourceProfileRef,
    artifactProfileRef: normalized.artifactProfileRef,
    outputContractRef: normalized.outputContractRef,
    activeRuntime: normalized.activeRuntime,
    compiledFsmSha256: normalized.compiledFsmSha256
  };
  return validatePatch({ ...body, patchSha256: canonicalSha256(body) }, normalized);
}

function assertAgentCapabilityPatch(patch, snapshot) {
  return validatePatch(patch, snapshot);
}

function agentCapabilityPatchRef(patch, snapshot) {
  const normalized = validatePatch(patch, snapshot);
  return deepFreeze({
    id: normalized.id,
    version: normalized.version,
    patchSha256: normalized.patchSha256
  });
}

function createCapabilityBoundSessionStore(store, capabilitySnapshot) {
  if (!store || typeof store.create !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('store must expose the legal session store interface.');
  }
  const expected = assertCapabilityReferenceSnapshot(capabilitySnapshot);

  function requireBoundSession(session) {
    if (!session || typeof session !== 'object') return session;
    if (!session.capabilitySnapshot) {
      fail('CAPABILITY_SNAPSHOT_MISSING', 'Stored Session has no capability snapshot.');
    }
    assertCapabilityReferenceSnapshot(session.capabilitySnapshot, expected);
    return session;
  }

  return Object.freeze({
    create(session) {
      requireBoundSession(session);
      return store.create(session);
    },
    get(sessionId, ownerId) {
      return requireBoundSession(store.get(sessionId, ownerId));
    },
    save(session, ownerId) {
      requireBoundSession(session);
      return store.save(session, ownerId);
    },
    delete(sessionId, ownerId) {
      return store.delete(sessionId, ownerId);
    },
    list(ownerId) {
      const sessions = store.list(ownerId);
      sessions.forEach(requireBoundSession);
      return sessions;
    },
    count(ownerId) {
      return store.count(ownerId);
    },
    purgeInactive(inactiveBefore) {
      return store.purgeInactive(inactiveBefore);
    }
  });
}

module.exports = {
  AGENT_CAPABILITY_PATCH_ID,
  AGENT_CAPABILITY_PATCH_VERSION,
  AGENT_REF,
  CAPABILITY_SNAPSHOT_ID,
  CAPABILITY_SNAPSHOT_VERSION,
  CapabilityReferenceSnapshotError,
  DOMAIN_PACK_REF,
  SESSION_PROFILE_REF,
  agentCapabilityPatchRef,
  assertAgentCapabilityPatch,
  assertCapabilityReferenceSnapshot,
  capabilitySnapshotRef,
  createAgentCapabilityPatch,
  createCapabilityBoundSessionStore,
  createCapabilityReferenceSnapshot
};
