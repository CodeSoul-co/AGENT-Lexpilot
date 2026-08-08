const { validateLawCorpus } = require('./law-corpus.cjs');

function dateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} is invalid.`);
  return parsed;
}

function auditLawVersions(corpus, { asOf = '2026-08-08' } = {}) {
  const checkedCorpus = validateLawCorpus(corpus);
  const asOfDate = dateOnly(asOf, 'asOf');
  const results = checkedCorpus.entries.map((entry) => {
    const problems = [];
    if (entry.status !== 'effective') problems.push('not_effective');
    if (dateOnly(entry.publicationDate, 'publicationDate') > asOfDate) problems.push('publication_after_as_of');
    if (dateOnly(entry.effectiveDate, 'effectiveDate') > asOfDate) problems.push('effective_after_as_of');
    if (dateOnly(entry.verifiedAt, 'verifiedAt') > asOfDate) problems.push('verified_after_as_of');
    if (entry.effectiveUntil && dateOnly(entry.effectiveUntil, 'effectiveUntil') < asOfDate) {
      problems.push('expired_before_as_of');
    }
    if (entry.futureVersion && dateOnly(entry.futureVersion.effectiveDate, 'futureVersion.effectiveDate') <= asOfDate) {
      problems.push('future_version_already_effective');
    }
    for (const url of [entry.source.metadataUrl, entry.source.textUrl]) {
      if (!url.startsWith('https://')) problems.push('non_https_source');
    }
    return { id: entry.id, status: problems.length === 0 ? 'current' : 'invalid', problems };
  });
  const currentCount = results.filter((result) => result.status === 'current').length;
  return {
    ok: currentCount === results.length,
    status: currentCount === results.length ? 'current' : 'invalid',
    asOf,
    entryCount: results.length,
    currentCount,
    invalidCount: results.length - currentCount,
    results
  };
}

module.exports = { auditLawVersions };
