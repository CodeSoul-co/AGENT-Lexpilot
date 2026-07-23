const assert = require('node:assert/strict');
const test = require('node:test');
const { compareFactsToLaw } = require('../src/v0/law-comparison-engine.cjs');

function reference(id, legalDomain) {
  return { id, legalDomain };
}

test('compares structured facts with each verified reference without making a conclusion', () => {
  const cases = [
    {
      legalDomain: 'labor',
      knownFacts: { employmentDuration: 'mentioned', writtenContractStatus: 'not_signed' },
      redactedMessages: ['[NAME_1]在公司工作3年，没有签劳动合同。'],
      lawReference: reference('cn.labor-contract-law.article-82', 'labor')
    },
    {
      legalDomain: 'private_lending',
      knownFacts: {
        evidenceStatus: 'available',
        repaymentTermStatus: 'agreed',
        repaymentStatus: 'unpaid'
      },
      redactedMessages: ['朋友借钱不还，有转账记录，说好去年还款。'],
      lawReference: reference('cn.civil-code.article-675', 'private_lending')
    },
    {
      legalDomain: 'taxation',
      knownFacts: {
        taxpayerType: 'company',
        taxIssueType: 'filing',
        taxPeriod: 'mentioned'
      },
      redactedMessages: ['公司2025年没有办理纳税申报。'],
      lawReference: reference(
        'cn.tax-collection-administration-law.article-25',
        'taxation'
      )
    },
    {
      legalDomain: 'intellectual_property',
      knownFacts: {
        rightType: 'patent',
        allegedAct: 'sale',
        authorizationStatus: 'not_authorized'
      },
      redactedMessages: ['对方未经许可销售我的专利产品。'],
      lawReference: reference('cn.patent-law.article-11', 'intellectual_property')
    }
  ];

  for (const item of cases) {
    const result = compareFactsToLaw({
      piiRedacted: true,
      legalDomain: item.legalDomain,
      knownFacts: item.knownFacts,
      redactedMessages: item.redactedMessages,
      lawReferences: [item.lawReference]
    });
    const comparison = result.comparisons[0];
    assert.equal(result.status, 'completed');
    assert.equal(comparison.comparisonStatus, 'potential_match');
    assert.equal(comparison.legalConclusionGenerated, false);
    assert.ok(comparison.sanitizedFactExcerpt.length > 0);
    assert.ok(comparison.unresolvedElements.length > 0);
  }
});

test('marks conflicting fact values as not supported instead of a potential match', () => {
  const result = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'private_lending',
    knownFacts: {
      evidenceStatus: 'available',
      repaymentTermStatus: 'agreed',
      repaymentStatus: 'paid'
    },
    redactedMessages: ['借款已经还清。'],
    lawReferences: [reference('cn.civil-code.article-675', 'private_lending')]
  });

  assert.equal(result.comparisons[0].comparisonStatus, 'not_supported_by_facts');
  assert.ok(result.comparisons[0].unresolvedElements.includes('fact_not_supporting:repaymentStatus'));
});

test('fails closed for raw envelopes and cross-domain references', () => {
  const baseInput = {
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: {},
    redactedMessages: ['脱敏文本'],
    lawReferences: [reference('cn.labor-contract-law.article-82', 'labor')]
  };

  assert.throws(() => compareFactsToLaw({ ...baseInput, piiRedacted: false }), /sanitized/);
  assert.throws(
    () =>
      compareFactsToLaw({
        ...baseInput,
        lawReferences: [reference('cn.civil-code.article-675', 'private_lending')]
      }),
    /same-domain/
  );
});

test('trace contains counts only and excludes excerpts and matched facts', () => {
  const result = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: { employmentDuration: 'mentioned', writtenContractStatus: 'not_signed' },
    redactedMessages: ['[NAME_1]工作3年，没有签劳动合同。'],
    lawReferences: [reference('cn.labor-contract-law.article-82', 'labor')]
  });
  const trace = JSON.stringify(result.trace);

  assert.equal(trace.includes('[NAME_1]'), false);
  assert.equal(trace.includes('writtenContractStatus'), false);
  assert.equal(trace.includes('没有签劳动合同'), false);
});

