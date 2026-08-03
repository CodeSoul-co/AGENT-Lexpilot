const assert = require('node:assert/strict');
const test = require('node:test');
const { V0_ERROR_CODES } = require('../src/v0/contracts.cjs');
const { loadLawCorpus, sha256, validateLawCorpus } = require('../src/v0/law-corpus.cjs');
const { LocalVerifiedLawRetriever } = require('../src/v0/law-retriever.cjs');
const { LEGAL_DOMAINS } = require('../src/v0/legal-domain.cjs');

test('loads twenty-one integrity-pinned official articles across every supported legal domain', () => {
  const corpus = loadLawCorpus();
  const domains = new Set(corpus.entries.map((entry) => entry.legalDomain));

  assert.equal(corpus.corpusId, 'law-corpus.cn.v0-minimal');
  assert.equal(corpus.version, '0.5.0');
  assert.equal(corpus.verifiedAt, '2026-08-03');
  assert.equal(corpus.entries.length, 21);
  assert.deepEqual(domains, new Set(Object.values(LEGAL_DOMAINS)));
  for (const entry of corpus.entries) {
    assert.equal(entry.status, 'effective');
    assert.equal(sha256(entry.articleText), entry.articleTextSha256);
    assert.equal(new URL(entry.source.metadataUrl).protocol, 'https:');
    assert.equal(new URL(entry.source.textUrl).protocol, 'https:');
  }
});

test('pins the verified law name, article number, and effective date for each sample', () => {
  const corpus = loadLawCorpus();
  const summary = Object.fromEntries(
    corpus.entries.map((entry) => [
      entry.id,
      [entry.lawName, entry.articleNumber, entry.effectiveDate]
    ])
  );
  assert.deepEqual(summary, {
    'cn.labor-contract-law.article-82': [
      '中华人民共和国劳动合同法',
      '第八十二条',
      '2013-07-01'
    ],
    'cn.labor-contract-law.article-40': [
      '中华人民共和国劳动合同法',
      '第四十条',
      '2013-07-01'
    ],
    'cn.labor-contract-law.article-39': [
      '中华人民共和国劳动合同法',
      '第三十九条',
      '2013-07-01'
    ],
    'cn.labor-contract-law.article-46': [
      '中华人民共和国劳动合同法',
      '第四十六条',
      '2013-07-01'
    ],
    'cn.civil-code.article-1042': ['中华人民共和国民法典', '第一千零四十二条', '2021-01-01'],
    'cn.civil-code.article-1079': ['中华人民共和国民法典', '第一千零七十九条', '2021-01-01'],
    'cn.civil-code.article-1062': ['中华人民共和国民法典', '第一千零六十二条', '2021-01-01'],
    'cn.civil-code.article-675': ['中华人民共和国民法典', '第六百七十五条', '2021-01-01'],
    'cn.civil-code.article-676': ['中华人民共和国民法典', '第六百七十六条', '2021-01-01'],
    'cn.civil-code.article-680': ['中华人民共和国民法典', '第六百八十条', '2021-01-01'],
    'cn.tax-collection-administration-law.article-25': [
      '中华人民共和国税收征收管理法',
      '第二十五条',
      '2015-04-24'
    ],
    'cn.tax-collection-administration-law.article-32': [
      '中华人民共和国税收征收管理法',
      '第三十二条',
      '2015-04-24'
    ],
    'cn.tax-collection-administration-law.article-62': [
      '中华人民共和国税收征收管理法',
      '第六十二条',
      '2015-04-24'
    ],
    'cn.patent-law.article-11': ['中华人民共和国专利法', '第十一条', '2021-06-01'],
    'cn.patent-law.article-71': ['中华人民共和国专利法', '第七十一条', '2021-06-01'],
    'cn.patent-law.article-74': ['中华人民共和国专利法', '第七十四条', '2021-06-01'],
    'cn.labor-contract-law.article-47': [
      '中华人民共和国劳动合同法',
      '第四十七条',
      '2013-07-01'
    ],
    'cn.civil-code.article-1063': ['中华人民共和国民法典', '第一千零六十三条', '2021-01-01'],
    'cn.civil-code.article-679': ['中华人民共和国民法典', '第六百七十九条', '2021-01-01'],
    'cn.tax-collection-administration-law.article-63': [
      '中华人民共和国税收征收管理法',
      '第六十三条',
      '2015-04-24'
    ],
    'cn.patent-law.article-75': ['中华人民共和国专利法', '第七十五条', '2021-06-01']
  });
});

