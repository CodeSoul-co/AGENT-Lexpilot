const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  createLocalLegalAgent,
  createLocalLegalAgentApplication
} = require('../src/v0/app-bootstrap.cjs');
const { createCapabilityReferenceSnapshot } = require('../src/v1/capability-reference-snapshot.cjs');
const { loadDataSourceSchemaProfile } = require('../src/v1/data-source-schema-profile.cjs');
const { loadWorkflowStateCapabilityMap } = require('../src/v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');

const projectRoot = path.resolve(__dirname, '..');
const demoScript = path.join(projectRoot, 'scripts', 'demo-v0.cjs');
const keyScript = path.join(projectRoot, 'scripts', 'generate-session-key.cjs');

function demoCapabilitySnapshot() {
  const workspace = loadWorkspaceExecutionProfile({ projectRoot }).receipt;
  const dataSources = loadDataSourceSchemaProfile({ projectRoot });
  const stateMap = loadWorkflowStateCapabilityMap({ projectRoot });
  return createCapabilityReferenceSnapshot(
    stateMap.bindApplication({
      workspaceExecutionBinding: workspace,
      dataSourceSchemaBinding: dataSources.resolveRuntime({ runtime: 'demo' }).receipt,
      sandboxEnabled: false
    })
  );
}

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-demo-test-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function demoEnvironment(directory, key = crypto.randomBytes(32).toString('base64')) {
  return {
    ...process.env,
    LEGAL_SESSION_KEY_BASE64: key,
    LEGAL_SESSION_OWNER_ID: 'integration-owner',
    LEGAL_SESSION_DATA_DIR: directory
  };
}

function runDemo(environment, args, input = '') {
  return spawnSync(process.execPath, [demoScript, ...args], {
    cwd: projectRoot,
    env: environment,
    input,
    encoding: 'utf8',
    timeout: 10000
  });
}

test('fails startup when the encryption key or owner identity is missing', () => {
  assert.throws(
    () => createLocalLegalAgent({ environment: {} }),
    /LEGAL_SESSION_OWNER_ID/
  );
  assert.throws(
    () => createLocalLegalAgent({ environment: { LEGAL_SESSION_OWNER_ID: 'owner-a' } }),
    /LEGAL_SESSION_KEY_BASE64/
  );
  assert.throws(
    () =>
      createLocalLegalAgent({
        environment: {
          LEGAL_SESSION_OWNER_ID: 'owner-a',
          LEGAL_SESSION_KEY_BASE64: Buffer.alloc(16).toString('base64')
        }
      }),
    /32-byte Buffer/
  );
});

test('resolves the default encrypted data directory below the project root', () => {
  withTemporaryDirectory((temporaryProjectRoot) => {
    const key = crypto.randomBytes(32).toString('base64');
    const app = createLocalLegalAgent({
      projectRoot: temporaryProjectRoot,
      capabilitySnapshot: demoCapabilitySnapshot(),
      environment: {
        LEGAL_SESSION_OWNER_ID: 'owner-a',
        LEGAL_SESSION_KEY_BASE64: key
      }
    });
    assert.equal(app.dataDirectory, path.join(temporaryProjectRoot, 'data', 'sessions'));
    assert.equal(JSON.stringify(app).includes(key), false);
  });
});

