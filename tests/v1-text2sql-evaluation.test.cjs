const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { planConstrainedText2Sql } = require('../src/v1/constrained-text2sql-planner.cjs');
const {
  MANIFEST_SCHEMA,
  assertManifest,
  runText2SqlEvaluation
} = require('../src/v1/text2sql-evaluation.cjs');

const manifestPath = path.join(
  __dirname,
  '..',
  'configs',
  'evaluations',
  'legal-v1-text2sql.json'
);

function loadManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('versioned synthetic corpus meets the accuracy, rejection, and latency gates', () => {
  const manifest = loadManifest();
  const result = runText2SqlEvaluation(manifest, { planner: planConstrainedText2Sql });

  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.cases.filter((item) => item.category === 'supported').length, 12);
  assert.equal(manifest.cases.filter((item) => item.category === 'rejected').length, 8);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.supportedPlanAccuracy, 1);
  assert.equal(result.metrics.rejectionAccuracy, 1);
  assert.deepEqual(result.metrics.supportedCases, { passed: 12, total: 12 });
  assert.deepEqual(result.metrics.rejectedCases, { passed: 8, total: 8 });
  assert.equal(result.metrics.performanceSamples, 200);
  assert.equal(result.metrics.maxGenerationDurationMs < 2000, true);
  assert.deepEqual(result.failures, []);
});

test('supported-plan accuracy fails below 90 percent without counting rejections as successes', () => {
  const manifest = loadManifest();
  const brokenIds = new Set([
    'supported-compensation-year-range',
    'supported-compensation-single-year'
  ]);
  const planner = (input, options) => {
    const result = planConstrainedText2Sql(input, options);
    const item = manifest.cases.find((candidate) => candidate.redactedText === input.redactedText);
    if (!brokenIds.has(item?.id) || !result.ok) return result;
    return { ...result, templateId: 'tampered-template' };
  };

  const result = runText2SqlEvaluation(manifest, { planner });

  assert.equal(result.ok, false);
  assert.equal(result.metrics.supportedPlanAccuracy, 10 / 12);
  assert.equal(result.metrics.rejectionAccuracy, 1);
  assert.deepEqual(result.thresholdFailures, ['supportedPlanAccuracy']);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures.every((failure) => failure.category === 'supported'), true);
});

test('a rejected case mismatch fails the independent 100 percent safety gate', () => {
  const manifest = loadManifest();
  const planner = (input, options) => {
    const result = planConstrainedText2Sql(input, options);
    if (input.redactedText.startsWith('删除全部案例')) {
      return { ok: false, code: 'QUERY_TEMPLATE_NOT_SUPPORTED' };
    }
    return result;
  };

  const result = runText2SqlEvaluation(manifest, { planner });

  assert.equal(result.ok, false);
  assert.equal(result.metrics.supportedPlanAccuracy, 1);
  assert.equal(result.metrics.rejectionAccuracy, 7 / 8);
  assert.deepEqual(result.thresholdFailures, ['rejectionAccuracy']);
});

test('any generation reaching two seconds fails the hard latency gate', () => {
  const manifest = loadManifest();
  let sample = 0;
  const result = runText2SqlEvaluation(manifest, {
    planner: planConstrainedText2Sql,
    measure(operation) {
      sample += 1;
      return { value: operation(), durationMs: sample === 5 ? 2000 : 0.1 };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.metrics.maxGenerationDurationMs, 2000);
  assert.deepEqual(result.thresholdFailures, ['maxGenerationDurationMs']);
});

test('manifest validation refuses weakened thresholds and duplicate cases', () => {
  const manifest = loadManifest();
  assert.throws(
    () => assertManifest({ ...manifest, thresholds: { ...manifest.thresholds, supportedPlanAccuracy: 0.89 } }),
    /acceptance limits/
  );
  assert.throws(
    () => assertManifest({ ...manifest, cases: [...manifest.cases, manifest.cases[0]] }),
    /unique id/
  );
});
