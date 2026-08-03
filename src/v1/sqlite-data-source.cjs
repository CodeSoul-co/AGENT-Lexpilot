const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  createSchemaFingerprint,
  validateReadOnlySqlPlan
} = require('./sql-policy-guard.cjs');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class SQLiteDataSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'SQLiteDataSourceError';
    this.code = code;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoundedInteger(value, fieldName, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function resolveDatabasePath(databasePath) {
  requireNonEmptyString(databasePath, 'databasePath');
  const resolved = path.resolve(databasePath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new SQLiteDataSourceError('DATABASE_NOT_FOUND', 'Configured SQLite database was not found.', {
      cause: error
    });
  }
  if (!stats.isFile()) {
    throw new SQLiteDataSourceError('DATABASE_NOT_FILE', 'Configured SQLite path is not a file.');
  }
  return fs.realpathSync(resolved);
}

function validateAllowedTables(allowedTables) {
  if (!Array.isArray(allowedTables) || allowedTables.length !== 1) {
    throw new TypeError('allowedTables must contain exactly one table for the current V1 policy.');
  }
  const tableName = requireNonEmptyString(allowedTables[0], 'allowedTables[0]');
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new TypeError('allowedTables contains an invalid SQLite identifier.');
  }
  return Object.freeze([tableName]);
}

function runWorker(workerFile, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: payload });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(
        reject,
        new SQLiteDataSourceError(
          'QUERY_TIMEOUT',
          `SQLite operation exceeded the ${timeoutMs} ms hard timeout.`
        )
      );
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, message.value);
        return;
      }
      finish(
        reject,
        new SQLiteDataSourceError(
          message?.error?.code ?? 'SQLITE_OPERATION_FAILED',
          message?.error?.message ?? 'SQLite operation failed.'
        )
      );
    });
    worker.once('error', (error) => {
      finish(
        reject,
        new SQLiteDataSourceError('SQLITE_WORKER_FAILED', 'SQLite worker failed.', { cause: error })
      );
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        finish(
          reject,
          new SQLiteDataSourceError(
            'SQLITE_WORKER_EXITED',
            `SQLite worker exited with code ${code}.`
          )
        );
      }
    });
  });
}

function createSQLiteDataSource(options = {}) {
  const id = requireNonEmptyString(options.id, 'id');
  const databasePath = resolveDatabasePath(options.databasePath);
  const allowedTables = validateAllowedTables(options.allowedTables);
  const timeoutMs = requireBoundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
    1,
    DEFAULT_TIMEOUT_MS
  );
  const maxRows = requireBoundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, 10_000);
  const maxOutputBytes = requireBoundedInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
    128,
    10_485_760
  );
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const workerFile = path.join(__dirname, 'sqlite-query-worker.cjs');
  const basePayload = Object.freeze({ projectRoot, databasePath, allowedTables });

  async function inspectSchema() {
    const result = await runWorker(workerFile, { ...basePayload, operation: 'schema' }, timeoutMs);
    const table = result.tables[0];
    const schema = Object.freeze({
      dataSource: id,
      engine: 'sqlite',
      tableName: table.tableName,
      columns: Object.freeze(table.columns.map((column) => Object.freeze({ ...column })))
    });
    return Object.freeze({ ...schema, schemaFingerprint: createSchemaFingerprint(schema) });
  }

  return Object.freeze({
    describe() {
      return Object.freeze({
        id,
        engine: 'sqlite',
        mode: 'read-only',
        allowedTables: [...allowedTables],
        timeoutMs,
        maxRows,
        maxOutputBytes,
        credentialsRequired: false
      });
    },

    async testConnection() {
      const result = await runWorker(workerFile, { ...basePayload, operation: 'ping' }, timeoutMs);
      return Object.freeze({ status: result.connected ? 'connected' : 'failed', dataSource: id });
    },

    inspectSchema,

    async executeReadOnly({ sql, parameters, expectedSchemaFingerprint }) {
      requireNonEmptyString(expectedSchemaFingerprint, 'expectedSchemaFingerprint');
      const schema = await inspectSchema();
      if (schema.schemaFingerprint !== expectedSchemaFingerprint) {
        throw new SQLiteDataSourceError(
          'SCHEMA_DRIFT',
          'SQLite Schema changed after the query plan was confirmed.'
        );
      }
      const policy = validateReadOnlySqlPlan({ sql, parameters, schema });
      if (!policy.ok) {
        throw new SQLiteDataSourceError(policy.code, policy.message);
      }
      const startedAt = Date.now();
      const result = await runWorker(
        workerFile,
        {
          ...basePayload,
          operation: 'query',
          sql,
          parameters,
          maxRows,
          maxOutputBytes
        },
        timeoutMs
      );
      return Object.freeze({
        ...result,
        rows: Object.freeze(result.rows.map((row) => Object.freeze({ ...row }))),
        durationMs: Date.now() - startedAt,
        dataSource: id,
        schemaFingerprint: schema.schemaFingerprint,
        readOnly: true
      });
    }
  });
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  SQLiteDataSourceError,
  createSQLiteDataSource
};
