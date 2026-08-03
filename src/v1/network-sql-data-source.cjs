const { createSchemaFingerprint, validateReadOnlySqlPlan } = require('./sql-policy-guard.cjs');
const { createMySQLClient, createPostgreSQLClient } = require('./network-sql-clients.cjs');

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_ENGINES = new Set(['mysql', 'postgresql']);

class NetworkSQLDataSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'NetworkSQLDataSourceError';
    this.code = code;
  }
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireInteger(value, fieldName, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateIdentifiers(values, fieldName, expectedLength) {
  if (!Array.isArray(values) || values.length !== expectedLength) {
    throw new TypeError(`${fieldName} must contain exactly ${expectedLength} item(s).`);
  }
  const normalized = values.map((value, index) => {
    const identifier = requireString(value, `${fieldName}[${index}]`);
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw new TypeError(`${fieldName} contains an invalid SQL identifier.`);
    }
    return identifier;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${fieldName} must not contain duplicates.`);
  }
  return Object.freeze(normalized);
}

function withTimeout(promise, timeoutMs, operation) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new NetworkSQLDataSourceError(
            'QUERY_TIMEOUT',
            `${operation} exceeded the ${timeoutMs} ms timeout.`
          )
        ),
      timeoutMs
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createNetworkSQLDataSource(options = {}) {
  const id = requireString(options.id, 'id');
  const engine = requireString(options.engine, 'engine');
  if (!SUPPORTED_ENGINES.has(engine)) {
    throw new TypeError('engine must be mysql or postgresql.');
  }
  const host = requireString(options.host, 'host');
  const database = requireString(options.database, 'database');
  const user = requireString(options.user, 'user');
  const password = requireString(options.password, 'password');
  const port = requireInteger(options.port, 'port', 1, 65535);
  const tlsMode = options.tlsMode ?? 'require';
  if (!['disable', 'require'].includes(tlsMode)) {
    throw new TypeError('tlsMode must be disable or require.');
  }
  const schemaName =
    engine === 'postgresql' ? requireString(options.schemaName ?? 'public', 'schemaName') : null;
  if (schemaName !== null && !IDENTIFIER_PATTERN.test(schemaName)) {
    throw new TypeError('schemaName contains an invalid SQL identifier.');
  }
  const allowedTables = validateIdentifiers(options.allowedTables, 'allowedTables', 1);
  if (!Array.isArray(options.allowedColumns) || options.allowedColumns.length === 0) {
    throw new TypeError('allowedColumns must contain at least one item.');
  }
  const allowedColumns = validateIdentifiers(
    options.allowedColumns,
    'allowedColumns',
    options.allowedColumns.length
  );
  const timeoutMs = requireInteger(options.timeoutMs ?? 15_000, 'timeoutMs', 1, 15_000);
  const maxRows = requireInteger(options.maxRows ?? 500, 'maxRows', 1, 10_000);
  const maxOutputBytes = requireInteger(
    options.maxOutputBytes ?? 1_048_576,
    'maxOutputBytes',
    128,
    10_485_760
  );
  const profile = Object.freeze({
    engine,
    host,
    port,
    database,
    user,
    password,
    tlsMode,
    schemaName,
    timeoutMs
  });
  const client = options.clientFactory
    ? options.clientFactory(profile)
    : engine === 'postgresql'
      ? createPostgreSQLClient(profile, options.dependencies)
      : createMySQLClient(profile, options.dependencies);
  if (
    !client ||
    typeof client.testConnection !== 'function' ||
    typeof client.inspectTable !== 'function' ||
    typeof client.executeReadOnly !== 'function'
  ) {
    throw new TypeError('SQL client must expose testConnection, inspectTable, and executeReadOnly.');
  }

  async function testConnection() {
    try {
      const connected = await withTimeout(client.testConnection(), timeoutMs, 'Connection test');
      return Object.freeze({
        status: connected ? 'connected' : 'failed',
        dataSource: id,
        engine,
        tlsMode
      });
    } catch (error) {
      if (error instanceof NetworkSQLDataSourceError) throw error;
      throw new NetworkSQLDataSourceError(
        'CONNECTION_FAILED',
        `${engine} connection test failed without exposing connection details.`,
        { cause: error }
      );
    }
  }

  async function inspectSchema(options = {}) {
    const allowMissing = options?.allowMissing === true;
    let inspected;
    try {
      inspected = await withTimeout(
        client.inspectTable(allowedTables[0], allowedColumns),
        timeoutMs,
        'Schema inspection'
      );
    } catch (error) {
      if (error instanceof NetworkSQLDataSourceError) throw error;
      throw new NetworkSQLDataSourceError(
        'SCHEMA_INSPECTION_FAILED',
        `${engine} Schema inspection failed without exposing connection details.`,
        { cause: error }
      );
    }
    const tableAvailable = Array.isArray(inspected) ? true : inspected?.tableAvailable !== false;
    const columns = Array.isArray(inspected) ? inspected : inspected?.columns;
    if (!Array.isArray(columns) || columns.length !== allowedColumns.length) {
      throw new NetworkSQLDataSourceError(
        'SCHEMA_INSPECTION_INVALID',
        'SQL Schema inspection returned an invalid allowlisted snapshot.'
      );
    }
    if ((!tableAvailable || columns.some((value) => !value)) && !allowMissing) {
      throw new NetworkSQLDataSourceError(
        'SCHEMA_ALLOWLIST_MISMATCH',
        'Configured table or column is unavailable.'
      );
    }
    const schema = Object.freeze({
      dataSource: id,
      engine,
      ...(schemaName === null ? {} : { schemaName }),
      tableName: allowedTables[0],
      ...(!tableAvailable ? { tableAvailable: false } : {}),
      columns: Object.freeze(
        columns.filter(Boolean).map((column) => Object.freeze({ ...column }))
      )
    });
    return Object.freeze({ schema, schemaFingerprint: createSchemaFingerprint(schema) });
  }

  return Object.freeze({
    describe() {
      return Object.freeze({
        id,
        engine,
        mode: 'read-only',
        tlsMode,
        allowedTables: [...allowedTables],
        allowedColumns: [...allowedColumns],
        timeoutMs,
        maxRows,
        maxOutputBytes,
        credentialsRequired: true
      });
    },

    testConnection,
    inspectSchema,

    async executeReadOnly({ sql, parameters, expectedSchemaFingerprint }) {
      requireString(expectedSchemaFingerprint, 'expectedSchemaFingerprint');
      let snapshot;
      try {
        snapshot = await inspectSchema();
      } catch (error) {
        if (error?.code === 'SCHEMA_ALLOWLIST_MISMATCH') {
          throw new NetworkSQLDataSourceError(
            'SCHEMA_DRIFT',
            'Configured SQL Schema changed after confirmation.',
            { cause: error }
          );
        }
        throw error;
      }
      if (snapshot.schemaFingerprint !== expectedSchemaFingerprint) {
        throw new NetworkSQLDataSourceError(
          'SCHEMA_DRIFT',
          'Configured SQL Schema changed after confirmation.'
        );
      }
      const policy = validateReadOnlySqlPlan({ sql, parameters, schema: snapshot.schema });
      if (!policy.ok) {
        throw new NetworkSQLDataSourceError(policy.code, policy.message);
      }
      const startedAt = Date.now();
      let rows;
      try {
        rows = await withTimeout(
          client.executeReadOnly(sql, parameters, maxRows),
          timeoutMs,
          'Read-only query'
        );
      } catch (error) {
        if (error instanceof NetworkSQLDataSourceError) throw error;
        throw new NetworkSQLDataSourceError(
          'QUERY_FAILED',
          `${engine} read-only query failed without exposing connection details.`,
          { cause: error }
        );
      }
      if (!Array.isArray(rows)) {
        throw new NetworkSQLDataSourceError('QUERY_RESULT_INVALID', 'SQL client returned invalid rows.');
      }
      if (rows.length > maxRows) {
        throw new NetworkSQLDataSourceError(
          'ROW_LIMIT_EXCEEDED',
          'Query result exceeds the configured row limit.'
        );
      }
      const normalizedRows = rows.map((row) => ({ ...row }));
      const outputBytes = Buffer.byteLength(JSON.stringify(normalizedRows), 'utf8');
      if (outputBytes > maxOutputBytes) {
        throw new NetworkSQLDataSourceError(
          'OUTPUT_LIMIT_EXCEEDED',
          'Query result exceeds the configured output limit.'
        );
      }
      return Object.freeze({
        columns: normalizedRows.length === 0 ? [] : Object.keys(normalizedRows[0]),
        rows: Object.freeze(normalizedRows.map((row) => Object.freeze(row))),
        rowCount: normalizedRows.length,
        outputBytes,
        durationMs: Date.now() - startedAt,
        dataSource: id,
        engine,
        schemaFingerprint: snapshot.schemaFingerprint,
        readOnly: true,
        tlsMode
      });
    },

    async close() {
      await client.close?.();
    }
  });
}

module.exports = { NetworkSQLDataSourceError, createNetworkSQLDataSource };
