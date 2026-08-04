const { performance } = require('node:perf_hooks');

const MANIFEST_SCHEMA = 'legal-v1-text2sql-evaluation@1.0.0';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schema !== MANIFEST_SCHEMA) {
    throw new TypeError(`evaluation manifest must use ${MANIFEST_SCHEMA}`);
  }
  if (!isPlainObject(manifest.thresholds)) {
    throw new TypeError('evaluation manifest thresholds are required');
  }
  const { supportedPlanAccuracy, rejectionAccuracy, maxGenerationDurationMs, performanceIterations } =
    manifest.thresholds;
  if (
    typeof supportedPlanAccuracy !== 'number' ||
    supportedPlanAccuracy < 0.9 ||
    supportedPlanAccuracy > 1 ||
    rejectionAccuracy !== 1 ||
    !Number.isFinite(maxGenerationDurationMs) ||
    maxGenerationDurationMs <= 0 ||
    maxGenerationDurationMs > 2000 ||
    !Number.isInteger(performanceIterations) ||
    performanceIterations < 1
  ) {
    throw new TypeError('evaluation thresholds must preserve the V1 acceptance limits');
  }
  if (!isPlainObject(manifest.schemas) || !isPlainObject(manifest.expectedPlans)) {
    throw new TypeError('evaluation schemas and expected plans are required');
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new TypeError('evaluation cases are required');
  }
  const ids = new Set();
  for (const item of manifest.cases) {
    if (
      !isPlainObject(item) ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      ids.has(item.id) ||
      !['supported', 'rejected'].includes(item.category) ||
      typeof item.redactedText !== 'string' ||
      item.redactedText.trim().length === 0 ||
      !isPlainObject(item.expected)
    ) {
      throw new TypeError('each evaluation case must have a unique id and a valid contract');
    }
    ids.add(item.id);
    if (!Object.hasOwn(manifest.schemas, item.schemaProfile)) {
      throw new TypeError(`evaluation case ${item.id} references an unknown Schema profile`);
    }
    if (item.category === 'supported') {
      if (
        typeof item.expected.planProfile !== 'string' ||
        !Object.hasOwn(manifest.expectedPlans, item.expected.planProfile) ||
        !isPlainObject(item.expected.parameters)
      ) {
        throw new TypeError(`supported evaluation case ${item.id} has an invalid expectation`);
      }
    } else if (typeof item.expected.code !== 'string' || item.expected.code.length === 0) {
      throw new TypeError(`rejected evaluation case ${item.id} must declare an error code`);
    }
  }
  if (!manifest.cases.some((item) => item.category === 'supported')) {
    throw new TypeError('evaluation manifest must include supported cases');
  }
  if (!manifest.cases.some((item) => item.category === 'rejected')) {
    throw new TypeError('evaluation manifest must include rejected cases');
  }
}

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareSupportedResult(result, item, plan) {
  const checks = [
    ['ok', result?.ok === true],
    ['templateId', result?.templateId === plan.templateId],
    ['sql', result?.sql === plan.sql],
    ['parameters', sameJson(result?.parameters, item.expected.parameters)],
    ['selectedColumns', sameJson(result?.semanticQuery?.selectedColumns, plan.selectedColumns)],
    ['metrics', sameJson(result?.semanticQuery?.metrics, plan.metrics)],
    ['aggregations', sameJson(result?.semanticQuery?.aggregations, plan.aggregations)],
    ['resultColumns', sameJson(result?.expectedOutput?.columns, plan.resultColumns)],
    ['artifacts', sameJson(result?.expectedOutput?.artifacts, plan.artifacts)]
  ];
  return checks.filter(([, passed]) => !passed).map(([name]) => name);
}

function compareRejectedResult(result, item) {
  const failures = [];
  if (result?.ok !== false) failures.push('ok');
  if (result?.code !== item.expected.code) failures.push('code');
  return failures;
}

