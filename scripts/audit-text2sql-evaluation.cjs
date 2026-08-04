const fs = require('node:fs');
const path = require('node:path');
const { planConstrainedText2Sql } = require('../src/v1/constrained-text2sql-planner.cjs');
const { runText2SqlEvaluation } = require('../src/v1/text2sql-evaluation.cjs');

const manifestPath = path.join(
  __dirname,
  '..',
  'configs',
  'evaluations',
  'legal-v1-text2sql.json'
);

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = runText2SqlEvaluation(manifest, { planner: planConstrainedText2Sql });
  const report = {
    ...result,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch
    }
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: 'TEXT2SQL_EVALUATION_INVALID', message: error.message })}\n`
  );
  process.exitCode = 1;
}
