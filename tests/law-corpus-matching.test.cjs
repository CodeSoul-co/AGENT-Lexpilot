const assert = require('node:assert/strict');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { COMPARISON_METHOD, COMPARISON_RULES, compareFactsToLaw } = require('../src/v0/law-comparison-engine.cjs');
const { buildLegalResultCards, RESULT_CARD_DISCLAIMER } = require('../src/v0/legal-result-card-builder.cjs');

function positiveFacts(entry) {
  if (entry.id === 'cn.labor-contract-law.article-40') {
    return {
      issueType: 'dismissal',
      dismissalGround: 'performance',
      noticeOrPayStatus: 'neither',
      performanceRemediationOutcome: 'training_or_adjustment_still_unqualified'
    };
  }
  return Object.fromEntries(
    Object.entries(entry.matching.factRequirements).map(([field, values]) => [field, values[0]])
  );
}

function negativeFacts(entry) {
  if (entry.id === 'cn.labor-contract-law.article-40') return { issueType: 'unpaid_wages' };
  const facts = positiveFacts(entry);
  const [field, values] = Object.entries(entry.matching.factExclusions)[0];
  facts[field] = values[0];
  return facts;
}

function compare(entry, knownFacts, message) {
  return compareFactsToLaw({
    piiRedacted: true,
    legalDomain: entry.legalDomain,
    knownFacts,
    redactedMessages: [message],
    lawReferences: [entry]
  }).comparisons[0];
}

function positiveMessage(entry) {
  return entry.id === 'cn.labor-contract-law.article-40'
    ? '公司辞退并说明了通知和工资事实。'
    : `${entry.matching.excerptSignals[0]}相关事实已说明。`;
}

test('defines a deterministic safe comparison rule for every one of the 100 articles', () => {
  const corpus = loadLawCorpus();
  assert.equal(corpus.entries.length, 100);
  assert.equal(Object.keys(COMPARISON_RULES).length, 100);

  for (const entry of corpus.entries) {
    const message = positiveMessage(entry);
    const positive = compare(entry, positiveFacts(entry), message);
    assert.equal(positive.comparisonStatus, 'potential_match', `${entry.id} positive`);
    assert.equal(positive.legalConclusionGenerated, false, entry.id);
    assert.equal(positive.comparisonMethod, COMPARISON_METHOD, entry.id);

    const negative = compare(entry, negativeFacts(entry), message);
    assert.equal(negative.comparisonStatus, 'not_supported_by_facts', `${entry.id} negative`);
    assert.equal(negative.legalConclusionGenerated, false, entry.id);

    const insufficientFacts = positiveFacts(entry);
    const missingField = entry.id === 'cn.labor-contract-law.article-40'
      ? 'dismissalGround'
      : entry.matching.safeStopFields[0];
    delete insufficientFacts[missingField];
    const insufficient = compare(entry, insufficientFacts, message);
    assert.equal(insufficient.comparisonStatus, 'insufficient_for_comparison', `${entry.id} insufficient`);
  }
});

test('builds a source-verifiable result card for every positive rule and never emits a conclusion or action advice', () => {
  for (const entry of loadLawCorpus().entries) {
    const comparison = compare(
      entry,
      positiveFacts(entry),
      positiveMessage(entry)
    );
    const built = buildLegalResultCards({
      piiRedacted: true,
      legalDomain: entry.legalDomain,
      lawReferences: [entry],
      lawComparisons: [comparison]
    });
    assert.equal(built.status, 'completed', entry.id);
    assert.equal(built.disclaimer, RESULT_CARD_DISCLAIMER, entry.id);
    assert.equal(built.resultCards.length, 1, entry.id);
    assert.equal(built.resultCards[0].officialSource.url, entry.source.textUrl, entry.id);
    assert.equal(built.resultCards[0].legalConclusionGenerated, false, entry.id);
    assert.equal(JSON.stringify(built).includes('actionAdvice'), false, entry.id);
  }
});

test('keeps the three no-result classifications distinct', () => {
  const entry = loadLawCorpus().entries.find((item) => item.id === 'cn.civil-code.article-675');
  const message = '借款还款事实已说明。';
  assert.equal(compare(entry, {}, message).comparisonStatus, 'insufficient_for_comparison');
  assert.equal(compare(entry, negativeFacts(entry), message).comparisonStatus, 'not_supported_by_facts');
  assert.equal(
    compareFactsToLaw({
      piiRedacted: true,
      legalDomain: entry.legalDomain,
      knownFacts: positiveFacts(entry),
      redactedMessages: [message],
      lawReferences: []
    }).comparisons.length,
    0
  );
});
