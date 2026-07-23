const { validateLawCorpus } = require('./law-corpus.cjs');
const { LEGAL_DOMAINS } = require('./legal-domain.cjs');

const DEFAULT_TARGET_UNIQUE_ARTICLES = 100;

function citationKey(entry) {
  const lawName = entry.lawName.normalize('NFKC').replace(/\s+/gu, '');
  const articleNumber = entry.articleNumber.normalize('NFKC').replace(/\s+/gu, '');
  return `${lawName}::${articleNumber}`;
}

function auditLawCorpusCoverage(
  corpus,
  { targetUniqueArticles = DEFAULT_TARGET_UNIQUE_ARTICLES } = {}
) {
  if (!Number.isInteger(targetUniqueArticles) || targetUniqueArticles <= 0) {
    throw new TypeError('targetUniqueArticles 必须是正整数。');
  }

  const validated = validateLawCorpus(corpus);
  const supportedDomains = Object.values(LEGAL_DOMAINS);
  const domainCounts = Object.fromEntries(supportedDomains.map((domain) => [domain, 0]));
  const uniqueCitations = new Set();

  for (const entry of validated.entries) {
    domainCounts[entry.legalDomain] += 1;
    uniqueCitations.add(citationKey(entry));
  }

  const entryCount = validated.entries.length;
  const uniqueArticleCount = uniqueCitations.size;
  const missingDomains = supportedDomains.filter((domain) => domainCounts[domain] === 0);
  const status =
    missingDomains.length > 0
      ? 'missing_domains'
      : uniqueArticleCount < targetUniqueArticles
        ? 'insufficient_coverage'
        : 'ready';

  return {
    ok: status === 'ready',
    status,
    corpusId: validated.corpusId,
    corpusVersion: validated.version,
    targetUniqueArticles,
    entryCount,
    uniqueArticleCount,
    duplicateCitationCount: entryCount - uniqueArticleCount,
    missingUniqueArticleCount: Math.max(targetUniqueArticles - uniqueArticleCount, 0),
    domainCounts,
    missingDomains
  };
}

module.exports = {
  DEFAULT_TARGET_UNIQUE_ARTICLES,
  auditLawCorpusCoverage
};
