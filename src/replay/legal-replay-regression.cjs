const { createHash } = require('node:crypto');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  loadHyphaCore,
  loadHyphaDomain,
  loadHyphaTesting
} = require('../../scripts/hypha-paths.cjs');
const { PRIVACY_POLICY_VERSION } = require('../v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../v0/conversation-service.cjs');
const { detectPii } = require('../v0/pii-redactor.cjs');
const { InMemoryLegalSessionStore } = require('../v0/session-store.cjs');
const { createDemoExecutionLog } = require('../v1/demo-execution-log.cjs');
const { createExecutionArtifactRepository } = require('../v1/execution-artifact-repository.cjs');
const { createV1DemoQueryRuntime } = require('../v1/demo-query-runtime.cjs');

const FIXED_NOW = '2026-08-03T08:00:00.000Z';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_ID = 'replay.legal-compliance.v0-v1';
const REGRESSION_SPEC_ID = 'regression.legal-v0-v1-replay';
const FIXTURE_FILE_PATTERN = /^[A-Za-z0-9._-]+\.replay\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i
]);
const FORBIDDEN_KEYS = new Set([
  'apiKey',
  'authorization',
  'cookie',
  'customerData',
  'ownerId',
  'password',
  'rawText',
  'redactedText',
  'sessionId',
  'token',
  'userId',
  'userText'
]);

class ReplayFixtureValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReplayFixtureValidationError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256')
    .update(content.replace(/\r\n?/g, '\n'), 'utf8')
    .digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSafeFixtureValue(value, location = '$') {
  if (typeof value === 'string') {
    const piiTypes = detectPii(value);
    if (piiTypes.length > 0) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_PII_DETECTED',
        `Replay fixture contains PII at ${location}: ${piiTypes.join(',')}`
      );
    }
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_SECRET_DETECTED',
        `Replay fixture contains a secret-like value at ${location}.`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFixtureValue(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_FORBIDDEN_FIELD',
        `Replay fixture field is forbidden at ${location}.${key}.`
      );
    }
    assertSafeFixtureValue(child, `${location}.${key}`);
  }
}

function requireManifestEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new ReplayFixtureValidationError('REPLAY_MANIFEST_INVALID', 'Fixture entry is invalid.');
  }
  if (
    typeof entry.id !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(entry.id) ||
    typeof entry.version !== 'string' ||
    typeof entry.file !== 'string' ||
    !FIXTURE_FILE_PATTERN.test(entry.file) ||
    !SHA256_PATTERN.test(entry.sha256 ?? '')
  ) {
    throw new ReplayFixtureValidationError(
      'REPLAY_MANIFEST_INVALID',
      'Fixture entry must contain a safe file name, id, version, and SHA-256.'
    );
  }
}

