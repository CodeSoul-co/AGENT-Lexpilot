const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStructuredInput, splitAnswerSegments } = require('../src/agent/structured-input-parser.cjs');
const { buildQuestionContracts } = require('../src/agent/question-contracts.cjs');
const { resolveFactUpdates } = require('../src/agent/confidence-conflict-resolver.cjs');
const { TaskRouter } = require('../src/agent/task-router.cjs');
const { parseProfessionalAnalysisIntent } = require('../src/v1/analysis-intent-parser.cjs');

const contracts = buildQuestionContracts(
  [{ field: 'noticeOrPayStatus' }, { field: 'medicalPeriodStatus' }],
  ['通知或补偿情况？', '医疗期是否结束？']
);

for (const [label, text] of [
  ['Chinese semicolon', '均未提供；尚未结束'],
  ['ASCII semicolon', '均未提供;尚未结束'],
  ['comma', '均未提供，尚未结束'],
  ['newline', '均未提供\n尚未结束']
]) {
  test(`maps two bounded free-text answers in order: ${label}`, () => {
    const parsed = parseStructuredInput({ userText: text }, contracts);
    assert.deepEqual(parsed.facts, {
      noticeOrPayStatus: 'neither',
      medicalPeriodStatus: 'not_ended'
    });
    assert.equal(parsed.answers.every((answer) => answer.confidence >= 0.9), true);
    assert.deepEqual(parsed.unresolvedFields, []);
  });
}

test('keeps an unrecognized field unresolved instead of guessing', () => {
  const parsed = parseStructuredInput({ userText: '均未提供；不太清楚' }, contracts);
  assert.deepEqual(parsed.facts, { noticeOrPayStatus: 'neither' });
  assert.deepEqual(parsed.unresolvedFields, ['medicalPeriodStatus']);
});

test('accepts the documented structured aliases and rejects mismatched questions', () => {
  const parsed = parseStructuredInput({
    answers: [
      { questionId: 'notice-or-payment', field: 'noticeOrPayment', value: 'neither_provided' },
      { questionId: 'medical-period', field: 'medicalPeriodStatus', value: 'not_ended' }
    ]
  }, contracts);
  assert.deepEqual(parsed.facts, {
    noticeOrPayStatus: 'neither',
    medicalPeriodStatus: 'not_ended'
  });
  assert.throws(
    () => parseStructuredInput({
      answers: [{ questionId: 'medical-period', field: 'noticeOrPayment', value: 'neither_provided' }]
    }, contracts),
    /pending question/
  );
});

test('latest explicit correction outranks confirmed history and records the change', () => {
  const result = resolveFactUpdates({
    knownFacts: { medicalPeriodStatus: 'ended' },
    factSources: { medicalPeriodStatus: { source: 'explicit_text' } },
    answers: [{
      field: 'medicalPeriodStatus',
      value: 'not_ended',
      source: 'explicit_text',
      correction: true,
      confidence: 0.96,
      evidenceSpan: '更正为尚未结束'
    }],
    changedAt: '2026-08-08T00:00:00.000Z'
  });
  assert.equal(result.knownFacts.medicalPeriodStatus, 'not_ended');
  assert.equal(result.changes.length, 1);
  assert.equal(result.factSources.medicalPeriodStatus.source, 'user_correction');
});

test('task router requires confirmation before a strong branch switch', () => {
  const router = new TaskRouter();
  const routed = router.route({
    piiRedacted: true,
    redactedText: '统计近三年案例库的胜诉率和案件数量。'
  }, { activeTaskType: 'legal_self_check' });
  assert.equal(routed.taskType, 'professional_data_query');
  assert.equal(routed.routingStatus, 'task_switch_confirmation_required');
  assert.equal(routed.taskSwitch.confirmationRequired, true);
});

test('professional analysis parser asks only for missing execution conditions', () => {
  const missingBoth = parseProfessionalAnalysisIntent('请分析案例库中的未签劳动合同案件。');
  assert.deepEqual(missingBoth.missingFields, ['analysisMetrics', 'analysisTimeRange']);
  const missingTime = parseProfessionalAnalysisIntent('请统计案例库未签劳动合同案件的胜诉率。');
  assert.deepEqual(missingTime.missingFields, ['analysisTimeRange']);
  const ready = parseProfessionalAnalysisIntent('统计近三年案例库未签劳动合同案件的胜诉率和案件数量。');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.metrics, ['案件数量', '胜诉率']);
});

test('segment splitter supports punctuation without retaining empty answers', () => {
  assert.deepEqual(splitAnswerSegments('均未提供；\n尚未结束，，'), ['均未提供', '尚未结束']);
});
