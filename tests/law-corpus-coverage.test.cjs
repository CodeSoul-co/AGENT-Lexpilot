const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const {
  DEFAULT_TARGET_UNIQUE_ARTICLES,
  auditLawCorpusCoverage
} = require('../src/v0/law-corpus-coverage.cjs');

function corpusWithEntries(entries) {
  return { ...loadLawCorpus(), entries };
}

test('reports the staged six-article corpus as 6/100 without exposing law text', () => {
  const corpus = loadLawCorpus();
  const report = auditLawCorpusCoverage(corpus);
  const serialized = JSON.stringify(report);

  assert.equal(DEFAULT_TARGET_UNIQUE_ARTICLES, 100);
  assert.equal(report.ok, false);
  assert.equal(report.status, 'insufficient_coverage');
  assert.equal(report.entryCount, 6);
  assert.equal(report.uniqueArticleCount, 6);
  assert.equal(report.duplicateCitationCount, 0);
  assert.equal(report.missingUniqueArticleCount, 94);
  assert.deepEqual(report.missingDomains, []);
  assert.deepEqual(Object.values(report.domainCounts), [2, 1, 1, 1, 1]);
  assert.equal(serialized.includes('articleText'), false);
  assert.equal(serialized.includes(corpus.entries[0].lawName), false);
});

test('does not count duplicate citations toward the 100-article gate', () => {
  const baseEntries = loadLawCorpus().entries;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(baseEntries[index % baseEntries.length]),
    id: `duplicate-entry-${index + 1}`
  }));
  const report = auditLawCorpusCoverage(corpusWithEntries(entries));

  assert.equal(report.status, 'insufficient_coverage');
  assert.equal(report.entryCount, 100);
  assert.equal(report.uniqueArticleCount, 6);
  assert.equal(report.duplicateCitationCount, 94);
  assert.equal(report.missingUniqueArticleCount, 94);
});

test('normalizes citation whitespace and full-width characters before deduplication', () => {
  const base = structuredClone(loadLawCorpus().entries[0]);
  base.lawName = `${base.lawName}A`;
  const duplicate = {
    ...structuredClone(base),
    id: 'normalized-duplicate',
    lawName: `  ${base.lawName.slice(0, -1)}Ａ  `,
    articleNumber: `  ${base.articleNumber}  `
  };
  const report = auditLawCorpusCoverage(corpusWithEntries([base, duplicate]), {
    targetUniqueArticles: 2
  });

  assert.equal(report.uniqueArticleCount, 1);
  assert.equal(report.duplicateCitationCount, 1);
  assert.equal(report.missingUniqueArticleCount, 1);
});

test('accepts 100 unique citations with all five domains represented', () => {
  const corpusEntries = loadLawCorpus().entries;
  const baseEntries = [...new Set(corpusEntries.map((entry) => entry.legalDomain))].map(
    (domain) => corpusEntries.find((entry) => entry.legalDomain === domain)
  );
  const entries = Array.from({ length: 100 }, (_, index) => {
    const base = structuredClone(baseEntries[index % baseEntries.length]);
    return {
      ...base,
      id: `unique-entry-${index + 1}`,
      articleNumber: `${base.articleNumber}-验收-${index + 1}`
    };
  });
  const report = auditLawCorpusCoverage(corpusWithEntries(entries));

  assert.equal(report.ok, true);
  assert.equal(report.status, 'ready');
  assert.equal(report.uniqueArticleCount, 100);
  assert.equal(report.duplicateCitationCount, 0);
  assert.equal(report.missingUniqueArticleCount, 0);
  assert.deepEqual(Object.values(report.domainCounts), [20, 20, 20, 20, 20]);
});

test('reports missing domains before total coverage', () => {
  const entry = structuredClone(loadLawCorpus().entries[0]);
  const report = auditLawCorpusCoverage(corpusWithEntries([entry]));

  assert.equal(report.ok, false);
  assert.equal(report.status, 'missing_domains');
  assert.equal(report.missingDomains.length, 4);
  assert.equal(report.missingDomains.includes(entry.legalDomain), false);
});

test('rejects invalid coverage targets', () => {
  const corpus = loadLawCorpus();
  for (const targetUniqueArticles of [0, -1, 1.5, '100']) {
    assert.throws(
      () => auditLawCorpusCoverage(corpus, { targetUniqueArticles }),
      /targetUniqueArticles 必须是正整数/
    );
  }
});

test('provides a local command that fails honestly at the current 6/100 coverage', () => {
  const script = path.resolve(__dirname, '..', 'scripts', 'audit-law-coverage.cjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.status, 'insufficient_coverage');
  assert.equal(report.uniqueArticleCount, 6);
  assert.equal(report.missingUniqueArticleCount, 94);
  assert.equal(result.stdout.includes('articleText'), false);
});
