const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { auditLawCorpusFreshness } = require('../src/v0/law-corpus-freshness.cjs');

function parseAsOf(args) {
  if (args.length === 0) return new Date();
  if (args.length !== 2 || args[0] !== '--as-of' || !/^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
    throw new Error('用法：npm run audit:law-corpus -- --as-of YYYY-MM-DD');
  }
  const parsed = new Date(`${args[1]}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args[1]) {
    throw new Error('--as-of 必须是有效日期。');
  }
  return parsed;
}

function main() {
  const report = auditLawCorpusFreshness(loadLawCorpus(), {
    asOf: parseAsOf(process.argv.slice(2))
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
