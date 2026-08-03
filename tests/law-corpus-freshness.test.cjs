const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const {
  DEFAULT_MAX_VERIFICATION_AGE_DAYS,
  auditLawCorpusFreshness
} = require('../src/v0/law-corpus-freshness.cjs');

test('accepts a corpus verified within the daily freshness window', () => {
  const corpus = loadLawCorpus();
  const sameDay = auditLawCorpusFreshness(corpus, {
    asOf: new Date('2026-08-03T23:59:59.999Z')
  });
  const nextDay = auditLawCorpusFreshness(corpus, {
    asOf: new Date('2026-08-04T23:59:59.999Z')
  });

  assert.equal(DEFAULT_MAX_VERIFICATION_AGE_DAYS, 1);
  assert.equal(sameDay.status, 'fresh');
  assert.equal(sameDay.ageDays, 0);
  assert.equal(nextDay.status, 'fresh');
  assert.equal(nextDay.ageDays, 1);
  assert.equal(nextDay.requiresSourceRefresh, false);
});

test('marks an overdue corpus stale without changing its verification date', () => {
  const corpus = loadLawCorpus();
  const report = auditLawCorpusFreshness(corpus, {
    asOf: new Date('2026-08-05T00:00:00.000Z')
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'stale');
  assert.equal(report.ageDays, 2);
  assert.equal(report.verifiedAt, '2026-08-03');
  assert.equal(report.requiresSourceRefresh, true);
});

test('rejects a future-dated verification record', () => {
  const report = auditLawCorpusFreshness(loadLawCorpus(), {
    asOf: new Date('2026-08-02T00:00:00.000Z')
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'future_dated');
  assert.equal(report.ageDays, -1);
  assert.equal(report.requiresSourceRefresh, true);
});

test('rejects invalid audit options', () => {
  const corpus = loadLawCorpus();
  assert.throws(
    () => auditLawCorpusFreshness(corpus, { asOf: new Date('invalid') }),
    /asOf 必须是有效 Date/
  );
  assert.throws(
    () => auditLawCorpusFreshness(corpus, { maxVerificationAgeDays: -1 }),
    /maxVerificationAgeDays 必须是非负整数/
  );
});

test('provides a reproducible local audit command with a failing stale exit code', () => {
  const script = path.resolve(__dirname, '..', 'scripts', 'audit-law-corpus.cjs');
  const fresh = spawnSync(process.execPath, [script, '--as-of', '2026-08-03'], {
    encoding: 'utf8'
  });
  const stale = spawnSync(process.execPath, [script, '--as-of', '2026-08-05'], {
    encoding: 'utf8'
  });

  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).status, 'fresh');
  assert.equal(fresh.stdout.includes('articleText'), false);
  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).status, 'stale');
});
