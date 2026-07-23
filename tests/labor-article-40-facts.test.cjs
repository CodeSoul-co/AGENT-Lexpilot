const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ARTICLE_ID,
  LABOR_ARTICLE_40_GROUNDS,
  assessLaborArticle40Facts
} = require('../src/v0/labor-article-40-facts.cjs');

function assess(knownFacts) {
  return assessLaborArticle40Facts({ piiRedacted: true, knownFacts });
}

test('requires the branch-specific facts for all three Article 40 grounds', () => {
  const cases = [
    {
      issueType: 'dismissal',
      dismissalGround: LABOR_ARTICLE_40_GROUNDS.MEDICAL_OR_NON_WORK_INJURY,
      noticeOrPayStatus: 'written_notice_30_days',
      medicalPeriodStatus: 'ended',
      workArrangementOutcome: 'cannot_original_or_alternative'
    },
    {
      issueType: 'dismissal',
      dismissalGround: LABOR_ARTICLE_40_GROUNDS.PERFORMANCE,
      noticeOrPayStatus: 'extra_month_salary',
      performanceRemediationOutcome: 'training_or_adjustment_still_unqualified'
    },
    {
      issueType: 'dismissal',
      dismissalGround: LABOR_ARTICLE_40_GROUNDS.OBJECTIVE_CHANGE,
      noticeOrPayStatus: 'neither',
      objectiveChangeImpact: 'contract_cannot_continue',
      contractChangeNegotiationOutcome: 'discussed_no_agreement'
    }
  ];

  for (const knownFacts of cases) {
    const result = assess(knownFacts);
    assert.equal(result.articleId, ARTICLE_ID);
    assert.equal(result.status, 'ready_for_candidate_comparison');
    assert.equal(result.comparisonAllowed, true);
    assert.deepEqual(result.missingFields, []);
    assert.equal(result.legalConclusionGenerated, false);
  }
});

test('treats explicit adverse facts as comparable without calling them lawful or unlawful', () => {
  const result = assess({
    issueType: 'dismissal',
    dismissalGround: LABOR_ARTICLE_40_GROUNDS.PERFORMANCE,
    noticeOrPayStatus: 'neither',
    performanceRemediationOutcome: 'no_training_or_adjustment'
  });

  assert.equal(result.status, 'ready_for_candidate_comparison');
  assert.equal(result.comparisonAllowed, true);
  assert.equal(result.legalConclusionGenerated, false);
  assert.equal(JSON.stringify(result).includes('illegal'), false);
});

test('reports only the missing facts for the selected ground', () => {
  const result = assess({
    issueType: 'dismissal',
    dismissalGround: LABOR_ARTICLE_40_GROUNDS.MEDICAL_OR_NON_WORK_INJURY,
    noticeOrPayStatus: 'unknown',
    medicalPeriodStatus: 'ended'
  });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.comparisonAllowed, false);
  assert.deepEqual(result.missingFields, ['noticeOrPayStatus', 'workArrangementOutcome']);
  assert.equal(result.requiredFields.includes('performanceRemediationOutcome'), false);
  assert.equal(result.requiredFields.includes('contractChangeNegotiationOutcome'), false);
});

test('does not use Article 40 for a different or unsupported dismissal ground', () => {
  const differentIssue = assess({ issueType: 'unpaid_wages' });
  const otherGround = assess({
    issueType: 'dismissal',
    dismissalGround: LABOR_ARTICLE_40_GROUNDS.OTHER,
    noticeOrPayStatus: 'neither'
  });

  assert.equal(differentIssue.status, 'not_applicable');
  assert.equal(differentIssue.comparisonAllowed, false);
  assert.equal(otherGround.status, 'not_supported_by_declared_ground');
  assert.equal(otherGround.comparisonAllowed, false);
  assert.deepEqual(otherGround.requiredFields, ['issueType', 'dismissalGround']);
});

test('clarifies a missing issue type instead of declaring Article 40 inapplicable', () => {
  const result = assess({});

  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.requiredFields, ['issueType']);
  assert.deepEqual(result.missingFields, ['issueType']);
});

test('asks for the dismissal ground before selecting conditional fields', () => {
  const result = assess({ issueType: 'dismissal', noticeOrPayStatus: 'neither' });

  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missingFields, ['dismissalGround']);
  assert.deepEqual(result.requiredFields, ['issueType', 'dismissalGround', 'noticeOrPayStatus']);
});

test('fails closed for unsanitized envelopes, raw text, and invalid controlled values', () => {
  assert.throws(
    () => assessLaborArticle40Facts({ piiRedacted: false, knownFacts: {} }),
    /sanitized structured facts/
  );
  assert.throws(
    () =>
      assessLaborArticle40Facts({
        piiRedacted: true,
        knownFacts: {},
        rawText: '老板辞退我'
      }),
    /undeclared fields/
  );
  assert.throws(
    () => assess({ issueType: 'dismissal', dismissalGround: 'guessed_ground' }),
    /fact value is invalid: dismissalGround/
  );
  assert.throws(
    () => assess({ issueType: 'guessed_issue' }),
    /fact value is invalid: issueType/
  );
});
