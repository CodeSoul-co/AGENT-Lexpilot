const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { verifyOfficialLawSources } = require('../src/v0/law-source-verifier.cjs');

const SOURCE_TIMEOUT_MS = 15_000;
const SOURCE_MAX_ATTEMPTS = 3;
const SOURCE_RETRY_DELAY_MS = 500;

async function main() {
  const report = await verifyOfficialLawSources(loadLawCorpus(), {
    maxAttempts: SOURCE_MAX_ATTEMPTS,
    retryDelayMs: SOURCE_RETRY_DELAY_MS,
    fetchImpl: (url) =>
      fetch(url, {
        cache: 'no-store',
        headers: { 'user-agent': 'LexPilot-law-corpus-refresh/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
      })
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
