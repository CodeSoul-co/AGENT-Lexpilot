const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaTesting } = require('../scripts/hypha-paths.cjs');
const {
  ReplayFixtureValidationError,
  assertSafeFixtureValue,
  createCurrentScenarioEvents,
  readVerifiedFixtureSet,
  restoreVerifiedReplayFixtures,
  runLegalReplayRegression
} = require('../src/replay/legal-replay-regression.cjs');

const projectRoot = path.resolve(__dirname, '..');
const fixtureDirectory = path.join(projectRoot, 'configs', 'replay-fixtures');

test('loads and replays the two integrity-pinned V0/V1 fixtures', async () => {
  const verified = await readVerifiedFixtureSet({ projectRoot });
  assert.equal(verified.manifest.id, 'replay.legal-compliance.v0-v1');
  assert.deepEqual(
    verified.fixtures.map((fixture) => fixture.id),
    ['fixture.legal-self-check.v0', 'fixture.professional-query.v1']
  );

  const regression = await runLegalReplayRegression({ projectRoot });
  assert.equal(regression.result.status, 'passed');
  assert.equal(regression.traceCompletenessStatus, 'passed');
  assert.deepEqual(regression.result.summary, { total: 2, passed: 2, failed: 0 });
});

test('rejects PII, secret-like values, and raw-input fields in fixtures', () => {
  assert.throws(
    () =>
      assertSafeFixtureValue({
        note: `contact-${['138', '0013', '8000'].join('')}`
      }),
    (error) =>
      error instanceof ReplayFixtureValidationError &&
      error.code === 'REPLAY_FIXTURE_PII_DETECTED'
  );
  assert.throws(
    () => assertSafeFixtureValue({ credential: `sk-${'a'.repeat(24)}` }),
    (error) =>
      error instanceof ReplayFixtureValidationError &&
      error.code === 'REPLAY_FIXTURE_SECRET_DETECTED'
  );
  assert.throws(
    () => assertSafeFixtureValue({ userText: 'synthetic but forbidden' }),
    (error) =>
      error instanceof ReplayFixtureValidationError &&
      error.code === 'REPLAY_FIXTURE_FORBIDDEN_FIELD'
  );
});

test('fails closed when a fixture is missing or its bytes are altered', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-replay-tamper-'));
  try {
    for (const fileName of fs.readdirSync(fixtureDirectory)) {
      fs.copyFileSync(path.join(fixtureDirectory, fileName), path.join(directory, fileName));
    }
    const target = path.join(directory, 'fixture.legal-self-check.v0.replay.json');
    fs.appendFileSync(target, '\n', 'utf8');
    await assert.rejects(
      readVerifiedFixtureSet({ projectRoot, directory }),
      (error) =>
        error instanceof ReplayFixtureValidationError &&
        error.code === 'REPLAY_FIXTURE_HASH_MISMATCH'
    );
    fs.rmSync(target, { force: true });
    await assert.rejects(readVerifiedFixtureSet({ projectRoot, directory }), /ENOENT/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restores declared fixtures and detects current-runtime output drift', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-replay-restore-'));
  try {
    fs.writeFileSync(
      path.join(directory, 'fixture.legal-self-check.v0.replay.json'),
      '{"corrupted":true}\n',
      'utf8'
    );
    fs.writeFileSync(path.join(directory, 'undeclared-private-file.txt'), 'preserve', 'utf8');
    const restored = await restoreVerifiedReplayFixtures({
      projectRoot,
      targetDirectory: directory
    });
    assert.equal(restored.restoredCount, 2);
    assert.equal((await readVerifiedFixtureSet({ projectRoot, directory })).fixtures.length, 2);
    assert.equal(
      fs.readFileSync(path.join(directory, 'undeclared-private-file.txt'), 'utf8'),
      'preserve'
    );

    const { fixtures } = await readVerifiedFixtureSet({ projectRoot });
    const fixture = fixtures.find((item) => item.id === 'fixture.legal-self-check.v0');
    const actualEvents = await createCurrentScenarioEvents(projectRoot, fixture.id);
    const changedEvents = actualEvents.map((event) =>
      event.type === 'run.completed'
        ? {
            ...event,
            payload: {
              output: { ...event.payload.output, questionCount: 99 }
            }
          }
        : event
    );
    const testing = loadHyphaTesting(projectRoot);
    const result = new testing.RegressionRunner().runCase({
      id: 'regression.detect-output-drift',
      fixture,
      actualEvents: changedEvents,
      requiredChecks: ['event_types', 'state_path', 'output_contract']
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.traceDiff.output.passed, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