async function readVerifiedFixtureSet(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const directory = path.resolve(
    options.directory ?? path.join(projectRoot, 'configs', 'replay-fixtures')
  );
  const manifestPath = path.join(directory, MANIFEST_FILE);
  const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  if (
    manifest.id !== MANIFEST_ID ||
    manifest.regressionSpecRef?.id !== REGRESSION_SPEC_ID ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length !== 2
  ) {
    throw new ReplayFixtureValidationError(
      'REPLAY_MANIFEST_INVALID',
      'Replay manifest identity or fixture count is invalid.'
    );
  }
  const testing = loadHyphaTesting(projectRoot);
  const store = new testing.FileReplayFixtureStore({ directory });
  const fixtures = [];
  const seenIds = new Set();
  const seenFiles = new Set();
  for (const entry of manifest.fixtures) {
    requireManifestEntry(entry);
    if (seenIds.has(entry.id) || seenFiles.has(entry.file)) {
      throw new ReplayFixtureValidationError(
        'REPLAY_MANIFEST_INVALID',
        'Replay manifest fixture ids and file names must be unique.'
      );
    }
    seenIds.add(entry.id);
    seenFiles.add(entry.file);
    const fixturePath = path.join(directory, entry.file);
    const fixtureStats = await fsPromises.lstat(fixturePath);
    if (!fixtureStats.isFile() || fixtureStats.isSymbolicLink()) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_FILE_INVALID',
        `Replay fixture must be a regular file: ${entry.id}`
      );
    }
    const content = await fsPromises.readFile(fixturePath, 'utf8');
    if (sha256(content) !== entry.sha256) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_HASH_MISMATCH',
        `Replay fixture hash mismatch: ${entry.id}`
      );
    }
    const fixture = await store.get(entry.id);
    if (!fixture || fixture.id !== entry.id || fixture.version !== entry.version) {
      throw new ReplayFixtureValidationError(
        'REPLAY_FIXTURE_REF_MISMATCH',
        `Replay fixture reference mismatch: ${entry.id}`
      );
    }
    assertSafeFixtureValue(fixture);
    const projection = new testing.ReplayEngine().replay(fixture).projection;
    for (const key of [
      'eventTypes',
      'statePath',
      'toolCalls',
      'modelCalls',
      'policyDecisions',
      'memoryReadSet'
    ]) {
      if (stableStringify(fixture[key]) !== stableStringify(projection[key])) {
        throw new ReplayFixtureValidationError(
          'REPLAY_FIXTURE_PROJECTION_MISMATCH',
          `Replay fixture projection is stale for ${entry.id}: ${key}`
        );
      }
    }
    fixtures.push(fixture);
  }
  return { directory, manifest, fixtures };
}

function eventFactory(core, runId) {
  let sequence = 0;
  return (type, payload = {}, options = {}) => {
    sequence += 1;
    return core.createFrameworkEvent({
      id: `${runId}:event:${sequence}`,
      type,
      runId,
      timestamp: `2026-08-03T08:00:${String(sequence).padStart(2, '0')}.000Z`,
      payload,
      ...options
    });
  };
}

function addStateEvents(events, makeEvent, states) {
  for (const stateId of states) {
    events.push(makeEvent('fsm.state.entered', { stateId }, { fsmState: stateId }));
  }
}

