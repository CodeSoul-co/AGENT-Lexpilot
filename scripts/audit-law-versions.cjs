const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { auditLawVersions } = require('../src/v0/law-version-audit.cjs');

const index = process.argv.indexOf('--as-of');
const asOf = index >= 0 ? process.argv[index + 1] : '2026-08-08';

try {
  const report = auditLawVersions(loadLawCorpus(), { asOf });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Law version audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