test('marks fully supported facts with an unverifiable excerpt as insufficient instead of unsupported', () => {
  const result = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: { employmentDuration: 'mentioned', writtenContractStatus: 'not_signed' },
    redactedMessages: ['[NAME_1][PHONE_1][PHONE_1]'],
    lawReferences: [reference('cn.labor-contract-law.article-82', 'labor')]
  });
  const comparison = result.comparisons[0];

  assert.equal(comparison.comparisonStatus, 'insufficient_for_comparison');
  assert.equal(comparison.sanitizedFactExcerpt, '');
  assert.deepEqual(comparison.matchedFacts, [
    { field: 'employmentDuration', value: 'mentioned' },
    { field: 'writtenContractStatus', value: 'not_signed' }
  ]);
  assert.ok(comparison.unresolvedElements.includes('fact_excerpt_not_verifiable'));
});

test('compares Article 40 only when the declared dismissal branch facts are complete', () => {
  const result = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: {
      issueType: 'dismissal',
      dismissalGround: 'performance',
      noticeOrPayStatus: 'neither',
      performanceRemediationOutcome: 'no_training_or_adjustment'
    },
    redactedMessages: ['公司说我不能胜任工作后辞退我，没有提前三十天书面通知，也没有多给一个月工资。'],
    lawReferences: [reference('cn.labor-contract-law.article-40', 'labor')]
  });
  const comparison = result.comparisons[0];

  assert.equal(comparison.comparisonStatus, 'potential_match');
  assert.equal(comparison.legalConclusionGenerated, false);
  assert.ok(comparison.sanitizedFactExcerpt.length > 0);
  assert.deepEqual(comparison.matchedFacts, [
    { field: 'issueType', value: 'dismissal' },
    { field: 'dismissalGround', value: 'performance' },
    { field: 'noticeOrPayStatus', value: 'neither' },
    { field: 'performanceRemediationOutcome', value: 'no_training_or_adjustment' }
  ]);
  assert.ok(comparison.unresolvedElements.length > 0);
});

test('keeps Article 40 insufficient when branch facts are missing or the excerpt is unverifiable', () => {
  const missingFacts = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: { issueType: 'dismissal', dismissalGround: 'performance' },
    redactedMessages: ['公司辞退我。'],
    lawReferences: [reference('cn.labor-contract-law.article-40', 'labor')]
  });
  const missingComparison = missingFacts.comparisons[0];

  assert.equal(missingComparison.comparisonStatus, 'insufficient_for_comparison');
  assert.ok(missingComparison.unresolvedElements.includes('missing_fact:noticeOrPayStatus'));
  assert.ok(
    missingComparison.unresolvedElements.includes('missing_fact:performanceRemediationOutcome')
  );

  const missingExcerpt = compareFactsToLaw({
    piiRedacted: true,
    legalDomain: 'labor',
    knownFacts: {
      issueType: 'dismissal',
      dismissalGround: 'performance',
      noticeOrPayStatus: 'neither',
      performanceRemediationOutcome: 'no_training_or_adjustment'
    },
    redactedMessages: ['[NAME_1][PHONE_1]'],
    lawReferences: [reference('cn.labor-contract-law.article-40', 'labor')]
  });
  const excerptComparison = missingExcerpt.comparisons[0];

  assert.equal(excerptComparison.comparisonStatus, 'insufficient_for_comparison');
  assert.equal(excerptComparison.sanitizedFactExcerpt, '');
  assert.ok(excerptComparison.unresolvedElements.includes('fact_excerpt_not_verifiable'));
});

test('does not force Article 40 onto a non-dismissal issue or another declared ground', () => {
  const cases = [
    { issueType: 'unpaid_wages' },
    { issueType: 'dismissal', dismissalGround: 'other', noticeOrPayStatus: 'neither' }
  ];

  for (const knownFacts of cases) {
    const result = compareFactsToLaw({
      piiRedacted: true,
      legalDomain: 'labor',
      knownFacts,
      redactedMessages: ['公司辞退我。'],
      lawReferences: [reference('cn.labor-contract-law.article-40', 'labor')]
    });
    assert.equal(result.comparisons[0].comparisonStatus, 'not_supported_by_facts');
    assert.equal(result.comparisons[0].legalConclusionGenerated, false);
  }
});
