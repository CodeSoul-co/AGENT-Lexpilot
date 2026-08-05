const path = require('node:path');
const { loadLocalEnv } = require('./load-env.cjs');
const { resolveExecutionLogFilePath } = require('../src/v0/app-bootstrap.cjs');
const {
  ExecutionLogLifecycleError,
  createExecutionLogLifecycle
} = require('../src/v1/execution-log-lifecycle.cjs');

function printUsage() {
  process.stderr.write(
    [
      'Usage:',
      '  npm run manage:execution-log -- archive',
      '  npm run manage:execution-log -- verify <archiveId>',
      '  npm run manage:execution-log -- find-deletion <deletionOperationId>',
      '  npm run manage:execution-log -- delete-source <archiveId> DELETE_VERIFIED_EXECUTION_LOG_SOURCE',
      '  npm run manage:execution-log -- restore <archiveId>'
    ].join('\n') + '\n'
  );
}

function main(argv = process.argv.slice(2)) {
  const [command, archiveId, confirmation] = argv;
  const validCommand =
    (command === 'archive' && argv.length === 1) ||
    (command === 'verify' && argv.length === 2) ||
    (command === 'find-deletion' && argv.length === 2) ||
    (command === 'delete-source' && argv.length === 3) ||
    (command === 'restore' && argv.length === 2);
  if (!validCommand) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const projectRoot = path.resolve(__dirname, '..');
  loadLocalEnv(projectRoot);
  const filePath = resolveExecutionLogFilePath(
    projectRoot,
    process.env.LEGAL_SESSION_DATA_DIR,
    process.env.LEGAL_V1_EXECUTION_LOG_FILE
  );
  const archiveDirectory = path.resolve(
    projectRoot,
    process.env.LEGAL_V1_EXECUTION_LOG_ARCHIVE_DIR?.trim() ||
      path.join(path.dirname(filePath), 'v1-execution-log-archives')
  );
  const lifecycle = createExecutionLogLifecycle({
    filePath,
    archiveDirectory,
    deletionAuditRecoveryDirectory: path.join(
      path.dirname(filePath),
      'deletion-audit-recovery'
    )
  });
  let result;
  if (command === 'archive') {
    result = lifecycle.archive();
  } else if (command === 'verify') {
    result = lifecycle.verifyArchive(archiveId);
  } else if (command === 'find-deletion') {
    result = lifecycle.findDeletionAudit(archiveId);
  } else if (command === 'delete-source') {
    result = lifecycle.deleteSource({ archiveId, confirmation });
  } else {
    result = lifecycle.restoreSource(archiveId);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const safeMessage =
      error instanceof ExecutionLogLifecycleError || error instanceof TypeError
        ? error.message
        : 'Execution log maintenance failed.';
    process.stderr.write(
      `${JSON.stringify({ code: error?.code ?? 'EXECUTION_LOG_MAINTENANCE_FAILED', message: safeMessage })}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = { main };
