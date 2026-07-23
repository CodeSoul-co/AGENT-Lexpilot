const { OFFICIAL_SOURCE_HOSTS, validateLawCorpus } = require('./law-corpus.cjs');

const ALLOWED_METADATA_KEYS = new Set([
  'sourceUrl',
  'lawName',
  'publicationDate',
  'effectiveDate',
  'status'
]);
const ALLOWED_STATUSES = new Set(['not_effective', 'effective', 'modified', 'repealed']);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function inspectProviderResult(value, requestedUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid_metadata_response' };
  }
  if (Object.keys(value).some((key) => !ALLOWED_METADATA_KEYS.has(key))) {
    return { status: 'invalid_metadata_response' };
  }
  if (
    typeof value.sourceUrl !== 'string' ||
    typeof value.lawName !== 'string' ||
    value.lawName.trim().length === 0 ||
    !validDate(value.publicationDate) ||
    !validDate(value.effectiveDate) ||
    !ALLOWED_STATUSES.has(value.status)
  ) {
    return { status: 'invalid_metadata_response' };
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(value.sourceUrl);
  } catch {
    return { status: 'untrusted_metadata_source' };
  }
  const requestedHost = new URL(requestedUrl).hostname;
  if (
    sourceUrl.protocol !== 'https:' ||
    !OFFICIAL_SOURCE_HOSTS.has(sourceUrl.hostname) ||
    sourceUrl.hostname !== requestedHost
  ) {
    return { status: 'untrusted_metadata_source', finalHost: sourceUrl.hostname };
  }
  return {
    status: 'received',
    finalHost: sourceUrl.hostname,
    metadata: {
      lawName: value.lawName,
      publicationDate: value.publicationDate,
      effectiveDate: value.effectiveDate,
      status: value.status
    }
  };
}

async function requestMetadata(metadataUrl, metadataProvider) {
  try {
    return inspectProviderResult(await metadataProvider({ metadataUrl }), metadataUrl);
  } catch {
    return { status: 'metadata_unavailable' };
  }
}

async function verifyOfficialLawMetadata(
  corpus,
  { metadataProvider, checkedAt = new Date() } = {}
) {
  if (typeof metadataProvider !== 'function') {
    throw new TypeError('metadataProvider 必须是函数。');
  }
  if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
    throw new TypeError('checkedAt 必须是有效 Date。');
  }

  const validated = validateLawCorpus(corpus);
  const urls = [...new Set(validated.entries.map((entry) => entry.source.metadataUrl))];
  const received = await Promise.all(
    urls.map(async (url) => [url, await requestMetadata(url, metadataProvider)])
  );
  const metadataByUrl = new Map(received);
  const results = validated.entries.map((entry) => {
    const receivedMetadata = metadataByUrl.get(entry.source.metadataUrl);
    if (receivedMetadata.status !== 'received') {
      return {
        id: entry.id,
        status: receivedMetadata.status,
        finalHost: receivedMetadata.finalHost
      };
    }

    const expected = {
      lawName: entry.lawName,
      publicationDate: entry.publicationDate,
      effectiveDate: entry.effectiveDate,
      status: entry.status
    };
    const mismatchedFields = Object.entries(expected)
      .filter(([field, value]) => receivedMetadata.metadata[field] !== value)
      .map(([field]) => field);
    return {
      id: entry.id,
      status: mismatchedFields.length === 0 ? 'verified' : 'metadata_mismatch',
      finalHost: receivedMetadata.finalHost,
      ...(mismatchedFields.length > 0 ? { mismatchedFields } : {})
    };
  });
  const verifiedCount = results.filter((result) => result.status === 'verified').length;

  return {
    ok: verifiedCount === results.length,
    status: verifiedCount === results.length ? 'verified' : 'failed',
    corpusId: validated.corpusId,
    corpusVersion: validated.version,
    checkedAt: checkedAt.toISOString(),
    entryCount: validated.entries.length,
    sourceCount: urls.length,
    verifiedCount,
    results
  };
}

module.exports = { verifyOfficialLawMetadata };
