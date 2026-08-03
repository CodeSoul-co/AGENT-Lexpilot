const assert = require('node:assert/strict');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { verifyOfficialLawSources } = require('../src/v0/law-source-verifier.cjs');

function officialPages(corpus) {
  const pages = new Map();
  for (const entry of corpus.entries) {
    const existing = pages.get(entry.source.textUrl) ?? '';
    pages.set(
      entry.source.textUrl,
      `${existing}<h1>${entry.lawName}</h1><h2>${entry.articleNumber}</h2><p>${entry.articleText}</p>`
    );
  }
  return pages;
}

function response({ url, body = '', ok = true, status = 200 }) {
  return { url, ok, status, text: async () => body };
}

test('verifies every pinned article while fetching unique official pages sequentially', async () => {
  const corpus = loadLawCorpus();
  const pages = officialPages(corpus);
  const calls = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const report = await verifyOfficialLawSources(corpus, {
    checkedAt: new Date('2026-07-20T08:00:00.000Z'),
    fetchImpl: async (url) => {
      calls.push(url);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return response({ url, body: pages.get(url) });
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'verified');
  assert.equal(report.entryCount, 46);
  assert.equal(report.sourceCount, 4);
  assert.equal(report.verifiedCount, 46);
  assert.equal(calls.length, 4);
  assert.equal(maxActiveRequests, 1);
  assert.equal(report.requestAttemptCount, 4);
  assert.equal(report.results.every((result) => result.attemptCount === 1), true);
  assert.equal(report.results.every((result) => result.status === 'verified'), true);
  assert.equal(JSON.stringify(report).includes(corpus.entries[0].articleText), false);
});

test('retries only an unavailable source and records bounded request attempts', async () => {
  const corpus = loadLawCorpus();
  const pages = officialPages(corpus);
  const retryUrl = corpus.entries[0].source.textUrl;
  const callsByUrl = new Map();
  const waits = [];
  const report = await verifyOfficialLawSources(corpus, {
    maxAttempts: 3,
    retryDelayMs: 25,
    waitImpl: async (delayMs) => waits.push(delayMs),
    fetchImpl: async (url) => {
      const callCount = (callsByUrl.get(url) ?? 0) + 1;
      callsByUrl.set(url, callCount);
      if (url === retryUrl && callCount === 1) {
        return response({ url, ok: false, status: 503 });
      }
      return response({ url, body: pages.get(url) });
    }
  });

  assert.equal(report.ok, true);
  assert.equal(callsByUrl.get(retryUrl), 2);
  assert.equal(report.requestAttemptCount, 5);
  assert.deepEqual(waits, [25]);
  assert.equal(report.results[0].attemptCount, 2);
  assert.equal(report.results[1].attemptCount, 2);
});

test('does not retry a non-official redirect', async () => {
  const corpus = loadLawCorpus();
  let calls = 0;
  const report = await verifyOfficialLawSources(corpus, {
    maxAttempts: 3,
    fetchImpl: async (url) => {
      calls += 1;
      return response({ url: 'https://example.com/law', body: officialPages(corpus).get(url) });
    }
  });

  assert.equal(report.ok, false);
  assert.equal(calls, report.sourceCount);
  assert.equal(report.requestAttemptCount, report.sourceCount);
  assert.equal(report.results.every((result) => result.status === 'untrusted_redirect'), true);
});

test('does not retry a permanent HTTP source failure', async () => {
  const corpus = loadLawCorpus();
  let calls = 0;
  const report = await verifyOfficialLawSources(corpus, {
    maxAttempts: 3,
    fetchImpl: async (url) => {
      calls += 1;
      return response({ url, ok: false, status: 404 });
    }
  });

  assert.equal(report.ok, false);
  assert.equal(calls, report.sourceCount);
  assert.equal(report.requestAttemptCount, report.sourceCount);
  assert.equal(report.results.every((result) => result.status === 'source_unavailable'), true);
  assert.equal(report.results.every((result) => result.attemptCount === 1), true);
});

test('detects a changed article without logging source content', async () => {
  const corpus = loadLawCorpus();
  const pages = officialPages(corpus);
  const changed = corpus.entries[0];
  pages.set(changed.source.textUrl, `<h1>${changed.lawName}</h1><h2>${changed.articleNumber}</h2><p>正文已变化</p>`);

  const report = await verifyOfficialLawSources(corpus, {
    fetchImpl: async (url) => response({ url, body: pages.get(url) })
  });
  const result = report.results.find((item) => item.id === changed.id);

  assert.equal(report.ok, false);
  assert.equal(result.status, 'content_mismatch');
  assert.deepEqual(result.missingFields, ['articleText']);
  assert.equal(JSON.stringify(report).includes('正文已变化'), false);
});

test('fails closed for unavailable sources and non-official redirects', async () => {
  const corpus = loadLawCorpus();
  const pages = officialPages(corpus);
  const unavailableUrl = corpus.entries[0].source.textUrl;
  const redirectedUrl = corpus.entries.find(
    (entry) => entry.id === 'cn.civil-code.article-1042'
  ).source.textUrl;
  const report = await verifyOfficialLawSources(corpus, {
    fetchImpl: async (url) => {
      if (url === unavailableUrl) return response({ url, ok: false, status: 503 });
      if (url === redirectedUrl) {
        return response({ url: 'https://example.com/law', body: pages.get(url) });
      }
      return response({ url, body: pages.get(url) });
    }
  });

  assert.equal(report.ok, false);
  const laborResults = report.results.filter((result) =>
    result.id.startsWith('cn.labor-contract-law.')
  );
  const civilResults = report.results.filter((result) => result.id.startsWith('cn.civil-code.'));
  assert.equal(laborResults.length, 10);
  assert.equal(laborResults.every((result) => result.status === 'source_unavailable'), true);
  assert.equal(civilResults.length, 18);
  assert.equal(civilResults.every((result) => result.status === 'untrusted_redirect'), true);
  assert.equal(civilResults.every((result) => result.finalHost === 'example.com'), true);
});

test('fails closed when a source request throws', async () => {
  const corpus = loadLawCorpus();
  const report = await verifyOfficialLawSources(corpus, {
    fetchImpl: async () => {
      throw new Error('network details must not escape');
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.verifiedCount, 0);
  assert.equal(report.requestAttemptCount, report.sourceCount * 2);
  assert.equal(report.results.every((result) => result.status === 'source_unavailable'), true);
  assert.equal(report.results.every((result) => result.attemptCount === 2), true);
  assert.equal(JSON.stringify(report).includes('network details'), false);
});

test('rejects invalid verifier dependencies', async () => {
  const corpus = loadLawCorpus();
  await assert.rejects(
    () => verifyOfficialLawSources(corpus, { fetchImpl: null }),
    /fetchImpl 必须是函数/
  );
  await assert.rejects(
    () => verifyOfficialLawSources(corpus, { checkedAt: new Date('invalid') }),
    /checkedAt 必须是有效 Date/
  );
  await assert.rejects(
    () => verifyOfficialLawSources(corpus, { maxAttempts: 0 }),
    /maxAttempts 必须是 1 到 5 的整数/
  );
  await assert.rejects(
    () => verifyOfficialLawSources(corpus, { retryDelayMs: -1 }),
    /retryDelayMs 必须是 0 到 10000 的整数/
  );
  await assert.rejects(
    () => verifyOfficialLawSources(corpus, { waitImpl: null }),
    /waitImpl 必须是函数/
  );
});
