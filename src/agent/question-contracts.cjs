const QUESTION_DEFINITIONS = Object.freeze({
  employmentDuration: { questionId: 'employment-duration', options: [] },
  writtenContractStatus: {
    questionId: 'written-contract',
    options: [
      { value: 'signed', label: '已签订' },
      { value: 'not_signed', label: '未签订' }
    ]
  },
  issueType: {
    questionId: 'labor-issue-type',
    options: [
      { value: 'dismissal', label: '辞退' },
      { value: 'contract', label: '劳动合同' },
      { value: 'probation', label: '试用期' },
      { value: 'employee_termination', label: '主动离职' },
      { value: 'unpaid_wages', label: '拖欠工资' },
      { value: 'overtime', label: '加班' },
      { value: 'social_insurance', label: '社会保险' }
    ]
  },
  dismissalGround: {
    questionId: 'dismissal-ground',
    options: [
      { value: 'medical_or_non_work_injury', label: '患病或非因工受伤' },
      { value: 'performance', label: '不能胜任工作' },
      { value: 'objective_change', label: '客观情况发生重大变化' },
      { value: 'other', label: '其他原因' }
    ]
  },
  noticeOrPayStatus: {
    questionId: 'notice-or-payment',
    aliases: ['noticeOrPayment'],
    options: [
      { value: 'written_notice_30_days', label: '已提前三十天书面通知' },
      { value: 'extra_month_salary', label: '已额外支付一个月工资' },
      { value: 'neither', aliases: ['neither_provided'], label: '均未提供' }
    ]
  },
  medicalPeriodStatus: {
    questionId: 'medical-period',
    options: [
      { value: 'ended', label: '已经结束' },
      { value: 'not_ended', label: '尚未结束' }
    ]
  },
  workArrangementOutcome: {
    questionId: 'work-arrangement',
    options: [
      { value: 'cannot_original_or_alternative', label: '不能从事原工作或其他合适工作' },
      { value: 'can_original_or_alternative', label: '仍可从事原工作或其他合适工作' }
    ]
  },
  performanceRemediationOutcome: {
    questionId: 'performance-remediation',
    options: [
      { value: 'training_or_adjustment_still_unqualified', label: '培训或调岗后仍不能胜任' },
      { value: 'no_training_or_adjustment', label: '未进行培训或调岗' },
      { value: 'became_qualified', label: '已经能够胜任' }
    ]
  },
  objectiveChangeImpact: {
    questionId: 'objective-change-impact',
    options: [
      { value: 'contract_cannot_continue', label: '原工作安排无法继续' },
      { value: 'contract_can_continue', label: '原工作安排仍可继续' }
    ]
  },
  contractChangeNegotiationOutcome: {
    questionId: 'contract-change-negotiation',
    options: [
      { value: 'discussed_no_agreement', label: '协商后未达成一致' },
      { value: 'not_discussed', label: '尚未协商' },
      { value: 'agreement_reached', label: '已经达成一致' }
    ]
  },
  relationshipStatus: { questionId: 'relationship-status', options: [] },
  disputeType: { questionId: 'family-dispute-type', options: [] },
  evidenceStatus: { questionId: 'loan-evidence', options: [] },
  repaymentTermStatus: { questionId: 'repayment-term', options: [] },
  repaymentStatus: { questionId: 'repayment-status', options: [] },
  taxpayerType: { questionId: 'taxpayer-type', options: [] },
  taxIssueType: { questionId: 'tax-issue-type', options: [] },
  taxPeriod: { questionId: 'tax-period', options: [] },
  rightType: { questionId: 'ip-right-type', options: [] },
  allegedAct: { questionId: 'ip-alleged-act', options: [] },
  authorizationStatus: { questionId: 'ip-authorization', options: [] }
});

const FIELD_BY_ALIAS = Object.freeze(
  Object.fromEntries(
    Object.entries(QUESTION_DEFINITIONS).flatMap(([fieldName, definition]) => [
      [fieldName, fieldName],
      ...(definition.aliases ?? []).map((alias) => [alias, fieldName])
    ])
  )
);

function normalizeQuestionField(fieldName) {
  return typeof fieldName === 'string' ? FIELD_BY_ALIAS[fieldName] : undefined;
}

function normalizeQuestionValue(fieldName, value) {
  const normalizedField = normalizeQuestionField(fieldName);
  const definition = normalizedField ? QUESTION_DEFINITIONS[normalizedField] : undefined;
  if (!definition || typeof value !== 'string') return undefined;
  for (const option of definition.options) {
    if (option.value === value || option.aliases?.includes(value)) return option.value;
  }
  return definition.options.length === 0 && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function buildQuestionContracts(requirements, questions) {
  return requirements.map((requirement, index) => {
    const fieldName = typeof requirement === 'string' ? requirement : requirement.field;
    const definition = QUESTION_DEFINITIONS[fieldName] ?? {
      questionId: `field-${fieldName}`,
      options: []
    };
    const prompt = questions?.[index] ?? requirement.question ?? '';
    return {
      questionId: definition.questionId,
      fieldName,
      prompt,
      allowedValues: definition.options.map((option) => option.value),
      options: definition.options.map(({ value, label }) => ({ value, label }))
    };
  });
}

function questionDefinitionForField(fieldName) {
  const normalizedField = normalizeQuestionField(fieldName);
  return normalizedField ? QUESTION_DEFINITIONS[normalizedField] : undefined;
}

module.exports = {
  QUESTION_DEFINITIONS,
  buildQuestionContracts,
  normalizeQuestionField,
  normalizeQuestionValue,
  questionDefinitionForField
};
