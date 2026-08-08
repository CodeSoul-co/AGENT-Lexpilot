const assert = require('node:assert/strict');
const test = require('node:test');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { verifyOfficialLawMetadata } = require('../src/v0/law-metadata-verifier.cjs');

function metadataByUrl(corpus) {
  const metadata = new Map();
  for (const entry of corpus.entries) {
    if (metadata.has(entry.source.metadataUrl)) continue;
    metadata.set(entry.source.metadataUrl, {
      sourceUrl: entry.source.metadataUrl,
      lawName: entry.lawName,
      publicationDate: entry.publicationDate,
      effectiveDate: entry.effectiveDate,
      status: entry.status
    });
  }
  return metadata;
}

test('verifies pinned metadata while requesting each shared law once', async () => {
  const corpus = loadLawCorpus();
  const metadata = metadataByUrl(corpus);
  const calls = [];
  const report = await verifyOfficialLawMetadata(corpus, {
    checkedAt: new Date('2026-07-20T08:00:00.000Z'),
    metadataProvider: async ({ metadataUrl }) => {
      calls.push(metadataUrl);
      return metadata.get(metadataUrl);
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'verified');
  assert.equal(report.entryCount, corpus.entries.length);
  assert.equal(report.sourceCount, metadata.size);
  assert.equal(report.verifiedCount, corpus.entries.length);
  assert.equal(calls.length, metadata.size);
  assert.equal(report.results.every((result) => result.status === 'verified'), true);
});

test('reports version and effectivity changes without accepting them', async () => {
  const corpus = loadLawCorpus();
  const metadata = metadataByUrl(corpus);
  const patent = corpus.entries.find((entry) => entry.id === 'cn.patent-law.article-11');
  metadata.set(patent.source.metadataUrl, {
    ...metadata.get(patent.source.metadataUrl),
    publicationDate: '2026-07-20',
    status: 'modified'
  });

  const report = await verifyOfficialLawMetadata(corpus, {
    metadataProvider: async ({ metadataUrl }) => metadata.get(metadataUrl)
  });
  const result = report.results.find((item) => item.id === patent.id);

  assert.equal(report.ok, false);
  assert.equal(result.status, 'metadata_mismatch');
  assert.deepEqual(result.mismatchedFields, ['publicationDate', 'status']);
  assert.equal(patent.publicationDate, '2020-10-17');
  assert.equal(patent.status, 'effective');
});

test('rejects undeclared provider fields and untrusted metadata sources', async () => {
  const corpus = loadLawCorpus();
  const metadata = metadataByUrl(corpus);
  const firstUrl = corpus.entries[0].source.metadataUrl;
  const civilUrl = corpus.entries.find(
    (entry) => entry.id === 'cn.civil-code.article-1042'
  ).source.metadataUrl;
  const report = await verifyOfficialLawMetadata(corpus, {
    metadataProvider: async ({ metadataUrl }) => {
      if (metadataUrl === firstUrl) return { ...metadata.get(metadataUrl), rawHtml: 'not allowed' };
      if (metadataUrl === civilUrl) {
        return { ...metadata.get(metadataUrl), sourceUrl: 'https://www.samr.gov.cn/law' };
      }
      return metadata.get(metadataUrl);
    }
  });

  assert.equal(report.ok, false);
  const laborResults = report.results.filter((result) =>
    result.id.startsWith('cn.labor-contract-law.')
  );
  const civilResults = report.results.filter((result) => result.id.startsWith('cn.civil-code.'));
  assert.equal(laborResults.length, corpus.entries.filter((entry) => entry.id.startsWith('cn.labor-contract-law.')).length);
  assert.equal(laborResults.every((result) => result.status === 'invalid_metadata_response'), true);
  assert.equal(civilResults.length, corpus.entries.filter((entry) => entry.id.startsWith('cn.civil-code.')).length);
  assert.equal(civilResults.every((result) => result.status === 'untrusted_metadata_source'), true);
  assert.equal(civilResults.every((result) => result.finalHost === 'www.samr.gov.cn'), true);
  assert.equal(JSON.stringify(report).includes('rawHtml'), false);
});

test('fails closed when the metadata provider is unavailable', async () => {
  const report = await verifyOfficialLawMetadata(loadLawCorpus(), {
    metadataProvider: async () => {
      throw new Error('provider details must not escape');
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.verifiedCount, 0);
  assert.equal(report.results.every((result) => result.status === 'metadata_unavailable'), true);
  assert.equal(JSON.stringify(report).includes('provider details'), false);
});

test('rejects invalid verifier dependencies', async () => {
  const corpus = loadLawCorpus();
  await assert.rejects(
    () => verifyOfficialLawMetadata(corpus),
    /metadataProvider 必须是函数/
  );
  await assert.rejects(
    () =>
      verifyOfficialLawMetadata(corpus, {
        metadataProvider: async () => ({}),
        checkedAt: new Date('invalid')
      }),
    /checkedAt 必须是有效 Date/
  );
});