function defaultMeasure(operation) {
  const start = performance.now();
  const value = operation();
  return { value, durationMs: performance.now() - start };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function roundDuration(value) {
  return Number(value.toFixed(3));
}

function runText2SqlEvaluation(manifest, dependencies = {}) {
  assertManifest(manifest);
  if (typeof dependencies.planner !== 'function') {
    throw new TypeError('planner dependency is required');
  }
  const measure = dependencies.measure ?? defaultMeasure;
  if (typeof measure !== 'function') {
    throw new TypeError('measure dependency must be a function');
  }

  const failures = [];
  const accuracyCounts = {
    supported: { passed: 0, total: 0 },
    rejected: { passed: 0, total: 0 }
  };
  const durations = [];

  for (const item of manifest.cases) {
    const input = {
      piiRedacted: item.piiRedacted !== false,
      redactedText: item.redactedText,
      schema: manifest.schemas[item.schemaProfile]
    };
    const measured = measure(() => dependencies.planner(input, item.options ?? {}), item.id);
    if (!isPlainObject(measured) || !Number.isFinite(measured.durationMs) || measured.durationMs < 0) {
      throw new TypeError('measure must return a non-negative durationMs and a value');
    }
    durations.push(measured.durationMs);
    const failedFields =
      item.category === 'supported'
        ? compareSupportedResult(
            measured.value,
            item,
            manifest.expectedPlans[item.expected.planProfile]
          )
        : compareRejectedResult(measured.value, item);
    accuracyCounts[item.category].total += 1;
    if (failedFields.length === 0) {
      accuracyCounts[item.category].passed += 1;
    } else {
      failures.push({ caseId: item.id, category: item.category, failedFields });
    }
  }

  for (let iteration = 1; iteration < manifest.thresholds.performanceIterations; iteration += 1) {
    for (const item of manifest.cases) {
      const measured = measure(
        () =>
          dependencies.planner(
            {
              piiRedacted: item.piiRedacted !== false,
              redactedText: item.redactedText,
              schema: manifest.schemas[item.schemaProfile]
            },
            item.options ?? {}
          ),
        item.id
      );
      if (!isPlainObject(measured) || !Number.isFinite(measured.durationMs) || measured.durationMs < 0) {
        throw new TypeError('measure must return a non-negative durationMs and a value');
      }
      durations.push(measured.durationMs);
    }
  }

  const supportedAccuracy =
    accuracyCounts.supported.passed / accuracyCounts.supported.total;
  const rejectionAccuracy = accuracyCounts.rejected.passed / accuracyCounts.rejected.total;
  const maxDurationMs = Math.max(...durations);
  const p95DurationMs = percentile(durations, 0.95);
  const thresholds = manifest.thresholds;
  const thresholdFailures = [];
  if (supportedAccuracy < thresholds.supportedPlanAccuracy) {
    thresholdFailures.push('supportedPlanAccuracy');
  }
  if (rejectionAccuracy < thresholds.rejectionAccuracy) {
    thresholdFailures.push('rejectionAccuracy');
  }
  if (maxDurationMs >= thresholds.maxGenerationDurationMs) {
    thresholdFailures.push('maxGenerationDurationMs');
  }

  return Object.freeze({
    ok: thresholdFailures.length === 0,
    manifest: manifest.schema,
    corpusVersion: manifest.corpusVersion,
    metrics: Object.freeze({
      supportedPlanAccuracy: supportedAccuracy,
      rejectionAccuracy,
      supportedCases: Object.freeze({ ...accuracyCounts.supported }),
      rejectedCases: Object.freeze({ ...accuracyCounts.rejected }),
      performanceSamples: durations.length,
      maxGenerationDurationMs: roundDuration(maxDurationMs),
      p95GenerationDurationMs: roundDuration(p95DurationMs)
    }),
    thresholds: Object.freeze({ ...thresholds }),
    thresholdFailures: Object.freeze(thresholdFailures),
    failures: Object.freeze(failures)
  });
}

module.exports = {
  MANIFEST_SCHEMA,
  assertManifest,
  runText2SqlEvaluation
};
