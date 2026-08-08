const ARTICLE_ID = 'cn.labor-contract-law.article-40';

const LABOR_ARTICLE_40_GROUNDS = Object.freeze({
  MEDICAL_OR_NON_WORK_INJURY: 'medical_or_non_work_injury',
  PERFORMANCE: 'performance',
  OBJECTIVE_CHANGE: 'objective_change',
  OTHER: 'other'
});

const LABOR_ARTICLE_40_ALLOWED_VALUES = Object.freeze({
  issueType: Object.freeze(['dismissal', 'unpaid_wages', 'social_insurance', 'overtime']),
  dismissalGround: Object.freeze([...Object.values(LABOR_ARTICLE_40_GROUNDS), 'unknown']),
  noticeOrPayStatus: Object.freeze([
    'written_notice_30_days',
    'extra_month_salary',
    'neither',
    'unknown'
  ]),
  medicalPeriodStatus: Object.freeze(['ended', 'not_ended', 'unknown']),
  workArrangementOutcome: Object.freeze([
    'cannot_original_or_alternative',
    'can_original_or_alternative',
    'unknown'
  ]),
  performanceRemediationOutcome: Object.freeze([
    'training_or_adjustment_still_unqualified',
    'no_training_or_adjustment',
    'became_qualified',
    'unknown'
  ]),
  objectiveChangeImpact: Object.freeze([
    'contract_cannot_continue',
    'contract_can_continue',
    'unknown'
  ]),
  contractChangeNegotiationOutcome: Object.freeze([
    'discussed_no_agreement',
    'not_discussed',
    'agreement_reached',
    'unknown'
  ])
});

const COMMON_FIELDS = Object.freeze(['dismissalGround', 'noticeOrPayStatus']);
const CONDITIONAL_FIELDS = Object.freeze({
  [LABOR_ARTICLE_40_GROUNDS.MEDICAL_OR_NON_WORK_INJURY]: Object.freeze([
    'medicalPeriodStatus',
    'workArrangementOutcome'
  ]),
  [LABOR_ARTICLE_40_GROUNDS.PERFORMANCE]: Object.freeze([
    'performanceRemediationOutcome'
  ]),
  [LABOR_ARTICLE_40_GROUNDS.OBJECTIVE_CHANGE]: Object.freeze([
    'objectiveChangeImpact',
    'contractChangeNegotiationOutcome'
  ])
});

function validateInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.piiRedacted !== true ||
    !input.knownFacts ||
    typeof input.knownFacts !== 'object' ||
    Array.isArray(input.knownFacts)
  ) {
    throw new TypeError('Article 40 fact assessment requires sanitized structured facts.');
  }
  const unknownInputFields = Object.keys(input).filter(
    (field) => !['piiRedacted', 'knownFacts'].includes(field)
  );
  if (unknownInputFields.length > 0) {
    throw new TypeError('Article 40 fact assessment input contains undeclared fields.');
  }
  for (const [field, allowedValues] of Object.entries(LABOR_ARTICLE_40_ALLOWED_VALUES)) {
    if (Object.hasOwn(input.knownFacts, field) && !allowedValues.includes(input.knownFacts[field])) {
      throw new TypeError(`Article 40 fact value is invalid: ${field}.`);
    }
  }
}

function assessLaborArticle40Facts(input) {
  validateInput(input);
  const { knownFacts } = input;

  if (!Object.hasOwn(knownFacts, 'issueType')) {
    return {
      articleId: ARTICLE_ID,
      status: 'needs_clarification',
      comparisonAllowed: false,
      requiredFields: ['issueType'],
      missingFields: ['issueType'],
      legalConclusionGenerated: false
    };
  }

  if (knownFacts.issueType !== 'dismissal') {
    return {
      articleId: ARTICLE_ID,
      status: 'not_applicable',
      comparisonAllowed: false,
      requiredFields: ['issueType'],
      missingFields: [],
      legalConclusionGenerated: false
    };
  }

  const ground = knownFacts.dismissalGround;
  if (ground === LABOR_ARTICLE_40_GROUNDS.OTHER) {
    return {
      articleId: ARTICLE_ID,
      status: 'not_supported_by_declared_ground',
      comparisonAllowed: false,
      requiredFields: ['issueType', 'dismissalGround'],
      missingFields: [],
      legalConclusionGenerated: false
    };
  }

  const conditionalFields = CONDITIONAL_FIELDS[ground] ?? [];
  const requiredFields = ['issueType', ...COMMON_FIELDS, ...conditionalFields];
  if (
    ground === LABOR_ARTICLE_40_GROUNDS.MEDICAL_OR_NON_WORK_INJURY &&
    knownFacts.medicalPeriodStatus === 'not_ended'
  ) {
    return {
      articleId: ARTICLE_ID,
      status: 'conditions_not_met',
      comparisonAllowed: false,
      requiredFields: ['issueType', ...COMMON_FIELDS, 'medicalPeriodStatus'],
      missingFields: [],
      legalConclusionGenerated: false
    };
  }
  const missingFields = requiredFields.filter(
    (field) => !Object.hasOwn(knownFacts, field) || knownFacts[field] === 'unknown'
  );
  const supportedGround = Object.hasOwn(CONDITIONAL_FIELDS, ground);
  if (!supportedGround && !missingFields.includes('dismissalGround')) {
    missingFields.unshift('dismissalGround');
  }
  const status = missingFields.length === 0
    ? 'ready_for_candidate_comparison'
    : 'needs_clarification';

  return {
    articleId: ARTICLE_ID,
    status,
    comparisonAllowed: status === 'ready_for_candidate_comparison',
    requiredFields,
    missingFields,
    legalConclusionGenerated: false
  };
}

module.exports = {
  ARTICLE_ID,
  LABOR_ARTICLE_40_ALLOWED_VALUES,
  LABOR_ARTICLE_40_GROUNDS,
  assessLaborArticle40Facts
};