test('generates exactly one 256-bit base64 session key', () => {
  const result = spawnSync(process.execPath, [keyScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0);
  assert.equal(Buffer.from(result.stdout, 'base64').length, 32);
  assert.equal(result.stderr, '');
});

test('runs start, answer, history, show, and delete across separate processes', () => {
  withTemporaryDirectory((directory) => {
    const environment = demoEnvironment(directory);
    const originalText = '姓名：测试甲，朋友借钱不还，邮箱 test-user@example.com。';
    const startedProcess = runDemo(
      environment,
      ['start', '--policy-version', PRIVACY_POLICY_VERSION, '--consent'],
      originalText
    );
    assert.equal(startedProcess.status, 0, startedProcess.stderr);
    const started = JSON.parse(startedProcess.stdout);
    assert.equal(started.status, 'needs_clarification');

    const answeredProcess = runDemo(
      environment,
      ['answer', started.sessionId],
      '我有转账记录，说好去年年底还款。'
    );
    assert.equal(answeredProcess.status, 0, answeredProcess.stderr);
    const answered = JSON.parse(answeredProcess.stdout);
    assert.equal(answered.status, 'completed');
    assert.equal(answered.resultCardStatus, 'completed');
    assert.deepEqual(
      answered.resultCards.map((card) => card.lawReferenceId),
      ['cn.civil-code.article-675', 'cn.civil-code.article-676']
    );
    assert.equal(
      answered.resultCards.every((card) => card.legalConclusionGenerated === false),
      true
    );

    const historyProcess = runDemo(environment, ['history']);
    assert.equal(historyProcess.status, 0, historyProcess.stderr);
    const history = JSON.parse(historyProcess.stdout);
    assert.equal(history.length, 1);
    assert.equal(history[0].sessionId, started.sessionId);

    const showProcess = runDemo(environment, ['show', started.sessionId]);
    assert.equal(showProcess.status, 0, showProcess.stderr);
    const detail = JSON.parse(showProcess.stdout);
    assert.equal(detail.messageCount, 2);
    assert.equal(JSON.stringify(detail).includes('测试甲'), false);
    assert.equal(JSON.stringify(detail).includes('test-user@example.com'), false);

    const encryptedFile = path.join(directory, fs.readdirSync(directory)[0]);
    const onDisk = fs.readFileSync(encryptedFile, 'utf8');
    assert.equal(onDisk.includes(originalText), false);
    assert.equal(onDisk.includes('[NAME_1]'), false);

    const unconfirmedDelete = runDemo(environment, ['delete', started.sessionId]);
    assert.equal(unconfirmedDelete.status, 1);
    assert.match(JSON.parse(unconfirmedDelete.stderr).error.message, /--confirm/);
    assert.equal(fs.readdirSync(directory).length, 1);

    const deleteProcess = runDemo(environment, ['delete', started.sessionId, '--confirm']);
    assert.equal(deleteProcess.status, 0, deleteProcess.stderr);
    const deleted = JSON.parse(deleteProcess.stdout);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.deletionAudit.recorded, true);
    assert.match(deleted.deletionAudit.logEntryRef.entryHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(directory), ['v1-execution-log.jsonl']);
    const retainedAudit = fs.readFileSync(
      path.join(directory, 'v1-execution-log.jsonl'),
      'utf8'
    );
    assert.equal(retainedAudit.includes(started.sessionId), false);
    assert.equal(retainedAudit.includes('integration-owner'), false);
  });
});

test('routes a professional query through the CLI without executing V0 law analysis', () => {
  withTemporaryDirectory((directory) => {
    const environment = demoEnvironment(directory);
    const startedProcess = runDemo(
      environment,
      ['start', '--policy-version', PRIVACY_POLICY_VERSION, '--consent'],
      '统计近三年案例库中未签劳动合同案件的胜诉率和赔偿中位数。'
    );
    assert.equal(startedProcess.status, 0, startedProcess.stderr);
    const started = JSON.parse(startedProcess.stdout);

    assert.equal(started.status, 'professional_query_identified');
    assert.equal(started.taskType, 'professional_data_query');
    assert.equal(started.lawRetrievalStatus, 'not_run');
    assert.deepEqual(started.lawReferences, []);

    const historyProcess = runDemo(environment, ['history']);
    assert.equal(historyProcess.status, 0, historyProcess.stderr);
    const history = JSON.parse(historyProcess.stdout);
    assert.equal(history[0].taskType, 'professional_data_query');
  });
});

test('records an explicit CLI refusal without creating a session file', () => {
  withTemporaryDirectory((directory) => {
    const refusedProcess = runDemo(
      demoEnvironment(directory),
      ['start', '--policy-version', PRIVACY_POLICY_VERSION],
      '这段内容不得保存。'
    );
    assert.equal(refusedProcess.status, 0, refusedProcess.stderr);
    const refused = JSON.parse(refusedProcess.stdout);

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.authorizationStatus, 'refused');
    assert.equal(refused.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
    assert.equal(refused.sessionId, undefined);
    assert.equal(fs.existsSync(directory) ? fs.readdirSync(directory).length : 0, 0);
  });
});

test('does not accept legal text as a command-line argument', () => {
  withTemporaryDirectory((directory) => {
    const result = runDemo(demoEnvironment(directory), [
      'start',
      '--policy-version',
      PRIVACY_POLICY_VERSION,
      '--consent',
      '这段文本不应出现在命令行参数中'
    ]);
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, 'LOCAL_DEMO_FAILED');
    assert.match(failure.error.message, /standard input|stdin/);
    assert.equal(fs.existsSync(directory) ? fs.readdirSync(directory).length : 0, 0);
  });
});

test('validates an invalid command before reading environment configuration', () => {
  const result = runDemo({}, ['unknown-command']);
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.match(failure.error.message, /Unknown demo command/);
  assert.equal(failure.error.message.includes('LEGAL_SESSION_KEY_BASE64'), false);
});

