const assert = require('node:assert/strict');
const test = require('node:test');
const { V0_ERROR_CODES } = require('../src/v0/contracts.cjs');
const { loadLawCorpus, sha256, validateLawCorpus } = require('../src/v0/law-corpus.cjs');
const { LocalVerifiedLawRetriever } = require('../src/v0/law-retriever.cjs');
const { LEGAL_DOMAINS } = require('../src/v0/legal-domain.cjs');

test('loads one hundred unique integrity-pinned official articles across all five domains', () => {
  const corpus = loadLawCorpus();
  const citations = new Set(
    corpus.entries.map((entry) => `${entry.lawName.normalize('NFKC')}::${entry.articleNumber.normalize('NFKC')}`)
  );
  assert.equal(corpus.corpusId, 'law-corpus.cn.v0-100');
  assert.equal(corpus.version, '1.0.0');
  assert.equal(corpus.verifiedAt, '2026-08-08');
  assert.equal(corpus.entries.length, 100);
  assert.equal(citations.size, 100);
  assert.deepEqual(new Set(corpus.entries.map((entry) => entry.legalDomain)), new Set(Object.values(LEGAL_DOMAINS)));
  for (const entry of corpus.entries) {
    assert.equal(entry.status, 'effective');
    assert.equal(entry.verifiedAt, '2026-08-08');
    assert.equal(entry.retrievalEnabled, true);
    assert.equal(sha256(entry.articleText), entry.articleTextSha256);
    assert.ok(entry.selectionReason.length > 20);
    assert.deepEqual([...entry.matching.safeStopFields].sort(), Object.keys(entry.matching.factRequirements).sort());
    assert.equal(new URL(entry.source.metadataUrl).protocol, 'https:');
    assert.equal(new URL(entry.source.textUrl).protocol, 'https:');
  }
});

test('pins the 2026-08-08 trademark version boundary without mixing the future text', () => {
  const entries = loadLawCorpus().entries.filter((entry) => entry.id.startsWith('cn.trademark-law.'));
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.equal(entry.publicationDate, '2019-04-23');
    assert.equal(entry.effectiveDate, '2019-11-01');
    assert.equal(entry.effectiveUntil, '2026-12-31');
    assert.equal(entry.futureVersion.effectiveDate, '2027-01-01');
    assert.match(entry.futureVersion.url, /^https:\/\/www\.cnipa\.gov\.cn\//);
  }
});

test('retrieves every enabled article by exact same-domain ID and never crosses domains', () => {
  const corpus = loadLawCorpus();
  const retriever = new LocalVerifiedLawRetriever();
  for (const entry of corpus.entries) {
    const positive = retriever.search({
      legalDomain: entry.legalDomain,
      articleIds: [entry.id],
      limit: 1
    });
    assert.equal(positive.status, 'matched', entry.id);
    assert.equal(positive.results[0].id, entry.id);

    const wrongDomain = Object.values(LEGAL_DOMAINS).find((domain) => domain !== entry.legalDomain);
    const negative = retriever.search({ legalDomain: wrongDomain, articleIds: [entry.id], limit: 1 });
    assert.equal(negative.status, 'no_match', entry.id);
    assert.equal(negative.matchClassification, 'corpus_uncovered');
    assert.deepEqual(negative.results, []);
  }
});

test('supports deterministic topic filtering without accepting free-form user text', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const matched = retriever.search({ legalDomain: LEGAL_DOMAINS.LABOR, topics: ['overtime'], limit: 10 });
  assert.deepEqual(matched.results.map((entry) => entry.id), ['cn.labor-contract-law.article-31']);
  assert.throws(
    () => retriever.search({ legalDomain: LEGAL_DOMAINS.LABOR, userText: '原始用户描述' }),
    (error) => error.code === V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY
  );
});

test('returns defensive result copies', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const first = retriever.search({ legalDomain: LEGAL_DOMAINS.TAXATION, limit: 1 });
  first.results[0].articleText = 'tampered';
  first.results[0].source.textUrl = 'https://example.com';
  const second = retriever.search({ legalDomain: LEGAL_DOMAINS.TAXATION, limit: 1 });
  assert.notEqual(second.results[0].articleText, 'tampered');
  assert.notEqual(second.results[0].source.textUrl, 'https://example.com');
});

test('rejects changed text, duplicate citations, disabled retrieval, and non-official sources', () => {
  const corpus = loadLawCorpus();
  const changed = structuredClone(corpus);
  changed.entries[0].articleText += 'tampered';
  assert.throws(() => validateLawCorpus(changed), (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID);

  const disabled = structuredClone(corpus);
  disabled.entries[0].retrievalEnabled = false;
  assert.throws(() => validateLawCorpus(disabled), (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID);

  const untrusted = structuredClone(corpus);
  untrusted.entries[0].source.textUrl = 'https://example.com/law';
  assert.throws(() => validateLawCorpus(untrusted), (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID);
});
