const assert = require('node:assert/strict');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { planLawRetrieval, ROUTING_FIELDS } = require('../src/v0/law-reference-planner.cjs');

test('maps supported structured routing facts to same-domain candidate IDs', () => {
  const cases = [
    ['labor', { issueType: 'contract', writtenContractStatus: 'not_signed' }],
    ['labor', { issueType: 'dismissal', writtenContractStatus: 'signed' }],
    ['private_lending', { lendingIssueType: 'repayment_interest' }],
    ['private_lending', { lendingIssueType: 'guarantee' }],
    ['marriage_family', { disputeType: 'domestic_violence' }],
    ['marriage_family', { disputeType: 'property' }],
    ['taxation', { taxIssueType: 'invoice' }],
    ['taxation', { taxIssueType: 'filing' }],
    ['intellectual_property', { rightType: 'patent' }],
    ['intellectual_property', { rightType: 'trademark' }],
    ['intellectual_property', { rightType: 'written_work' }]
  ];
  const byId = new Map(loadLawCorpus().entries.map((entry) => [entry.id, entry]));
  for (const [legalDomain, knownFacts] of cases) {
    const result = planLawRetrieval({ legalDomain, knownFacts });
    assert.equal(result.eligible, true, `${legalDomain}:${JSON.stringify(knownFacts)}`);
    assert.equal(result.classification, 'candidate_path_available');
    assert.ok(result.candidateIds.length > 0);
    assert.equal(result.candidateIds.every((id) => byId.get(id)?.legalDomain === legalDomain), true);
  }
});

test('keeps an unsigned-contract dismissal on the narrow Article 82 path', () => {
  const result = planLawRetrieval({
    legalDomain: 'labor',
    knownFacts: { issueType: 'dismissal', writtenContractStatus: 'not_signed' }
  });
  assert.deepEqual(result.candidateIds, ['cn.labor-contract-law.article-82']);
});

test('classifies missing or unsupported routing facts as corpus uncovered without broad retrieval', () => {
  const cases = [
    ['labor', { writtenContractStatus: 'signed' }],
    ['private_lending', { repaymentStatus: 'paid' }],
    ['marriage_family', { disputeType: 'unrelated' }],
    ['taxation', { taxIssueType: 'unrelated' }],
    ['intellectual_property', { rightType: 'trade_secret' }]
  ];
  for (const [legalDomain, knownFacts] of cases) {
    const result = planLawRetrieval({ legalDomain, knownFacts });
    assert.equal(result.eligible, false);
    assert.equal(result.classification, 'corpus_uncovered');
    assert.deepEqual(result.candidateIds, []);
    assert.deepEqual(result.topics, []);
  }
});

test('declares one structured routing field for every supported domain', () => {
  assert.deepEqual(Object.keys(ROUTING_FIELDS).sort(), [
    'intellectual_property',
    'labor',
    'marriage_family',
    'private_lending',
    'taxation'
  ]);
});
