const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentBackedConversationService } = require('../src/agent/agent-backed-conversation-service.cjs');
const { createAgentInferenceProvider } = require('../src/agent/inference-provider.cjs');
const { createLegalComplianceAgent } = require('../src/agent/legal-compliance-agent.cjs');
const {
  agentCapabilityPatchRef,
  assertCapabilityReferenceSnapshot,
  capabilitySnapshotRef,
  createAgentCapabilityPatch,
  createCapabilityReferenceSnapshot
} = require('../src/v1/capability-reference-snapshot.cjs');
const { loadDataSourceSchemaProfile } = require('../src/v1/data-source-schema-profile.cjs');
const { loadWorkflowStateCapabilityMap } = require('../src/v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { EncryptedFileLegalSessionStore } = require('../src/v0/encrypted-file-session-store.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');

const projectRoot = path.resolve(__dirname, '..');

function createSnapshot(runtime = 'demo') {
  const workspace = loadWorkspaceExecutionProfile({ projectRoot }).receipt;
  const dataSources = loadDataSourceSchemaProfile({ projectRoot });
  const stateMap = loadWorkflowStateCapabilityMap({ projectRoot });
  return createCapabilityReferenceSnapshot(
    stateMap.bindApplication({
      workspaceExecutionBinding: workspace,
      dataSourceSchemaBinding: dataSources.resolveRuntime({ runtime }).receipt,
      sandboxEnabled: false
    })
  );
}

function startLegalSession(service) {
  return service.start({
    userText: '朋友借钱不还，我有转账记录，说好去年年底还款。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
}

test('creates a stable immutable capability snapshot and Agent patch without sensitive values', () => {
  const first = createSnapshot('demo');
  const second = createSnapshot('demo');
  const patch = createAgentCapabilityPatch(first);
  assert.equal(first.snapshotSha256, second.snapshotSha256);
  assert.equal(first.activeRuntime, 'demo');
  assert.equal(first.dataSourceProfileRef, null);
  assert.equal(first.sensitiveValuesExposed, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.workspaceProfileRef), true);
  assert.equal(Object.isFrozen(patch), true);
  assert.deepEqual(patch.capabilitySnapshotRef, capabilitySnapshotRef(first));
  assert.match(patch.patchSha256, /^sha256:[0-9a-f]{64}$/);
  const serialized = JSON.stringify({ first, patch });
  assert.equal(serialized.includes(projectRoot), false);
  assert.equal(serialized.includes('LEGAL_SESSION_KEY_BASE64'), false);
});

test('binds a different snapshot to the active SQLite profile', () => {
  const demo = createSnapshot('demo');
  const sqlite = createSnapshot('sqlite');
  assert.notEqual(sqlite.snapshotSha256, demo.snapshotSha256);
  assert.equal(sqlite.activeRuntime, 'sqlite');
  assert.equal(sqlite.dataSourceProfileRef.profileKey, 'sqlite-read-only');
  assert.equal(sqlite.dataSourceProfileRef.id, 'local.legal_cases');
  assert.match(sqlite.dataSourceProfileRef.canonicalSha256, /^sha256:[0-9a-f]{64}$/);
});

test('stores the snapshot in each Session and rejects missing or changed stored snapshots', () => {
  const snapshot = createSnapshot('demo');
  const baseStore = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store: baseStore,
    ownerId: 'snapshot-owner',
    capabilitySnapshot: snapshot
  });
  const started = startLegalSession(service);
  const stored = baseStore.get(started.sessionId, 'snapshot-owner');
  assert.deepEqual(stored.capabilitySnapshot, snapshot);
  assert.deepEqual(service.describeCapabilityBinding(), capabilitySnapshotRef(snapshot));

  const missing = structuredClone(stored);
  delete missing.capabilitySnapshot;
  baseStore.save(missing, 'snapshot-owner');
  assert.throws(
    () => service.getSession(started.sessionId),
    (error) => error?.code === 'CAPABILITY_SNAPSHOT_MISSING'
  );

  baseStore.save(stored, 'snapshot-owner');
  const changed = structuredClone(stored);
  changed.capabilitySnapshot.outputContractRef.id = 'output.private-unbound';
  baseStore.save(changed, 'snapshot-owner');
  assert.throws(
    () => service.getSession(started.sessionId),
    (error) => error?.code === 'CAPABILITY_SNAPSHOT_HASH_MISMATCH'
  );
});

test('persists the snapshot across encrypted-store restarts and rejects a runtime-switched application', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-capability-session-'));
  const key = crypto.randomBytes(32);
  try {
    const demoSnapshot = createSnapshot('demo');
    const first = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey: key }),
      ownerId: 'encrypted-snapshot-owner',
      capabilitySnapshot: demoSnapshot
    });
    const started = startLegalSession(first);
    const restarted = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey: key }),
      ownerId: 'encrypted-snapshot-owner',
      capabilitySnapshot: demoSnapshot
    });
    assert.deepEqual(
      restarted.getSession(started.sessionId).capabilitySnapshot,
      demoSnapshot
    );

    const switched = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey: key }),
      ownerId: 'encrypted-snapshot-owner',
      capabilitySnapshot: createSnapshot('sqlite')
    });
    assert.throws(
      () => switched.getSession(started.sessionId),
      (error) => error?.code === 'CAPABILITY_SNAPSHOT_DRIFT'
    );
  } finally {
    key.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts only the bound Agent patch and rejects a later runtime replacement', async () => {
  const demoSnapshot = createSnapshot('demo');
  const demoPatch = createAgentCapabilityPatch(demoSnapshot);
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: createAgentInferenceProvider({ environment: {} }),
    capabilitySnapshot: demoSnapshot,
    capabilityPatch: demoPatch
  });
  assert.deepEqual(agent.describe().capabilitySnapshotRef, capabilitySnapshotRef(demoSnapshot));
  assert.deepEqual(
    agent.applyCapabilityPatch(demoPatch),
    agentCapabilityPatchRef(demoPatch, demoSnapshot)
  );

  const sqliteSnapshot = createSnapshot('sqlite');
  const sqlitePatch = createAgentCapabilityPatch(sqliteSnapshot);
  assert.throws(
    () => agent.applyCapabilityPatch(sqlitePatch),
    (error) => error?.code === 'AGENT_CAPABILITY_PATCH_DRIFT'
  );
  const tampered = structuredClone(demoPatch);
  tampered.compiledFsmSha256 = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => agent.applyCapabilityPatch(tampered),
    (error) => error?.code === 'AGENT_CAPABILITY_PATCH_HASH_MISMATCH'
  );
});

test('rejects composition when Session and Agent snapshot references differ', () => {
  const demoRef = capabilitySnapshotRef(createSnapshot('demo'));
  const sqliteRef = capabilitySnapshotRef(createSnapshot('sqlite'));
  assert.throws(
    () =>
      new AgentBackedConversationService({
        service: {
          start() {},
          describeCapabilityBinding() {
            return demoRef;
          }
        },
        agent: {
          run() {},
          describe() {
            return { capabilitySnapshotRef: sqliteRef };
          }
        }
      }),
    (error) => error?.code === 'CAPABILITY_SNAPSHOT_COMPOSITION_DRIFT'
  );
});

test('rejects snapshots whose reference body no longer matches the declared hash', () => {
  const snapshot = structuredClone(createSnapshot('demo'));
  snapshot.outputContractRef.id = 'output.private-unbound';
  assert.throws(
    () => assertCapabilityReferenceSnapshot(snapshot),
    (error) => error?.code === 'CAPABILITY_SNAPSHOT_HASH_MISMATCH'
  );
});
