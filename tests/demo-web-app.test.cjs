const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');
const {
  MAX_JSON_BODY_BYTES,
  MAX_SANDBOX_JSON_BODY_BYTES,
  createDemoWebServer
} = require('../src/web/demo-web-app.cjs');

function createService() {
  let nextId = 1;
  return new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'web-demo-test-user',
    idFactory: () => `web-session-${nextId++}`,
    clock: () => '2026-07-21T03:00:00.000Z',
    autoCleanup: false
  });
}

async function withServer(run) {
  const server = createDemoWebServer({ service: createService() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withSandboxServer(run) {
  const calls = [];
  const sandboxCoordinator = {
    describe() {
      return { available: true, runtime: 'mock-sandbox', policy: { network: 'disabled' } };
    },
    async plan(input) {
      calls.push(['plan', input]);
      return {
        status: 'awaiting_confirmation',
        planId: 'sandbox-plan-1',
        executionAttempted: false,
        plan: {
          language: input.language,
          scriptSha256: 'sha256:safe-only',
          inputFiles: [],
          requiresConfirmation: true
        }
      };
    },
    async confirm(planId, input) {
      calls.push(['confirm', planId, input]);
      return input.confirmed
        ? {
            status: 'completed',
            executionAttempted: true,
            result: { exitCode: 0, generatedArtifactRefs: ['artifact:mock:generated'] },
            governanceReceipt: { eventCount: 3, eventTypes: ['human.review.approved'] }
          }
        : { status: 'rejected', executionAttempted: false };
    }
  };
  const server = createDemoWebServer({ service: createService(), sandboxCoordinator });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withDataSourceAdminServer(run) {
  const validationCalls = [];
  const dataSourceAdmin = {
    listProfiles() {
      return {
        status: 'ok',
        activeRuntime: 'demo',
        credentialInputAccepted: false,
        credentialValuesExposed: false,
        profiles: [
          {
            profileId: 'network.legal_cases.postgresql',
            engine: 'postgresql',
            accessMode: 'read-only',
            configurationStatus: 'ready',
            environment: [{ name: 'LEGAL_V1_PG_PASSWORD', required: true, configured: true }],
            allowedTables: ['labor_cases'],
            allowedColumns: ['year'],
            credentialValuesExposed: false
          }
        ]
      };
    },
    async validateProfile(profileId) {
      validationCalls.push(profileId);
      return {
        status: 'verified',
        profileId,
        connectionAttempted: true,
        connectionStatus: 'connected',
        schemaStatus: 'verified',
        schemaFingerprint: 'a'.repeat(64),
        initialSchemaSnapshot: {
          contractRef: { id: 'schema-snapshot.allowlisted.v1', version: '1.0.0' },
          tables: [
            {
              name: 'labor_cases',
              columns: [
                { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 }
              ]
            }
          ]
        },
        tableCount: 1,
        columnCount: 1,
        credentialValuesExposed: false
      };
    }
  };
  const server = createDemoWebServer({ service: createService(), dataSourceAdmin });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, validationCalls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

// fetch 不允许伪造 Host 头，这里用原始 http.request 构造可控制 Host 的请求。
async function rawRequest(baseUrl, { method = 'GET', pathname, headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathname,
        method,
        headers,
        setHost: false
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ response, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('exposes a localhost health contract with defensive browser headers', async () => {
  await withServer(async (baseUrl) => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.demoMode, true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('exposes a credential-free data-source admin list and fixed validation action', async () => {
  await withDataSourceAdminServer(async (baseUrl, validationCalls) => {
    const listed = await jsonRequest(`${baseUrl}/api/v1/admin/data-sources`);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.credentialInputAccepted, false);
    assert.equal(listed.body.credentialValuesExposed, false);
    assert.equal(JSON.stringify(listed.body).includes('LEGAL_V1_PG_PASSWORD'), true);
    assert.equal(JSON.stringify(listed.body).includes('TEST_ONLY_PASSWORD_VALUE'), false);

    const validated = await jsonRequest(
      `${baseUrl}/api/v1/admin/data-sources/validation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'network.legal_cases.postgresql' })
      }
    );
    assert.equal(validated.response.status, 200);
    assert.equal(validated.body.status, 'verified');
    assert.deepEqual(validated.body.initialSchemaSnapshot, {
      contractRef: { id: 'schema-snapshot.allowlisted.v1', version: '1.0.0' },
      tables: [
        {
          name: 'labor_cases',
          columns: [
            { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 }
          ]
        }
      ]
    });
    assert.deepEqual(validationCalls, ['network.legal_cases.postgresql']);

    const credentialInjection = await jsonRequest(
      `${baseUrl}/api/v1/admin/data-sources/validation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: 'network.legal_cases.postgresql',
          password: 'TEST_ONLY_PASSWORD_VALUE'
        })
      }
    );
    assert.equal(credentialInjection.response.status, 400);
    assert.equal(credentialInjection.body.error.code, 'INVALID_REQUEST');
    assert.deepEqual(validationCalls, ['network.legal_cases.postgresql']);
    assert.equal(JSON.stringify(credentialInjection.body).includes('TEST_ONLY_PASSWORD_VALUE'), false);
  });
});

test('keeps data-source admin routes unavailable when no admin coordinator is configured', async () => {
  await withServer(async (baseUrl) => {
    const listed = await jsonRequest(`${baseUrl}/api/v1/admin/data-sources`);
    assert.equal(listed.response.status, 501);
    assert.equal(listed.body.error.code, 'DATA_SOURCE_ADMIN_UNAVAILABLE');
  });
});

test('exposes Sandbox availability and runs the plan-confirm flow without echoing script content', async () => {
  await withSandboxServer(async (baseUrl, calls) => {
    const health = await jsonRequest(`${baseUrl}/api/health`);
    const config = await jsonRequest(`${baseUrl}/api/config`);
    assert.equal(health.body.sandbox.available, true);
    assert.equal(config.body.sandbox.available, true);
    assert.equal(config.body.sandboxLimits.maxInputFiles, 32);

    const privateScript = 'print("private-script-value")';
    const planned = await jsonRequest(`${baseUrl}/api/v1/sandbox/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python', script: privateScript, inputFiles: [] })
    });
    assert.equal(planned.response.status, 200);
    assert.equal(planned.body.status, 'awaiting_confirmation');
    assert.equal(planned.body.executionAttempted, false);
    assert.equal(JSON.stringify(planned.body).includes(privateScript), false);
    assert.equal(calls[0][1].script, privateScript);

    const confirmed = await jsonRequest(
      `${baseUrl}/api/v1/sandbox/plans/${planned.body.planId}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.executionAttempted, true);
    assert.deepEqual(confirmed.body.result.generatedArtifactRefs, ['artifact:mock:generated']);
    assert.deepEqual(calls.map((call) => call[0]), ['plan', 'confirm']);
  });
});

test('Sandbox Web routes reject undeclared fields and remain unavailable by default', async () => {
  await withServer(async (baseUrl) => {
    const config = await jsonRequest(`${baseUrl}/api/config`);
    assert.equal(config.body.sandbox.available, false);
    const unavailable = await jsonRequest(`${baseUrl}/api/v1/sandbox/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python', script: 'print(1)', inputFiles: [] })
    });
    assert.equal(unavailable.response.status, 501);
    assert.equal(unavailable.body.error.code, 'SANDBOX_UNAVAILABLE');
  });

  await withSandboxServer(async (baseUrl) => {
    const invalidPlan = await jsonRequest(`${baseUrl}/api/v1/sandbox/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python', script: 'print(1)', inputFiles: [], debug: true })
    });
    assert.equal(invalidPlan.response.status, 400);
    const invalidConfirmation = await jsonRequest(
      `${baseUrl}/api/v1/sandbox/plans/sandbox-plan-1/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: 'yes' })
      }
    );
    assert.equal(invalidConfirmation.response.status, 400);
  });
});

test('Sandbox request body has a dedicated bounded upload limit', async () => {
  assert.ok(MAX_SANDBOX_JSON_BODY_BYTES > MAX_JSON_BODY_BYTES);
  await withSandboxServer(async (baseUrl) => {
    const oversized = await jsonRequest(`${baseUrl}/api/v1/sandbox/plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_SANDBOX_JSON_BODY_BYTES + 1) })
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');
  });
});

test('serves the local web shell and its fixed static assets', async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    const presentationScript = await fetch(`${baseUrl}/v1-presentation.js`);
    const script = await fetch(`${baseUrl}/app.js`);
    const styles = await fetch(`${baseUrl}/styles.css`);

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /法律合规审查智能助手/);
    const pageText = await (await fetch(`${baseUrl}/`)).text();
    assert.match(pageText, />法律自检</);
    assert.match(pageText, />专业数据分析</);
    assert.doesNotMatch(pageText, />\s*V[01]\b/);
    assert.match(pageText, /data-mode="sandbox"/);
    assert.match(pageText, /id="sandbox-language"/);
    assert.match(pageText, /id="sandbox-files"/);
    assert.match(pageText, /id="open-data-source-admin"/);
    assert.match(pageText, /id="data-source-admin-modal"/);
    assert.doesNotMatch(pageText, /type="password"/);
    assert.match(pageText, /src="\/v1-presentation\.js"/);
    assert.equal(presentationScript.status, 200);
    assert.match(presentationScript.headers.get('content-type'), /text\/javascript/);
    const presentationText = await presentationScript.text();
    assert.match(presentationText, /LexPilotV1Presentation/);
    assert.match(presentationText, /expectedOutput/);
    assert.match(presentationText, /sourceRowCount/);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/javascript/);
    const scriptText = await script.text();
    assert.match(scriptText, /privacyPolicyVersion/);
    assert.match(scriptText, /v1Presentation\.buildPresentation/);
    assert.match(scriptText, /mode === 'demo'/);
    assert.match(scriptText, /submitSandboxScript/);
    assert.match(scriptText, /confirmSandboxExecution/);
    assert.match(scriptText, /openDataSourceAdmin/);
    assert.match(scriptText, /\/api\/v1\/admin\/data-sources\/validation/);
    assert.match(scriptText, /renderInitialSchemaSnapshot/);
    assert.match(scriptText, /初始 Schema 快照/);
    assert.match(scriptText, /Provider 未识别/);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type'), /text\/css/);
    const stylesheet = await styles.text();
    assert.match(stylesheet, /--green:/);
    assert.match(stylesheet, /\.app-shell\s*\{[^}]*height:\s*100dvh/s);
    assert.match(stylesheet, /\.workspace\s*\{[^}]*min-height:\s*0/s);
    assert.match(stylesheet, /\.chat-scroll\s*\{[^}]*min-height:\s*0/s);
    assert.match(stylesheet, /\.v1-board\s*\{/);
    assert.match(stylesheet, /\.initial-schema-browser\s*\{/);
    assert.match(stylesheet, /\.mode-switch\s*\{/);
  });
});

test('runs start, history, detail, and confirmed deletion through the web API', async () => {
  await withServer(async (baseUrl) => {
    const started = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.body.status, 'completed');
    assert.equal(started.body.resultCards.length, 1);
    assert.equal(started.body.legalConclusionGenerated, false);

    const history = await jsonRequest(`${baseUrl}/api/sessions`);
    assert.equal(history.body.sessions.length, 1);
    assert.equal(Object.hasOwn(history.body.sessions[0], 'messages'), false);

    const detail = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}`
    );
    assert.equal(detail.body.session.messages.length, 1);
    assert.equal(detail.body.session.resultCards.length, 1);

    const unconfirmed = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: false })
      }
    );
    assert.equal(unconfirmed.response.status, 400);

    const deleted = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted, true);
  });
});

test('supports a clarification answer without accepting undeclared request fields', async () => {
  await withServer(async (baseUrl) => {
    const started = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '老板让我明天不用来了。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    assert.equal(started.body.status, 'needs_clarification');
    assert.ok(started.body.questions.length <= 2);

    const answered = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/answers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userText: '我工作了3年，没有签合同。' })
      }
    );
    assert.equal(answered.body.status, 'completed');

    const invalid = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '测试',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        rawDebugText: 'not allowed'
      })
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST');

    const emptyText = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    assert.equal(emptyText.response.status, 200);
    assert.equal(emptyText.body.error.code, 'INVALID_USER_TEXT');
  });
});

test('rejects invalid JSON and oversized bodies without exposing server details', async () => {
  await withServer(async (baseUrl) => {
    const invalidJson = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid'
    });
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.error.code, 'INVALID_JSON');

    const oversized = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) })
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');

    const missing = await jsonRequest(`${baseUrl}/api/not-real`);
    assert.equal(missing.response.status, 404);
    assert.equal(JSON.stringify(missing.body).includes('D:\\'), false);
  });
});

test('rejects forged or missing Host headers on every route including static assets', async () => {
  await withServer(async (baseUrl) => {
    const { port } = new URL(baseUrl);

    const forgedApi = await rawRequest(baseUrl, {
      pathname: '/api/sessions',
      headers: { host: `evil.com:${port}` }
    });
    assert.equal(forgedApi.response.statusCode, 403);
    assert.equal(JSON.parse(forgedApi.text).error.code, 'FORBIDDEN_HOST');

    const forgedStatic = await rawRequest(baseUrl, {
      pathname: '/',
      headers: { host: `evil.com:${port}` }
    });
    assert.equal(forgedStatic.response.statusCode, 403);
    assert.equal(JSON.parse(forgedStatic.text).error.code, 'FORBIDDEN_HOST');

    const missingHost = await rawRequest(baseUrl, { pathname: '/api/health' });
    // Node HTTP 服务器对缺失 Host 的 HTTP/1.1 请求直接返回 400；
    // 到达 handler 的（如 HTTP/1.0）则由白名单返回 403 FORBIDDEN_HOST。
    assert.ok([400, 403].includes(missingHost.response.statusCode));
    if (missingHost.response.statusCode === 403) {
      assert.equal(JSON.parse(missingHost.text).error.code, 'FORBIDDEN_HOST');
    }

    const localhost = await rawRequest(baseUrl, {
      pathname: '/api/health',
      headers: { host: `localhost:${port}` }
    });
    assert.equal(localhost.response.statusCode, 200);

    const loopback = await rawRequest(baseUrl, {
      pathname: '/api/health',
      headers: { host: `127.0.0.1:${port}` }
    });
    assert.equal(loopback.response.statusCode, 200);
  });
});

test('requires application/json content type for API write requests', async () => {
  await withServer(async (baseUrl) => {
    const plainText = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        userText: '测试',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    assert.equal(plainText.response.status, 415);
    assert.equal(plainText.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const plainTextDelete = await jsonRequest(`${baseUrl}/api/sessions/web-session-1`, {
      method: 'DELETE',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ confirmed: true })
    });
    assert.equal(plainTextDelete.response.status, 415);
    assert.equal(plainTextDelete.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const withCharset = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    assert.equal(withCharset.response.status, 200);
    assert.equal(withCharset.body.status, 'completed');

    const getWithoutContentType = await jsonRequest(`${baseUrl}/api/sessions`);
    assert.equal(getWithoutContentType.response.status, 200);
  });
});

test('starts the documented web demo process and serves localhost health', async () => {
  const port = await findFreePort();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-web-demo-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'demo-web.cjs')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      LEGAL_SESSION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'),
      LEGAL_SESSION_OWNER_ID: 'web-process-test-user',
      LEGAL_SESSION_DATA_DIR: dataDirectory,
      LEGAL_DEMO_PORT: String(port),
      LEGAL_AGENT_PROVIDER: 'demo',
      LEGAL_AGENT_BASE_URL: '',
      LEGAL_AGENT_MODEL: '',
      LEGAL_AGENT_API_KEY: '',
      LEGAL_AGENT_FALLBACK: 'none'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('web demo start timeout')), 10_000);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`web demo exited early: ${code}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200, Buffer.concat(stderr).toString('utf8'));
    const health = await response.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.productScope, 'V0 + V1');
    assert.equal(health.agent.agentId, 'agent.legal-compliance');
    assert.equal(health.agent.inference.mode, 'demo');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');
const { createV1DemoQueryRuntime } = require('../src/v1/demo-query-runtime.cjs');

async function withV1Server(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-web-v1-test-'));
  let nextId = 1;
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'web-demo-test-user',
    idFactory: () => `web-v1-session-${nextId++}`,
    clock: () => '2026-07-21T03:00:00.000Z',
    autoCleanup: false,
    v1Runtime: createV1DemoQueryRuntime(),
    executionLog: createDemoExecutionLog({
      filePath: path.join(directory, 'v1-execution-log.jsonl')
    })
  });
  const server = createDemoWebServer({
    service,
    v1Descriptor: createV1DemoQueryRuntime().describe()
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('runs the V1 plan-confirm-execute flow and exposes the execution log', async () => {
  await withV1Server(async (baseUrl) => {
    const started = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        requestedOutputFormats: ['pdf', 'table']
      })
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.body.status, 'awaiting_confirmation');
    assert.match(started.body.v1.plan.sql, /^SELECT/);
    assert.equal(started.body.v1.plan.requiresConfirmation, true);
    assert.equal(started.body.v1.result, null);
    assert.equal(
      started.body.v1.taskInput.schema,
      'task-input.legal-professional-query@1.0.0'
    );
    assert.equal(started.body.v1.taskInput.dataSourceId, 'demo.labor_cases');
    assert.deepEqual(started.body.v1.taskInput.requestedOutputFormats, ['table', 'pdf']);
    assert.equal(started.body.v1.taskInput.workspacePathExposed, false);
    assert.equal(
      JSON.stringify(started.body.v1.taskInput).includes(
        '统计近三年案例库未签劳动合同'
      ),
      false
    );

    const forgedSelector = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        requestedOutputFormats: ['table'],
        dataSourceId: 'private.unbound.source'
      })
    });
    assert.equal(forgedSelector.response.status, 400);
    assert.equal(forgedSelector.body.error.code, 'INVALID_REQUEST');

    const invalidReplan = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/schema-replan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requested: false })
      }
    );
    assert.equal(invalidReplan.response.status, 400);
    assert.equal(invalidReplan.body.error.code, 'INVALID_REQUEST');

    const unnecessaryReplan = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/schema-replan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requested: true })
      }
    );
    assert.equal(unnecessaryReplan.response.status, 200);
    assert.equal(unnecessaryReplan.body.error.code, 'V1_REPLAN_NOT_REQUIRED');

    const config = await jsonRequest(`${baseUrl}/api/config`);
    assert.equal(config.response.status, 200);
    assert.equal(config.body.v1DemoDataSource, 'demo.labor_cases');
    assert.equal(config.body.v1DemoSchema.dataSource, 'demo.labor_cases');
    assert.equal(config.body.v1DemoSchema.displayName, '匿名劳动争议案例库');
    assert.equal(
      config.body.v1TaskInput.schema,
      'task-input.legal-professional-query@1.0.0'
    );
    assert.deepEqual(config.body.v1TaskInput.supportedOutputFormats, [
      'table',
      'chart',
      'analysis-document',
      'pdf'
    ]);
    assert.equal(config.body.v1TaskInput.dataSourceSelection, 'administrator-bound-active-runtime');
    assert.equal(config.body.v1TaskInput.workspacePathExposed, false);
    assert.ok(Array.isArray(config.body.v1DemoSchema.columns));
    assert.ok(config.body.v1DemoSchema.columns.length > 0);
    assert.equal(typeof config.body.v1DemoSchema.columns[0].name, 'string');
    assert.equal(typeof config.body.v1DemoSchema.columns[0].type, 'string');
    assert.equal(typeof config.body.v1DemoSchema.columns[0].description, 'string');

    const invalidType = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: 'yes' })
      }
    );
    assert.equal(invalidType.response.status, 400);
    assert.equal(invalidType.body.error.code, 'INVALID_REQUEST');

    const extraKey = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, comment: 'not allowed' })
      }
    );
    assert.equal(extraKey.response.status, 400);

    const confirmed = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.status, 'completed');
    assert.equal(confirmed.body.v1.result.rows.length, 3);
    assert.equal(confirmed.body.v1.artifact.type, 'analysis-document');

    const repeated = await jsonRequest(
      `${baseUrl}/api/sessions/${started.body.sessionId}/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    assert.equal(repeated.body.error.code, 'V1_EXECUTION_NOT_AWAITING_CONFIRMATION');

    const logs = await jsonRequest(`${baseUrl}/api/v1/logs`);
    assert.equal(logs.response.status, 200);
    assert.equal(logs.body.logs.length, 2);
    assert.equal(logs.body.logs[0].status, 'completed');
    assert.equal(logs.body.logs[0].operationType, 'execute');
    assert.equal(logs.body.logs[0].sessionId, started.body.sessionId);
    assert.equal(logs.body.logs[1].operationType, 'plan');
    assert.equal(logs.body.integrity.status, 'verified');
    assert.equal(logs.body.integrity.recordCount, 2);

    const emptyFilter = await jsonRequest(`${baseUrl}/api/v1/logs?status=cancelled`);
    assert.equal(emptyFilter.body.logs.length, 0);

    const invalidLimit = await jsonRequest(`${baseUrl}/api/v1/logs?limit=abc`);
    assert.equal(invalidLimit.response.status, 400);

    const second = await jsonRequest(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userText: '统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      })
    });
    const cancelled = await jsonRequest(
      `${baseUrl}/api/sessions/${second.body.sessionId}/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: false })
      }
    );
    assert.equal(cancelled.body.status, 'cancelled');
    const cancelledLogs = await jsonRequest(`${baseUrl}/api/v1/logs?status=cancelled&limit=10`);
    assert.equal(cancelledLogs.body.logs.length, 1);
    assert.equal(cancelledLogs.body.logs[0].operationType, 'cancel');
  });
});

test('returns 501 when the service does not expose V1 execution capabilities', async () => {
  const legacyService = {
    start() {},
    answer() {},
    listHistory() {
      return [];
    },
    getHistory() {
      return null;
    },
    deleteSession() {
      return { deleted: false };
    }
  };
  const server = createDemoWebServer({ service: legacyService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const confirmation = await jsonRequest(
      `${baseUrl}/api/sessions/web-session-1/execution-confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }
    );
    assert.equal(confirmation.response.status, 501);
    assert.equal(confirmation.body.error.code, 'V1_CONFIRMATION_UNAVAILABLE');

    const replan = await jsonRequest(
      `${baseUrl}/api/sessions/web-session-1/schema-replan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requested: true })
      }
    );
    assert.equal(replan.response.status, 501);
    assert.equal(replan.body.error.code, 'V1_REPLAN_UNAVAILABLE');

    const logs = await jsonRequest(`${baseUrl}/api/v1/logs`);
    assert.equal(logs.response.status, 501);
    assert.equal(logs.body.error.code, 'V1_EXECUTION_LOG_UNAVAILABLE');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
