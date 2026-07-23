const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RESULT_CARD_DISCLAIMER,
  buildLegalResultCards
} = require('../src/v0/legal-result-card-builder.cjs');

function laborReference() {
  return {
    id: 'cn.labor-contract-law.article-82',
    legalDomain: 'labor',
    lawName: '中华人民共和国劳动合同法',
    articleNumber: '第八十二条',
    articleText: '经法规库校验的逐字原文',
    articleTextSha256: 'a'.repeat(64),
    effectiveDate: '2013-07-01',
    source: {
      textAuthority: '国家市场监督管理总局',
      textUrl: 'https://www.samr.gov.cn/example'
    }
  };
}

function laborComparison(status = 'potential_match') {
  return {
    comparisonId: 'cn.labor-contract-law.article-82:comparison',
    lawReferenceId: 'cn.labor-contract-law.article-82',
    legalDomain: 'labor',
    comparisonStatus: status,
    sanitizedFactExcerpt: '[NAME_1]工作3年，没有签劳动合同。',
    unresolvedElements: ['exact_employment_start_and_duration'],
    legalConclusionGenerated: false
  };
}

test('builds a result card by copying every law field from the verified reference', () => {
  const reference = laborReference();
  const comparison = laborComparison();
  const result = buildLegalResultCards({
    piiRedacted: true,
    legalDomain: 'labor',
    lawReferences: [reference],
    lawComparisons: [comparison]
  });
  const card = result.resultCards[0];

  assert.equal(result.status, 'completed');
  assert.equal(result.disclaimer, RESULT_CARD_DISCLAIMER);
  assert.equal(card.userExcerpt, comparison.sanitizedFactExcerpt);
  assert.equal(card.lawName, reference.lawName);
  assert.equal(card.articleNumber, reference.articleNumber);
  assert.equal(card.articleText, reference.articleText);
  assert.equal(card.articleTextSha256, reference.articleTextSha256);
  assert.equal(card.lawVersionDate, reference.effectiveDate);
  assert.deepEqual(card.officialSource, {
    authority: reference.source.textAuthority,
    url: reference.source.textUrl
  });
  assert.equal(card.legalConclusionGenerated, false);
});

test('does not build a card from a non-potential comparison', () => {
  const result = buildLegalResultCards({
    piiRedacted: true,
    legalDomain: 'labor',
    lawReferences: [laborReference()],
    lawComparisons: [laborComparison('not_supported_by_facts')]
  });

  assert.equal(result.status, 'no_match');
  assert.deepEqual(result.resultCards, []);
});

test('rejects unsanitized input and incomplete or cross-domain references', () => {
  const base = {
    piiRedacted: true,
    legalDomain: 'labor',
    lawReferences: [laborReference()],
    lawComparisons: [laborComparison()]
  };

  assert.throws(() => buildLegalResultCards({ ...base, piiRedacted: false }), /sanitized/);
  assert.throws(
    () =>
      buildLegalResultCards({
        ...base,
        lawReferences: [{ ...laborReference(), legalDomain: 'taxation' }]
      }),
    /same-domain/
  );
});

test('result-card trace contains counts only', () => {
  const result = buildLegalResultCards({
    piiRedacted: true,
    legalDomain: 'labor',
    lawReferences: [laborReference()],
    lawComparisons: [laborComparison()]
  });
  const trace = JSON.stringify(result.trace);

  assert.equal(trace.includes('经法规库校验的逐字原文'), false);
  assert.equal(trace.includes('[NAME_1]'), false);
  assert.equal(trace.includes('exact_employment_start_and_duration'), false);
});
