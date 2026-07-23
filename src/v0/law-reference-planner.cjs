const { LEGAL_DOMAINS } = require('./legal-domain.cjs');
const { assessLaborArticle40Facts } = require('./labor-article-40-facts.cjs');

const LAW_REFERENCE_DISCLAIMER =
  '以下内容仅为基于已提供事实匹配的候选法规来源，不构成违法认定、案件结论或法律意见。';

function planLawRetrieval({ legalDomain, knownFacts }) {
  const facts = knownFacts && typeof knownFacts === 'object' ? knownFacts : {};
  const topics = [];

  if (
    legalDomain === LEGAL_DOMAINS.LABOR &&
    facts.employmentDuration === 'mentioned' &&
    facts.writtenContractStatus === 'not_signed'
  ) {
    topics.push('written_contract');
  }

  if (
    legalDomain === LEGAL_DOMAINS.LABOR &&
    facts.issueType === 'dismissal' &&
    facts.writtenContractStatus === 'signed' &&
    assessLaborArticle40Facts({ piiRedacted: true, knownFacts: facts }).comparisonAllowed
  ) {
    topics.push('dismissal_notice_or_pay');
  }

  if (
    legalDomain === LEGAL_DOMAINS.PRIVATE_LENDING &&
    ['agreed', 'not_agreed'].includes(facts.repaymentTermStatus) &&
    ['unpaid', 'partial'].includes(facts.repaymentStatus)
  ) {
    topics.push('repayment_term');
  }

  if (legalDomain === LEGAL_DOMAINS.MARRIAGE_FAMILY) {
    const topicByDisputeType = {
      domestic_violence: 'domestic_violence',
      bigamy: 'bigamy',
      marriage_freedom: 'marriage_freedom'
    };
    const topic = topicByDisputeType[facts.disputeType];
    if (topic) topics.push(topic);
  }

  if (legalDomain === LEGAL_DOMAINS.TAXATION) {
    if (facts.taxIssueType === 'filing') topics.push('tax_declaration');
    if (facts.taxIssueType === 'withholding') topics.push('withholding_declaration');
  }

  if (
    legalDomain === LEGAL_DOMAINS.INTELLECTUAL_PROPERTY &&
    facts.rightType === 'patent' &&
    ['sale', 'use'].includes(facts.allegedAct) &&
    facts.authorizationStatus === 'not_authorized'
  ) {
    topics.push('patent_implementation');
  }

  return {
    eligible: topics.length > 0,
    legalDomain,
    topics,
    trace: [
      {
        type: 'v0.law.retrieval.planned',
        data: {
          eligible: topics.length > 0,
          legalDomain,
          topicCount: topics.length
        }
      }
    ]
  };
}

module.exports = { LAW_REFERENCE_DISCLAIMER, planLawRetrieval };
