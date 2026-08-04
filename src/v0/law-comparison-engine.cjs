const { LEGAL_DOMAINS } = require('./legal-domain.cjs');
const {
  ARTICLE_ID: LABOR_ARTICLE_40_ID,
  assessLaborArticle40Facts
} = require('./labor-article-40-facts.cjs');

const COMPARISON_METHOD = 'deterministic_legal_elements_v0';

const LABOR_ARTICLE_40_EXCERPT_SIGNALS = Object.freeze(['辞退', '通知', '工资']);
const LABOR_ARTICLE_40_UNRESOLVED_ELEMENTS = Object.freeze([
  'employer_evidence_for_declared_ground',
  'notice_or_pay_documentation'
]);

const COMPARISON_RULES = Object.freeze({
  'cn.labor-contract-law.article-82': {
    legalDomain: LEGAL_DOMAINS.LABOR,
    factRequirements: {
      employmentDuration: ['mentioned'],
      writtenContractStatus: ['not_signed']
    },
    excerptSignals: ['工作', '合同', '签'],
    unresolvedElements: [
      'exact_employment_start_and_duration',
      'written_contract_signing_timeline',
      'indefinite_term_contract_duty'
    ]
  },
  'cn.civil-code.article-675': {
    legalDomain: LEGAL_DOMAINS.PRIVATE_LENDING,
    factRequirements: {
      evidenceStatus: ['available', 'none_stated'],
      repaymentTermStatus: ['agreed', 'not_agreed'],
      repaymentStatus: ['unpaid', 'partial']
    },
    excerptSignals: ['借', '还', '到期', '说好'],
    unresolvedElements: ['loan_relationship_validity', 'exact_repayment_terms']
  },
  'cn.civil-code.article-676': {
    legalDomain: LEGAL_DOMAINS.PRIVATE_LENDING,
    factRequirements: {
      evidenceStatus: ['available', 'none_stated'],
      repaymentTermStatus: ['agreed'],
      repaymentStatus: ['unpaid', 'partial']
    },
    excerptSignals: ['借', '还', '到期', '说好'],
    unresolvedElements: [
      'loan_relationship_validity',
      'exact_repayment_due_date',
      'applicable_overdue_interest_basis'
    ]
  },
  'cn.tax-collection-administration-law.article-25': {
    legalDomain: LEGAL_DOMAINS.TAXATION,
    factRequirements: {
      taxpayerType: ['self_employed', 'company', 'individual'],
      taxIssueType: ['filing', 'withholding'],
      taxPeriod: ['mentioned']
    },
    excerptSignals: ['税', '申报', '报税', '扣税'],
    unresolvedElements: ['applicable_declaration_deadline', 'actual_declaration_compliance']
  },
  'cn.patent-law.article-11': {
    legalDomain: LEGAL_DOMAINS.INTELLECTUAL_PROPERTY,
    factRequirements: {
      rightType: ['patent'],
      allegedAct: ['sale', 'use'],
      authorizationStatus: ['not_authorized']
    },
    excerptSignals: ['专利', '授权', '许可', '销售', '使用'],
    unresolvedElements: [
      'patent_grant_and_effectiveness',
      'production_or_business_purpose',
      'statutory_exception'
    ]
  }
});

function selectSanitizedExcerpt(redactedMessages, signals) {
  const segments = redactedMessages
    .flatMap((text) => text.split(/(?<=[。！？!?；;\n])/u))
    .map((text) => text.trim())
    .filter(Boolean);
  return segments
    .filter((segment) => signals.some((signal) => segment.includes(signal)))
    .slice(0, 2)
    .join(' ')
    .slice(0, 300);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || input.piiRedacted !== true) {
    throw new TypeError('Law comparison requires a sanitized input envelope.');
  }
  if (!Object.values(LEGAL_DOMAINS).includes(input.legalDomain)) {
    throw new TypeError('legalDomain is invalid.');
  }
  if (!input.knownFacts || typeof input.knownFacts !== 'object') {
    throw new TypeError('knownFacts must be an object.');
  }
  if (
    !Array.isArray(input.redactedMessages) ||
    input.redactedMessages.some((text) => typeof text !== 'string')
  ) {
    throw new TypeError('redactedMessages must be a string array.');
  }
  if (
    !Array.isArray(input.lawReferences) ||
    input.lawReferences.some(
      (reference) =>
        !reference ||
        typeof reference.id !== 'string' ||
        reference.legalDomain !== input.legalDomain
    )
  ) {
    throw new TypeError('lawReferences must contain same-domain verified references.');
  }
}

