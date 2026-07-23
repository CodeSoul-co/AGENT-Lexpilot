const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { auditLawCorpusCoverage } = require('../src/v0/law-corpus-coverage.cjs');

function main() {
  const report = auditLawCorpusCoverage(loadLawCorpus());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
