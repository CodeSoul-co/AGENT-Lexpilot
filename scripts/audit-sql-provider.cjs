const path = require('node:path');
const { loadLocalEnv } = require('./load-env.cjs');
const { createConfiguredNetworkDataSource } = require('../src/v1/network-data-source-config.cjs');
const { SQLITE_QUERY_PARAMETERS, SQLITE_QUERY_SQL } = require('../src/v1/sqlite-query-runtime.cjs');

const SUPPORTED_ENGINES = new Set(['mysql', 'postgresql']);

function safeAuditFailure(error) {
  const message = error instanceof Error ? error.message : '';
  const safeConfigurationMessage = /^LEGAL_[A-Z0-9_]+ is required to enable/.test(message);
  const safeProviderMessage =
    typeof error?.code === 'string' &&
    [
      'CONNECTION_FAILED',
      'QUERY_TIMEOUT',
      'SCHEMA_INSPECTION_FAILED',
      'SCHEMA_ALLOWLIST_MISMATCH',
      'SCHEMA_DRIFT',
      'QUERY_FAILED',
      'ROW_LIMIT_EXCEEDED',
      'OUTPUT_LIMIT_EXCEEDED'
    ].includes(error.code);
  return {
    status: 'blocked',
    code: typeof error?.code === 'string' ? error.code : 'SQL_PROVIDER_AUDIT_FAILED',
    message:
      safeConfigurationMessage || safeProviderMessage
        ? message
        : 'SQL provider audit failed without exposing connection details.'
  };
}

async function auditSQLProvider(engine, options = {}) {
  if (!SUPPORTED_ENGINES.has(engine)) {
    throw new TypeError('engine must be mysql or postgresql.');
  }
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..'));
  const manifestPath = path.join(
    projectRoot,
    'configs',
    'data-sources',
    `legal-cases.${engine}.json`
  );
  const dataSource = createConfiguredNetworkDataSource({
    env: options.env ?? process.env,
    manifestPath,
    clientFactory: options.clientFactory,
    dependencies: options.dependencies
  });
  try {
    const connection = await dataSource.testConnection();
    if (connection.status !== 'connected') {
      throw new Error(`${engine} connection did not report connected.`);
    }
    const snapshot = await dataSource.inspectSchema();
    const result = await dataSource.executeReadOnly({
      sql: SQLITE_QUERY_SQL,
      parameters: SQLITE_QUERY_PARAMETERS,
      expectedSchemaFingerprint: snapshot.schemaFingerprint
    });
    return Object.freeze({
      status: 'verified',
      engine,
      dataSource: dataSource.describe().id,
      tlsMode: dataSource.describe().tlsMode,
      schemaFingerprint: snapshot.schemaFingerprint,
      tableCount: 1,
      columnCount: snapshot.schema.columns.length,
      rowCount: result.rowCount,
      outputBytes: result.outputBytes,
      readOnly: result.readOnly
    });
  } finally {
    await dataSource.close();
  }
}

async function main() {
  const engine = process.argv[2];
  if (!SUPPORTED_ENGINES.has(engine)) {
    throw new Error('Usage: node scripts/audit-sql-provider.cjs <mysql|postgresql>');
  }
  loadLocalEnv();
  const result = await auditSQLProvider(engine);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeAuditFailure(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = { auditSQLProvider, safeAuditFailure };