function createV0ScenarioEvents(projectRoot) {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    ownerId: 'fixture-owner',
    idFactory: () => 'fixture-v0-session',
    clock: () => FIXED_NOW,
    autoCleanup: false
  });
  const result = service.start({
    userText:
      '\u6211\u5728\u516c\u53f8\u5de5\u4f5c\u4e24\u5e74\uff0c\u516c\u53f8\u63d0\u51fa\u89e3\u9664\u52b3\u52a8\u5408\u540c\uff0c\u53cc\u65b9\u7b7e\u8fc7\u4e66\u9762\u52b3\u52a8\u5408\u540c\u3002',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const core = loadHyphaCore(projectRoot);
  const runId = 'run-fixture-legal-self-check-v0';
  const makeEvent = eventFactory(core, runId);
  const events = [makeEvent('run.started', { scenarioId: 'legal-self-check-v0' })];
  addStateEvents(events, makeEvent, [
    'Intake',
    'PrivacyConsent',
    'RedactInput',
    'SaveSession',
    'ClassifyTask',
    'ClassifyDomain',
    'CheckInformation',
    'Clarify'
  ]);
  events.push(
    makeEvent(
      'tool.policy.checked',
      { toolId: 'tool.pii-redactor', decision: 'allow' },
      { stepId: 'privacy-gate' }
    ),
    makeEvent(
      'tool.call.started',
      { toolId: 'tool.legal-domain-classifier', source: 'local' },
      { stepId: 'classify-domain' }
    ),
    makeEvent(
      'tool.call.completed',
      {
        toolId: 'tool.legal-domain-classifier',
        source: 'local',
        output: { status: 'classified', domain: result.legalDomain }
      },
      { stepId: 'classify-domain' }
    )
  );
  const output = {
    status: result.status,
    taskType: result.taskType,
    legalDomain: result.legalDomain,
    piiRedacted: result.piiRedacted,
    clarificationRound: result.clarificationRound,
    questionCount: result.questions.length,
    legalConclusionGenerated: false,
    businessTraceTypes: result.trace.map((entry) => entry.type)
  };
  events.push(makeEvent('run.completed', { output }));
  assertSafeFixtureValue(events);
  return events;
}

async function createV1ScenarioEvents(projectRoot) {
  const temporaryDirectory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'lexpilot-replay-v1-')
  );
  const artifactRepository = createExecutionArtifactRepository({
    rootPath: path.join(temporaryDirectory, 'artifacts'),
    projectRoot
  });
  const executionLog = createDemoExecutionLog({
    filePath: path.join(temporaryDirectory, 'execution-log.jsonl')
  });
  try {
    const service = new LegalSelfCheckConversationService({
      store: new InMemoryLegalSessionStore(),
      ownerId: 'fixture-owner',
      idFactory: () => 'fixture-v1-session',
      clock: () => FIXED_NOW,
      autoCleanup: false,
      v1Runtime: createV1DemoQueryRuntime(),
      executionLog,
      artifactRepository
    });
    const planned = service.start({
      userText:
        '\u7edf\u8ba1\u8fd1\u4e09\u5e74\u6848\u4f8b\u5e93\u4e2d\u672a\u7b7e\u52b3\u52a8\u5408\u540c\u6848\u4ef6\u7684\u80dc\u8bc9\u7387\u548c\u8d54\u507f\u4e2d\u4f4d\u6570\u3002',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const completed = await service.confirmV1Execution(planned.sessionId, { confirmed: true });
    const core = loadHyphaCore(projectRoot);
    const runId = 'run-fixture-professional-query-v1';
    const makeEvent = eventFactory(core, runId);
    const events = [makeEvent('run.started', { scenarioId: 'professional-query-v1' })];
    addStateEvents(events, makeEvent, [
      'Intake',
      'PrivacyConsent',
      'RedactInput',
      'ClassifyTask',
      'PlanQuery',
      'AwaitingConfirmation',
      'ExecuteSelect',
      'BuildArtifact',
      'AppendLog',
      'Completed'
    ]);
    events.push(
      makeEvent(
        'tool.policy.checked',
        { toolId: 'tool.v1-readonly-query', decision: 'allow' },
        { stepId: 'query-policy' }
      ),
      makeEvent('human.review.requested', { operation: 'execute-select' }),
      makeEvent('human.review.approved', { operation: 'execute-select' }),
      makeEvent(
        'tool.call.started',
        { toolId: 'tool.v1-readonly-query', source: 'local' },
        { stepId: 'execute-select' }
      ),
      makeEvent(
        'tool.call.completed',
        {
          toolId: 'tool.v1-readonly-query',
          source: 'local',
          output: {
            status: completed.status,
            rowCount: completed.v1.result.rowCount,
            matchedCaseCount: completed.v1.result.matchedCaseCount
          }
        },
        { stepId: 'execute-select' }
      ),
      makeEvent('artifact.created', {
        storeId: completed.v1.artifact.storage.storeId,
        contentSha256: completed.v1.artifact.contentSha256
      })
    );
    const output = {
      status: completed.status,
      taskType: planned.taskType,
      piiRedacted: completed.piiRedacted,
      readOnly: completed.v1.plan.readOnly,
      schemaVerified: completed.v1.plan.schemaVerified,
      confirmationRequired: completed.v1.plan.requiresConfirmation,
      rowCount: completed.v1.result.rowCount,
      matchedCaseCount: completed.v1.result.matchedCaseCount,
      artifactStoreId: completed.v1.artifact.storage.storeId,
      artifactSha256: completed.v1.artifact.contentSha256,
      auditLogStatus: service.getV1ExecutionLogIntegrity().status,
      businessTraceTypes: completed.trace.map((entry) => entry.type)
    };
    events.push(makeEvent('run.completed', { output }));
    assertSafeFixtureValue(events);
    return events;
  } finally {
    await artifactRepository.close();
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createCurrentScenarioEvents(projectRoot, fixtureId) {
  if (fixtureId === 'fixture.legal-self-check.v0') {
    return createV0ScenarioEvents(projectRoot);
  }
  if (fixtureId === 'fixture.professional-query.v1') {
    return createV1ScenarioEvents(projectRoot);
  }
  throw new ReplayFixtureValidationError(
    'REPLAY_SCENARIO_UNKNOWN',
    `No governed replay scenario is registered for fixture: ${fixtureId}`
  );
}

async function runLegalReplayRegression(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const { fixtures, manifest } = await readVerifiedFixtureSet({
    projectRoot,
    directory: options.directory
  });
  const domain = loadHyphaDomain(projectRoot);
  const domainPack = await domain.loadDomainPackFile(
    path.join(projectRoot, 'configs', 'domain-packs', 'legal-compliance.domain.json')
  );
  const spec = domainPack.regressionCases?.find((item) => item.id === REGRESSION_SPEC_ID);
  if (!spec) {
    throw new ReplayFixtureValidationError(
      'REPLAY_REGRESSION_SPEC_MISSING',
      `DomainPack regression spec is missing: ${REGRESSION_SPEC_ID}`
    );
  }
  const testing = loadHyphaTesting(projectRoot);
  const actualEventsByFixtureId = new Map();
  const traceEvaluator = new testing.TraceCompletenessEvaluator({ now: () => FIXED_NOW });
  for (const fixture of fixtures) {
    const actualEvents = await createCurrentScenarioEvents(projectRoot, fixture.id);
    const traceResult = traceEvaluator.evaluate({
      runId: fixture.runId,
      events: actualEvents,
      requiredEventTypes: ['run.started', 'tool.policy.checked', 'run.completed']
    });
    if (traceResult.status !== 'passed') {
      throw new ReplayFixtureValidationError(
        'REPLAY_TRACE_INCOMPLETE',
        `Current replay trace is incomplete: ${fixture.id}`
      );
    }
    actualEventsByFixtureId.set(fixture.id, actualEvents);
  }
  const result = new testing.RegressionRunner({ now: () => FIXED_NOW }).runSpec({
    spec,
    fixtures,
    actualEventsByFixtureId
  });
  return {
    manifestId: manifest.id,
    fixtureCount: fixtures.length,
    traceCompletenessStatus: 'passed',
    result
  };
}

async function restoreVerifiedReplayFixtures(options = {}) {
  if (typeof options.targetDirectory !== 'string' || options.targetDirectory.length === 0) {
    throw new TypeError('targetDirectory must be a non-empty string.');
  }
  const source = await readVerifiedFixtureSet(options);
  const targetDirectory = path.resolve(options.targetDirectory);
  if (targetDirectory === source.directory) {
    throw new ReplayFixtureValidationError(
      'REPLAY_RECOVERY_TARGET_INVALID',
      'Replay recovery target must differ from the verified source directory.'
    );
  }
  await fsPromises.mkdir(targetDirectory, { recursive: true });
  for (const entry of source.manifest.fixtures) {
    const content = await fsPromises.readFile(path.join(source.directory, entry.file), 'utf8');
    const temporaryPath = path.join(targetDirectory, `.${entry.file}.restore`);
    await fsPromises.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'w' });
    await fsPromises.rename(temporaryPath, path.join(targetDirectory, entry.file));
  }
  await fsPromises.copyFile(
    path.join(source.directory, MANIFEST_FILE),
    path.join(targetDirectory, MANIFEST_FILE)
  );
  const restored = await readVerifiedFixtureSet({
    projectRoot: options.projectRoot,
    directory: targetDirectory
  });
  return {
    manifestId: restored.manifest.id,
    restoredCount: restored.fixtures.length,
    targetDirectory
  };
}

module.exports = {
  MANIFEST_ID,
  REGRESSION_SPEC_ID,
  ReplayFixtureValidationError,
  assertSafeFixtureValue,
  createCurrentScenarioEvents,
  readVerifiedFixtureSet,
  restoreVerifiedReplayFixtures,
  runLegalReplayRegression,
  sha256
};