test('keeps staged corpus batches out of retrieval until dedicated regressions enable them', () => {
  const corpus = loadLawCorpus();
  const stagedIds = [
    'cn.labor-contract-law.article-39',
    'cn.labor-contract-law.article-46',
    'cn.civil-code.article-1079',
    'cn.civil-code.article-1062',
    'cn.civil-code.article-676',
    'cn.civil-code.article-680',
    'cn.tax-collection-administration-law.article-32',
    'cn.tax-collection-administration-law.article-62',
    'cn.patent-law.article-71',
    'cn.patent-law.article-74',
    'cn.labor-contract-law.article-47',
    'cn.civil-code.article-1063',
    'cn.civil-code.article-679',
    'cn.tax-collection-administration-law.article-63',
    'cn.patent-law.article-75'
  ];
  for (const id of stagedIds) {
    assert.equal(corpus.entries.find((entry) => entry.id === id)?.retrievalEnabled, false);
  }
  const retriever = new LocalVerifiedLawRetriever();
  for (const domain of Object.values(LEGAL_DOMAINS)) {
    const returnedIds = retriever.search({ legalDomain: domain }).results.map((entry) => entry.id);
    assert.equal(returnedIds.some((id) => stagedIds.includes(id)), false);
  }
});

test('retrieves the activated Article 40 entry alongside the unsigned-contract article', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const broad = retriever.search({ legalDomain: LEGAL_DOMAINS.LABOR });
  const dismissalTopic = retriever.search({
    legalDomain: LEGAL_DOMAINS.LABOR,
    topics: ['dismissal_notice_or_pay']
  });

  assert.deepEqual(broad.results.map((entry) => entry.id), [
    'cn.labor-contract-law.article-40',
    'cn.labor-contract-law.article-82'
  ]);
  assert.equal(dismissalTopic.status, 'matched');
  assert.deepEqual(
    dismissalTopic.results.map((entry) => entry.id),
    ['cn.labor-contract-law.article-40']
  );
});

test('retrieves only entries from the requested legal domain', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const result = retriever.search({ legalDomain: LEGAL_DOMAINS.PRIVATE_LENDING });

  assert.equal(result.status, 'matched');
  assert.equal(result.retrievalMode, 'local_verified_corpus');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'cn.civil-code.article-675');
  assert.equal(result.results[0].legalDomain, LEGAL_DOMAINS.PRIVATE_LENDING);
  assert.equal(JSON.stringify(result.trace).includes(result.results[0].articleText), false);
});

test('supports deterministic topic filtering without accepting free-form user text', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const matched = retriever.search({
    legalDomain: LEGAL_DOMAINS.LABOR,
    topics: ['written_contract'],
    limit: 1
  });
  const missing = retriever.search({
    legalDomain: LEGAL_DOMAINS.LABOR,
    topics: ['overtime']
  });

  assert.equal(matched.results[0].articleNumber, '第八十二条');
  assert.equal(missing.status, 'no_match');
  assert.deepEqual(missing.results, []);
  assert.throws(
    () => retriever.search({ legalDomain: LEGAL_DOMAINS.LABOR, userText: '原始用户描述' }),
    (error) => error.code === V0_ERROR_CODES.INVALID_LAW_RETRIEVAL_QUERY
  );
});

test('returns defensive result copies', () => {
  const retriever = new LocalVerifiedLawRetriever();
  const first = retriever.search({ legalDomain: LEGAL_DOMAINS.TAXATION });
  first.results[0].articleText = 'tampered';
  first.results[0].source.textUrl = 'https://example.com';

  const second = retriever.search({ legalDomain: LEGAL_DOMAINS.TAXATION });
  assert.notEqual(second.results[0].articleText, 'tampered');
  assert.notEqual(second.results[0].source.textUrl, 'https://example.com');
});

test('rejects changed text, duplicate IDs, and non-official sources', () => {
  const original = loadLawCorpus();
  const changedText = structuredClone(original);
  changedText.entries[0].articleText += '被修改';
  assert.throws(
    () => validateLawCorpus(changedText),
    (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID
  );

  const duplicateId = structuredClone(original);
  duplicateId.entries[1].id = duplicateId.entries[0].id;
  assert.throws(
    () => validateLawCorpus(duplicateId),
    (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID
  );

  const unofficial = structuredClone(original);
  unofficial.entries[0].source.textUrl = 'https://example.com/law';
  assert.throws(
    () => validateLawCorpus(unofficial),
    (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID
  );

  const impossibleDate = structuredClone(original);
  impossibleDate.entries[0].effectiveDate = '2026-02-31';
  assert.throws(
    () => validateLawCorpus(impossibleDate),
    (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID
  );

  const invalidRetrievalFlag = structuredClone(original);
  invalidRetrievalFlag.entries[0].retrievalEnabled = 'false';
  assert.throws(
    () => validateLawCorpus(invalidRetrievalFlag),
    (error) => error.code === V0_ERROR_CODES.LAW_CORPUS_INVALID
  );
});
