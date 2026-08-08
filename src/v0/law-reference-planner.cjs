const { LEGAL_DOMAINS } = require('./legal-domain.cjs');
const { loadLawCorpus } = require('./law-corpus.cjs');

const LAW_REFERENCE_DISCLAIMER =
  '以下内容仅为基于已提供事实匹配的候选法规来源，不构成违法认定、案件结论、法律意见或行动建议。';

const ROUTING_FIELDS = Object.freeze({
  [LEGAL_DOMAINS.LABOR]: 'issueType',
  [LEGAL_DOMAINS.MARRIAGE_FAMILY]: 'disputeType',
  [LEGAL_DOMAINS.PRIVATE_LENDING]: 'lendingIssueType',
  [LEGAL_DOMAINS.TAXATION]: 'taxIssueType',
  [LEGAL_DOMAINS.INTELLECTUAL_PROPERTY]: 'rightType'
});

function inferredRoutingValues(entry, routeField) {
  const declared = entry.matching.factRequirements[routeField];
  if (declared) return declared;
  if (entry.id === 'cn.labor-contract-law.article-82') return ['contract'];
  if (entry.id === 'cn.civil-code.article-675' || entry.id === 'cn.civil-code.article-676') {
    return ['repayment_interest'];
  }
  return [];
}

function planLawRetrieval({ legalDomain, knownFacts }) {
  const facts = knownFacts && typeof knownFacts === 'object' ? knownFacts : {};
  const routeField = ROUTING_FIELDS[legalDomain];
  const routeValue = routeField ? facts[routeField] : undefined;
  const unsignedContractOnly =
    legalDomain === LEGAL_DOMAINS.LABOR && facts.writtenContractStatus === 'not_signed';
  const candidates = unsignedContractOnly
    ? loadLawCorpus().entries.filter(
        (entry) => entry.id === 'cn.labor-contract-law.article-82'
      )
    : routeValue === undefined
    ? []
    : loadLawCorpus().entries.filter(
        (entry) =>
          entry.legalDomain === legalDomain &&
          inferredRoutingValues(entry, routeField).includes(routeValue)
      );

  return {
    eligible: candidates.length > 0,
    legalDomain,
    candidateIds: candidates.map((entry) => entry.id),
    topics: [...new Set(candidates.flatMap((entry) => entry.topics))],
    classification: candidates.length > 0 ? 'candidate_path_available' : 'corpus_uncovered',
    trace: [
      {
        type: 'v0.law.retrieval.planned',
        data: {
          eligible: candidates.length > 0,
          legalDomain,
          candidateCount: candidates.length,
          classification: candidates.length > 0 ? 'candidate_path_available' : 'corpus_uncovered'
        }
      }
    ]
  };
}

module.exports = { LAW_REFERENCE_DISCLAIMER, ROUTING_FIELDS, planLawRetrieval };
