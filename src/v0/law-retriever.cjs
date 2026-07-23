const { V0_ERROR_CODES, V0ContractError } = require('./contracts.cjs');
const { LEGAL_DOMAINS } = require('./legal-domain.cjs');
const { loadLawCorpus, validateLawCorpus } = require('./law-corpus.cjs');

const SUPPORTED_DOMAINS = new Set(Object.values(LEGAL_DOMAINS));

function validateQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY, '法规检索请求必须是对象。');
  }
  const allowedKeys = new Set(['legalDomain', 'topics', 'limit']);
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) {
    throw new V0ContractError(
      V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY,
      '法规检索请求包含未声明字段。'
    );
  }
  if (!SUPPORTED_DOMAINS.has(query.legalDomain)) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY, '法规检索领域无效。');
  }
  const topics = query.topics ?? [];
  if (
    !Array.isArray(topics) ||
    topics.some((topic) => typeof topic !== 'string' || topic.trim().length === 0)
  ) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY, 'topics 必须是字符串数组。');
  }
  const limit = query.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY, 'limit 必须是 1 到 10 的整数。');
  }
  return {
    legalDomain: query.legalDomain,
    topics: [...new Set(topics.map((topic) => topic.trim()))],
    limit
  };
}

class LocalVerifiedLawRetriever {
  #corpus;

  constructor(options = {}) {
    this.#corpus = options.corpus
      ? validateLawCorpus(options.corpus)
      : loadLawCorpus(options.corpusPath);
  }

  search(query) {
    const normalized = validateQuery(query);
    const results = this.#corpus.entries
      .filter((entry) => entry.retrievalEnabled !== false)
      .filter((entry) => entry.legalDomain === normalized.legalDomain)
      .filter(
        (entry) =>
          normalized.topics.length === 0 ||
          normalized.topics.some((topic) => entry.topics.includes(topic))
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, normalized.limit)
      .map((entry) => structuredClone(entry));
    const status = results.length > 0 ? 'matched' : 'no_match';
    return {
      status,
      retrievalMode: 'local_verified_corpus',
      corpusId: this.#corpus.corpusId,
      corpusVersion: this.#corpus.version,
      corpusVerifiedAt: this.#corpus.verifiedAt,
      legalDomain: normalized.legalDomain,
      results,
      trace: [
        {
          type: 'v0.law.retrieval.completed',
          data: {
            status,
            legalDomain: normalized.legalDomain,
            resultCount: results.length,
            corpusVersion: this.#corpus.version
          }
        }
      ]
    };
  }
}

module.exports = { LocalVerifiedLawRetriever, validateQuery };