test('application fails before composition when the Workspace/Execution manifest is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-missing-execution-profile-'));
  try {
    await assert.rejects(
      createLocalLegalAgentApplication({
        projectRoot,
        workspaceExecutionManifestPath: path.join(directory, 'missing.json'),
        environment: {
          LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
          LEGAL_SESSION_OWNER_ID: 'missing-profile-owner',
          LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
          LEGAL_V1_RUNTIME: 'demo',
          LEGAL_AGENT_PROVIDER: 'demo'
        }
      }),
      (error) => error.code === 'WORKSPACE_EXECUTION_PROFILE_MISSING'
    );
    assert.equal(fs.existsSync(path.join(directory, 'sessions')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('application fails before composition when the DataSource/Schema binding is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-missing-data-source-binding-'));
  try {
    await assert.rejects(
      createLocalLegalAgentApplication({
        projectRoot,
        dataSourceSchemaBindingPath: path.join(directory, 'missing.json'),
        environment: {
          LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
          LEGAL_SESSION_OWNER_ID: 'missing-binding-owner',
          LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
          LEGAL_V1_RUNTIME: 'demo',
          LEGAL_AGENT_PROVIDER: 'demo'
        }
      }),
      (error) => error.code === 'DATA_SOURCE_SCHEMA_PROFILE_MISSING'
    );
    assert.equal(fs.existsSync(path.join(directory, 'sessions')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('application fails before composition when the workflow-state capability map is missing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-missing-state-capability-map-'));
  try {
    await assert.rejects(
      createLocalLegalAgentApplication({
        projectRoot,
        workflowStateCapabilityManifestPath: path.join(directory, 'missing.json'),
        environment: {
          LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
          LEGAL_SESSION_OWNER_ID: 'missing-state-map-owner',
          LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
          LEGAL_V1_RUNTIME: 'demo',
          LEGAL_AGENT_PROVIDER: 'demo'
        }
      }),
      (error) => error.code === 'WORKFLOW_STATE_CAPABILITY_MAP_MISSING'
    );
    assert.equal(fs.existsSync(path.join(directory, 'sessions')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('application rejects an unbound SQLite manifest before opening a data source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-unbound-sqlite-manifest-'));
  try {
    await assert.rejects(
      createLocalLegalAgentApplication({
        projectRoot,
        environment: {
          LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
          LEGAL_SESSION_OWNER_ID: 'unbound-manifest-owner',
          LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
          LEGAL_V1_RUNTIME: 'sqlite',
          LEGAL_V1_SQLITE_MANIFEST: path.join(directory, 'private-unbound.json'),
          LEGAL_AGENT_PROVIDER: 'demo'
        }
      }),
      (error) => error.code === 'DATA_SOURCE_MANIFEST_NOT_BOUND'
    );
    assert.equal(fs.existsSync(path.join(directory, 'sessions')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('application rejects an injected V1 runtime that does not match the selected binding', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-runtime-binding-drift-'));
  try {
    await assert.rejects(
      createLocalLegalAgentApplication({
        projectRoot,
        v1Runtime: {
          describe() {
            return { runtime: 'sqlite-readonly', dataSource: 'private.unbound.source' };
          }
        },
        environment: {
          LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
          LEGAL_SESSION_OWNER_ID: 'runtime-drift-owner',
          LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
          LEGAL_V1_RUNTIME: 'demo',
          LEGAL_AGENT_PROVIDER: 'demo'
        }
      }),
      /runtime has drifted/
    );
    assert.equal(fs.existsSync(path.join(directory, 'sessions')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('application composes an injected Sandbox runtime without requiring Docker configuration', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-sandbox-bootstrap-'));
  const sandboxRuntime = {
    describe: () => ({ runtime: 'mock-sandbox', policy: { network: 'disabled' } }),
    plan: async (input) => ({
      status: 'awaiting_confirmation',
      invocationId: `lexpilot-sandbox.${input.runId}`,
      plan: {
        language: input.language,
        scriptSha256: `sha256:${'a'.repeat(64)}`,
        planHash: `sha256:${'b'.repeat(64)}`,
        inputFileCount: input.inputFiles.length,
        inputBytes: 0
      }
    }),
    approve: async () => ({
      status: 'completed',
      executionAttempted: true,
      result: { generatedArtifactRefs: [] },
      governanceReceipt: { eventCount: 2 }
    }),
    reject: async () => ({ status: 'rejected' })
  };
  let application;
  try {
    application = await createLocalLegalAgentApplication({
      projectRoot,
      sandboxRuntime,
      environment: {
        LEGAL_SESSION_KEY_BASE64: crypto.randomBytes(32).toString('base64'),
        LEGAL_SESSION_OWNER_ID: 'sandbox-bootstrap-owner',
        LEGAL_SESSION_DATA_DIR: path.join(directory, 'sessions'),
        LEGAL_V1_EXECUTION_LOG_FILE: path.join(directory, 'execution-log.jsonl'),
        LEGAL_V1_ARTIFACT_DIR: path.join(directory, 'artifacts'),
        LEGAL_V1_RUNTIME: 'demo',
        LEGAL_AGENT_PROVIDER: 'demo'
      }
    });
    assert.equal(application.sandboxDescriptor.available, true);
    assert.equal(application.startupRetentionCleanup.status, 'completed');
    assert.equal(application.startupRetentionCleanup.artifactPendingCount, 0);
    assert.equal(application.sandboxDescriptor.runtime, 'mock-sandbox');
    assert.equal(typeof application.sandboxCoordinator.plan, 'function');
    assert.equal(application.sandboxDescriptor.auditLog, 'append-only-sha256-chain');
    const sandboxPlan = await application.sandboxCoordinator.plan({
      language: 'python',
      script: 'print("private-bootstrap-script")',
      inputFiles: []
    });
    await application.sandboxCoordinator.confirm(sandboxPlan.planId, { confirmed: true });
    const queryPlan = await application.service.start({
      userText: '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    await application.service.confirmV1Execution(queryPlan.sessionId, { confirmed: true });
    const auditText = fs.readFileSync(application.executionLogFilePath, 'utf8');
    const auditRecords = auditText.trim().split('\n').map(JSON.parse);
    assert.equal(auditRecords.length, 4);
    assert.equal(auditRecords.every((record) => record.actorId === auditRecords[0].actorId), true);
    assert.match(auditRecords[0].actorId, /^actor-hmac-sha256-[0-9a-f]{64}$/);
    assert.deepEqual(
      auditRecords.map((record) => record.operationType),
      ['sandbox_plan', 'sandbox_execute', 'plan', 'execute']
    );
    assert.equal(auditText.includes('sandbox-bootstrap-owner'), false);
    assert.equal(auditText.includes('private-bootstrap-script'), false);
    const profiles = application.dataSourceAdmin.listProfiles();
    assert.deepEqual(
      profiles.profiles.map((profile) => profile.engine),
      ['sqlite', 'postgresql', 'mysql']
    );
    assert.equal(profiles.credentialInputAccepted, false);
    assert.equal(JSON.stringify(profiles).includes(directory), false);
    assert.deepEqual(application.workspaceExecutionBinding.executionProfileRef, {
      id: 'execution-environment.lexpilot.scripts',
      version: '1.0.0'
    });
    assert.equal(application.workspaceExecutionBinding.hyphaExecutionEnvironmentValidated, true);
    assert.equal(application.accessControl.describe().role, 'user');
    assert.equal(application.accessControl.describe().clientRoleSelectable, false);
    assert.equal(JSON.stringify(application.workspaceExecutionBinding).includes(directory), false);
    assert.equal(application.dataSourceSchemaBinding.runtime, 'demo');
    assert.equal(application.dataSourceSchemaBinding.selectedProfile, null);
    assert.deepEqual(application.dataSourceSchemaBinding.schemaSnapshotContractRef, {
      id: 'schema-snapshot.allowlisted.v1',
      version: '1.0.0'
    });
    assert.equal(
      application.workflowStateCapabilityBinding.bindingId,
      'binding.legal-workflow-state-capabilities'
    );
    assert.deepEqual(application.workflowStateCapabilityBinding.runtimeWorkflowRef, {
      id: 'workflow.legal-professional-query',
      version: '1.0.0'
    });
    assert.equal(application.workflowStateCapabilityBinding.domainStateBindingCount, 13);
    assert.equal(application.workflowStateCapabilityBinding.runtimeStateBindingCount, 12);
    assert.equal(application.workflowStateCapabilityBinding.referencesRetained, true);
    assert.equal(
      application.capabilitySnapshotRef.id,
      'capability-snapshot.legal-session-agent'
    );
    assert.match(application.capabilitySnapshotRef.snapshotSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(application.agentCapabilityPatchRef.id, 'agent-patch.legal-capabilities');
    assert.match(application.agentCapabilityPatchRef.patchSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      application.artifactOutputBindingRef.id,
      'binding.legal-v1-artifact-outputs'
    );
    assert.match(
      application.artifactOutputBindingRef.manifestCanonicalSha256,
      /^sha256:[0-9a-f]{64}$/
    );
    assert.deepEqual(application.artifactOutputBinding.activeStores, ['analysis']);
    assert.equal(application.artifactOutputBinding.repositoryDescriptorsValidated, true);
    assert.deepEqual(
      application.agentDescriptor.capabilitySnapshotRef,
      application.capabilitySnapshotRef
    );
    assert.equal(
      JSON.stringify(application.workflowStateCapabilityBinding).includes(directory),
      false
    );
    assert.equal(JSON.stringify(application.capabilitySnapshotRef).includes(directory), false);
    assert.equal(JSON.stringify(application.artifactOutputBinding).includes(directory), false);
  } finally {
    await application?.close?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
