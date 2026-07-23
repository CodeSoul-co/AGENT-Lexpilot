const assert = require('node:assert/strict');
const test = require('node:test');
const { DEMO_CASES, createV1DemoQueryRuntime } = require('../src/v1/demo-query-runtime.cjs');

function input(redactedText) {
  return {
    runId: 'run-v1-demo',
    sessionId: 'session-v1-demo',
    ownerId: 'test-owner',
    piiRedacted: true,
    redactedText,
    clarificationRound: 0,
    knownFacts: {}
  };
}

test('V1 demo produces a verified read-only plan, table, chart, and artifact', async () => {
  const runtime = createV1DemoQueryRuntime();
  const result = await runtime.run(input('统计近三年案例库未签劳动合同的胜诉率和赔偿中位数。'));

  assert.equal(result.status, 'completed');
  assert.equal(result.plan.readOnly, true);
  assert.equal(result.plan.schemaVerified, true);
  assert.match(result.plan.sql, /^SELECT/);
  assert.equal(result.result.rows.length, 3);
  assert.equal(DEMO_CASES.length, 720);
  assert.equal(result.result.sourceCaseCount, 720);
  assert.equal(result.result.matchedCaseCount, 672);
  assert.equal(result.result.resultGroupCount, 3);
  assert.deepEqual(
    result.result.rows.map((row) => row.case_count),
    [168, 224, 280]
  );
  assert.equal(result.chart.labels.length, 3);
  assert.equal(result.artifact.type, 'analysis-document');
  assert.match(result.artifact.content, /720 条匿名合成演示案例/);
  assert.match(result.artifact.content, /本次查询匹配：672 条/);
  assert.equal(result.sqlExecutionProvider, 'not_available_in_current_hypha');
  assert.equal(result.safety.writeAttempted, false);
  assert.equal(JSON.stringify(result.trace).includes('统计近三年'), false);
});

test('V1 demo refuses write operations without attempting execution', async () => {
  const runtime = createV1DemoQueryRuntime();
  const result = await runtime.run(input('删除案例库中的全部数据'));

  assert.equal(result.status, 'rejected');
  assert.equal(result.executionAttempted, false);
  assert.equal(result.safety.writeAttempted, true);
  assert.equal(result.safety.confirmationRequired, true);
});