function compareLaborArticle40(input, reference) {
  const base = {
    comparisonId: `${reference.id}:comparison`,
    lawReferenceId: reference.id,
    legalDomain: input.legalDomain,
    comparisonMethod: COMPARISON_METHOD,
    legalConclusionGenerated: false
  };
  const assessment = assessLaborArticle40Facts({
    piiRedacted: true,
    knownFacts: input.knownFacts
  });
  const matchedFacts = assessment.requiredFields
    .filter(
      (field) =>
        Object.hasOwn(input.knownFacts, field) && input.knownFacts[field] !== 'unknown'
    )
    .map((field) => ({ field, value: input.knownFacts[field] }));

  if (
    assessment.status === 'not_applicable' ||
    assessment.status === 'not_supported_by_declared_ground'
  ) {
    const matchedFields = new Set(matchedFacts.map((fact) => fact.field));
    return {
      ...base,
      comparisonStatus: 'not_supported_by_facts',
      sanitizedFactExcerpt: '',
      matchedFacts,
      unresolvedElements: [
        ...assessment.requiredFields
          .filter((field) => !matchedFields.has(field))
          .map((field) => `fact_not_supporting:${field}`),
        ...LABOR_ARTICLE_40_UNRESOLVED_ELEMENTS
      ]
    };
  }

  if (assessment.status === 'needs_clarification') {
    return {
      ...base,
      comparisonStatus: 'insufficient_for_comparison',
      sanitizedFactExcerpt: '',
      matchedFacts,
      unresolvedElements: [
        ...assessment.missingFields.map((field) => `missing_fact:${field}`),
        ...LABOR_ARTICLE_40_UNRESOLVED_ELEMENTS
      ]
    };
  }

  const sanitizedFactExcerpt = selectSanitizedExcerpt(
    input.redactedMessages,
    LABOR_ARTICLE_40_EXCERPT_SIGNALS
  );
  return {
    ...base,
    comparisonStatus: sanitizedFactExcerpt ? 'potential_match' : 'insufficient_for_comparison',
    sanitizedFactExcerpt,
    matchedFacts,
    unresolvedElements: [
      ...(sanitizedFactExcerpt ? [] : ['fact_excerpt_not_verifiable']),
      ...LABOR_ARTICLE_40_UNRESOLVED_ELEMENTS
    ]
  };
}

function compareFactsToLaw(input) {
  validateInput(input);
  const comparisons = input.lawReferences.map((reference) => {
    if (reference.id === LABOR_ARTICLE_40_ID && input.legalDomain === LEGAL_DOMAINS.LABOR) {
      return compareLaborArticle40(input, reference);
    }
    const rule = COMPARISON_RULES[reference.id];
    if (!rule || rule.legalDomain !== input.legalDomain) {
      return {
        comparisonId: `${reference.id}:comparison`,
        lawReferenceId: reference.id,
        legalDomain: input.legalDomain,
        comparisonStatus: 'insufficient_for_comparison',
        sanitizedFactExcerpt: '',
        matchedFacts: [],
        unresolvedElements: ['comparison_rule_not_available'],
        comparisonMethod: COMPARISON_METHOD,
        legalConclusionGenerated: false
      };
    }

    const factFields = Object.keys(rule.factRequirements);
    const observedFacts = factFields.filter((field) => Object.hasOwn(input.knownFacts, field));
    const matchedFacts = observedFacts
      .filter((field) => rule.factRequirements[field].includes(input.knownFacts[field]))
      .map((field) => ({ field, value: input.knownFacts[field] }));
    const sanitizedFactExcerpt = selectSanitizedExcerpt(
      input.redactedMessages,
      rule.excerptSignals
    );
    const allRequiredFactsPresent = observedFacts.length === factFields.length;
    const allRequiredFactsSupportRule = matchedFacts.length === factFields.length;
    const excerptMissing = allRequiredFactsSupportRule && !sanitizedFactExcerpt;
    return {
      comparisonId: `${reference.id}:comparison`,
      lawReferenceId: reference.id,
      legalDomain: input.legalDomain,
      comparisonStatus: !allRequiredFactsPresent
        ? 'insufficient_for_comparison'
        : !allRequiredFactsSupportRule
          ? 'not_supported_by_facts'
          : excerptMissing
            ? 'insufficient_for_comparison'
            : 'potential_match',
      sanitizedFactExcerpt,
      matchedFacts,
      unresolvedElements: [
        ...factFields
          .filter((field) => !Object.hasOwn(input.knownFacts, field))
          .map((field) => `missing_fact:${field}`),
        ...observedFacts
          .filter((field) => !rule.factRequirements[field].includes(input.knownFacts[field]))
          .map((field) => `fact_not_supporting:${field}`),
        ...(excerptMissing ? ['fact_excerpt_not_verifiable'] : []),
        ...rule.unresolvedElements
      ],
      comparisonMethod: COMPARISON_METHOD,
      legalConclusionGenerated: false
    };
  });

  return {
    status: 'completed',
    comparisons,
    trace: [
      {
        type: 'v0.law.comparison.completed',
        data: {
          legalDomain: input.legalDomain,
          comparisonCount: comparisons.length,
          potentialMatchCount: comparisons.filter(
            (comparison) => comparison.comparisonStatus === 'potential_match'
          ).length,
          method: COMPARISON_METHOD
        }
      }
    ]
  };
}

module.exports = { COMPARISON_METHOD, COMPARISON_RULES, compareFactsToLaw };
