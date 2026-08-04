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
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');

const projectRoot = path.resolve(__dirname, '..');
const demoScript = path.join(projectRoot, 'scripts', 'demo-v0.cjs');
const keyScript = path.join(projectRoot, 'scripts', 'generate-session-key.cjs');

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
    assert.equal(JSON.parse(deleteProcess.stdout).status, 'deleted');
    assert.equal(fs.readdirSync(directory).length, 0);
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

test('application composes an injected Sandbox runtime without requiring Docker configuration', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-sandbox-bootstrap-'));
  const sandboxRuntime = {
    describe: () => ({ runtime: 'mock-sandbox', policy: { network: 'disabled' } }),
    plan: async () => ({ status: 'awaiting_confirmation', invocationId: 'mock-invocation', plan: {} }),
    approve: async () => ({ status: 'completed' }),
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
    assert.equal(application.sandboxDescriptor.runtime, 'mock-sandbox');
    assert.equal(typeof application.sandboxCoordinator.plan, 'function');
    const profiles = application.dataSourceAdmin.listProfiles();
    assert.deepEqual(
      profiles.profiles.map((profile) => profile.engine),
      ['sqlite', 'postgresql', 'mysql']
    );
    assert.equal(profiles.credentialInputAccepted, false);
    assert.equal(JSON.stringify(profiles).includes(directory), false);
  } finally {
    await application?.close?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
