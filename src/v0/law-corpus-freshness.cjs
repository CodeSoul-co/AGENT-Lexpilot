const { validateLawCorpus } = require('./law-corpus.cjs');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_VERIFICATION_AGE_DAYS = 1;

function utcDay(value, fieldName) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} 必须是有效 Date。`);
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function auditLawCorpusFreshness(
  corpus,
  { asOf = new Date(), maxVerificationAgeDays = DEFAULT_MAX_VERIFICATION_AGE_DAYS } = {}
) {
  if (!Number.isInteger(maxVerificationAgeDays) || maxVerificationAgeDays < 0) {
    throw new TypeError('maxVerificationAgeDays 必须是非负整数。');
  }

  const validated = validateLawCorpus(corpus);
  const asOfDay = utcDay(asOf, 'asOf');
  const verifiedDay = Date.parse(`${validated.verifiedAt}T00:00:00.000Z`);
  const ageDays = Math.trunc((asOfDay - verifiedDay) / MS_PER_DAY);
  const status =
    ageDays < 0 ? 'future_dated' : ageDays > maxVerificationAgeDays ? 'stale' : 'fresh';

  return {
    ok: status === 'fresh',
    status,
    corpusId: validated.corpusId,
    corpusVersion: validated.version,
    verifiedAt: validated.verifiedAt,
    asOfDate: new Date(asOfDay).toISOString().slice(0, 10),
    ageDays,
    maxVerificationAgeDays,
    entryCount: validated.entries.length,
    requiresSourceRefresh: status !== 'fresh'
  };
}

module.exports = {
  DEFAULT_MAX_VERIFICATION_AGE_DAYS,
  auditLawCorpusFreshness
};
