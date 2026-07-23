const { OFFICIAL_SOURCE_HOSTS, validateLawCorpus } = require('./law-corpus.cjs');

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ALLOWED_ATTEMPTS = 5;

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const numeric =
      code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number(code.slice(1));
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return entity;
    return String.fromCodePoint(numeric);
  });
}

function comparableText(value, { html = false } = {}) {
  let text = String(value);
  if (html) {
    text = text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    text = decodeHtmlEntities(text);
  }
  return text.normalize('NFKC').replace(/\s+/g, '');
}

async function fetchOfficialPage(url, fetchImpl) {
  try {
    const response = await fetchImpl(url);
    if (!response || typeof response.text !== 'function') {
      return { status: 'source_unavailable' };
    }

    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== 'https:' || !OFFICIAL_SOURCE_HOSTS.has(finalUrl.hostname)) {
      return {
        status: 'untrusted_redirect',
        httpStatus: Number.isInteger(response.status) ? response.status : undefined,
        finalHost: finalUrl.hostname
      };
    }
    if (!response.ok) {
      return {
        status: 'source_unavailable',
        httpStatus: Number.isInteger(response.status) ? response.status : undefined,
        finalHost: finalUrl.hostname
      };
    }

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_SOURCE_BYTES) {
      return {
        status: 'source_too_large',
        httpStatus: response.status,
        finalHost: finalUrl.hostname
      };
    }
    return {
      status: 'fetched',
      httpStatus: response.status,
      finalHost: finalUrl.hostname,
      comparableBody: comparableText(body, { html: true })
    };
  } catch {
    return { status: 'source_unavailable' };
  }
}

function isRetryableUnavailable(page) {
  if (page.status !== 'source_unavailable') return false;
  if (!Number.isInteger(page.httpStatus)) return true;
  return page.httpStatus === 408 || page.httpStatus === 429 || page.httpStatus >= 500;
}

async function fetchOfficialPageWithRetry(
  url,
  fetchImpl,
  { maxAttempts, retryDelayMs, waitImpl }
) {
  let page;
  for (let attemptCount = 1; attemptCount <= maxAttempts; attemptCount += 1) {
    page = await fetchOfficialPage(url, fetchImpl);
    if (!isRetryableUnavailable(page) || attemptCount === maxAttempts) {
      return { ...page, attemptCount };
    }
    if (retryDelayMs > 0) await waitImpl(retryDelayMs);
  }
  throw new Error('来源请求重试状态异常。');
}

async function verifyOfficialLawSources(
  corpus,
  {
    fetchImpl = globalThis.fetch,
    checkedAt = new Date(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = 0,
    waitImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  } = {}
) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数。');
  if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
    throw new TypeError('checkedAt 必须是有效 Date。');
  }
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ALLOWED_ATTEMPTS
  ) {
    throw new TypeError(`maxAttempts 必须是 1 到 ${MAX_ALLOWED_ATTEMPTS} 的整数。`);
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new TypeError('retryDelayMs 必须是 0 到 10000 的整数。');
  }
  if (typeof waitImpl !== 'function') throw new TypeError('waitImpl 必须是函数。');

  const validated = validateLawCorpus(corpus);
  const urls = [...new Set(validated.entries.map((entry) => entry.source.textUrl))];
  const fetchedPages = [];
  for (const url of urls) {
    const page = await fetchOfficialPageWithRetry(url, fetchImpl, {
      maxAttempts,
      retryDelayMs,
      waitImpl
    });
    fetchedPages.push([url, page]);
  }
  const pageByUrl = new Map(fetchedPages);
  const results = validated.entries.map((entry) => {
    const page = pageByUrl.get(entry.source.textUrl);
    if (page.status !== 'fetched') {
      return {
        id: entry.id,
        status: page.status,
        httpStatus: page.httpStatus,
        finalHost: page.finalHost,
        attemptCount: page.attemptCount
      };
    }

    const expected = {
      lawName: comparableText(entry.lawName),
      articleNumber: comparableText(entry.articleNumber),
      articleText: comparableText(entry.articleText)
    };
    const missingFields = Object.entries(expected)
      .filter(([, value]) => !page.comparableBody.includes(value))
      .map(([field]) => field);
    return {
      id: entry.id,
      status: missingFields.length === 0 ? 'verified' : 'content_mismatch',
      httpStatus: page.httpStatus,
      finalHost: page.finalHost,
      attemptCount: page.attemptCount,
      ...(missingFields.length > 0 ? { missingFields } : {})
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
    requestAttemptCount: fetchedPages.reduce((total, [, page]) => total + page.attemptCount, 0),
    verifiedCount,
    results
  };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  MAX_SOURCE_BYTES,
  comparableText,
  verifyOfficialLawSources
};
