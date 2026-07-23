const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TASK_TYPES,
  classifyBusinessTask
} = require('../src/v0/task-type-classifier.cjs');

function classify(redactedText) {
  return classifyBusinessTask({ piiRedacted: true, redactedText });
}

test('routes an individual legal situation to V0 legal self-check', () => {
  const result = classify('我在公司工作3年，没有签劳动合同，今天被辞退。');

  assert.equal(result.status, 'classified');
  assert.equal(result.taskType, TASK_TYPES.LEGAL_SELF_CHECK);
  assert.equal(result.confidence, 'conservative_default');
});

test('routes a professional aggregate case query to V1', () => {
  const result = classify('统计近三年北京法院未签劳动合同案件的胜诉率和赔偿金额中位数。');

  assert.equal(result.taskType, TASK_TYPES.PROFESSIONAL_DATA_QUERY);
  assert.ok(result.matchedSignals.includes('analytic_metric'));
  assert.ok(result.matchedSignals.includes('time_window'));
});

test('routes explicit SQL and real Schema requests to V1', () => {
  assert.equal(
    classify('请基于真实 Schema 生成 SELECT 查询。').taskType,
    TASK_TYPES.PROFESSIONAL_DATA_QUERY
  );
});

test('does not treat a single everyday statistics word as a professional query', () => {
  assert.equal(
    classify('请帮我统计老板还欠我多少钱。').taskType,
    TASK_TYPES.LEGAL_SELF_CHECK
  );
});

test('rejects raw or undeclared classifier input', () => {
  assert.throws(
    () => classifyBusinessTask({ piiRedacted: false, redactedText: 'SELECT * FROM cases' }),
    /redacted/
  );
  assert.throws(
    () =>
      classifyBusinessTask({
        piiRedacted: true,
        redactedText: 'SELECT * FROM cases',
        rawText: '姓名：张三'
      }),
    /undeclared/
  );
});

test('task classification trace excludes text and PII', () => {
  const result = classify('[NAME_1]要查询数据库中的案件统计，手机号为[PHONE_1]。');
  const trace = JSON.stringify(result.trace);

  assert.equal(trace.includes('[NAME_1]'), false);
  assert.equal(trace.includes('[PHONE_1]'), false);
  assert.equal(trace.includes('数据库'), false);
});
