const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  restoreVerifiedReplayFixtures,
  runLegalReplayRegression
} = require('../src/replay/legal-replay-regression.cjs');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const regression = await runLegalReplayRegression({ projectRoot });
  if (regression.result.status !== 'passed') {
    throw new Error('Replay regression did not pass.');
  }
  const recoveryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lexpilot-replay-recovery-')
  );
  try {
    const recovery = await restoreVerifiedReplayFixtures({
      projectRoot,
      targetDirectory: recoveryDirectory
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          manifestId: regression.manifestId,
          regressionStatus: regression.result.status,
          regressionSummary: regression.result.summary,
          traceCompletenessStatus: regression.traceCompletenessStatus,
          recoveredFixtureCount: recovery.restoredCount,
          sensitiveDataStored: false,
          hyphaSourceModified: false
        },
        null,
        2
      )}\n`
    );
  } finally {
    await fs.rm(recoveryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Replay verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
