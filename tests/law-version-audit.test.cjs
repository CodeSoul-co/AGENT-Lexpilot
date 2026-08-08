const assert = require('node:assert/strict');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { auditLawVersions } = require('../src/v0/law-version-audit.cjs');

test('confirms all 100 entries are effective at the 2026-08-08 verification baseline', () => {
  const report = auditLawVersions(loadLawCorpus(), { asOf: '2026-08-08' });
  assert.equal(report.ok, true);
  assert.equal(report.currentCount, 100);
  assert.equal(report.invalidCount, 0);
});

test('rejects a version that has already expired or a future version already in force', () => {
  const corpus = structuredClone(loadLawCorpus());
  corpus.entries[0].effectiveUntil = '2026-08-07';
  corpus.entries[1].futureVersion = {
    effectiveDate: '2026-08-08',
    url: 'https://www.samr.gov.cn/future'
  };
  const report = auditLawVersions(corpus, { asOf: '2026-08-08' });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].problems.includes('expired_before_as_of'), true);
  assert.equal(report.results[1].problems.includes('future_version_already_effective'), true);
});
