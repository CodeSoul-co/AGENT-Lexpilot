const { LEGAL_DOMAINS } = require('./legal-domain.cjs');

const RESULT_CARD_DISCLAIMER =
  '本结果仅基于用户提供的脱敏事实与已核验法规进行信息匹配，不构成违法认定、案件结论或法律意见，也不提供行动建议。';
const RESULT_CARD_FINDING_LABEL = '可能存在不合规风险';

function validateInput(input) {
  if (!input || typeof input !== 'object' || input.piiRedacted !== true) {
    throw new TypeError('Result cards require a sanitized input envelope.');
  }
  if (!Object.values(LEGAL_DOMAINS).includes(input.legalDomain)) {
    throw new TypeError('legalDomain is invalid.');
  }
  if (!Array.isArray(input.lawReferences) || !Array.isArray(input.lawComparisons)) {
    throw new TypeError('lawReferences and lawComparisons must be arrays.');
  }
}

function buildLegalResultCards(input) {
  validateInput(input);
  const referencesById = new Map(
    input.lawReferences.map((reference) => [reference.id, reference])
  );
  const potentialMatches = input.lawComparisons.filter(
    (comparison) => comparison.comparisonStatus === 'potential_match'
  );
  const resultCards = potentialMatches.map((comparison) => {
    const reference = referencesById.get(comparison.lawReferenceId);
    if (
      !reference ||
      reference.legalDomain !== input.legalDomain ||
      comparison.legalDomain !== input.legalDomain ||
      typeof reference.lawName !== 'string' ||
      typeof reference.articleNumber !== 'string' ||
      typeof reference.articleText !== 'string' ||
      typeof reference.articleTextSha256 !== 'string' ||
      typeof reference.effectiveDate !== 'string' ||
      typeof reference.source?.textAuthority !== 'string' ||
      typeof reference.source?.textUrl !== 'string'
    ) {
      throw new TypeError('A potential match does not have a complete same-domain law reference.');
    }

    return {
      cardId: `${comparison.comparisonId}:result-card`,
      findingStatus: 'potential_match',
      findingLabel: RESULT_CARD_FINDING_LABEL,
      userExcerpt: comparison.sanitizedFactExcerpt,
      lawReferenceId: reference.id,
      lawName: reference.lawName,
      articleNumber: reference.articleNumber,
      articleText: reference.articleText,
      articleTextSha256: reference.articleTextSha256,
      lawVersionDate: reference.effectiveDate,
      officialSource: {
        authority: reference.source.textAuthority,
        url: reference.source.textUrl
      },
      unresolvedElements: [...comparison.unresolvedElements],
      legalConclusionGenerated: false
    };
  });

  return {
    status: resultCards.length > 0 ? 'completed' : 'no_match',
    resultCards,
    disclaimer: RESULT_CARD_DISCLAIMER,
    trace: [
      {
        type: 'v0.legal-result-card.built',
        data: {
          legalDomain: input.legalDomain,
          resultCardCount: resultCards.length,
          status: resultCards.length > 0 ? 'completed' : 'no_match'
        }
      }
    ]
  };
}

module.exports = {
  RESULT_CARD_DISCLAIMER,
  RESULT_CARD_FINDING_LABEL,
  buildLegalResultCards
};
