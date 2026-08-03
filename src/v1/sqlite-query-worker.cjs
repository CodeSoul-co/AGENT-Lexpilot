const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { loadHyphaAdaptersLocal } = require('../../scripts/hypha-paths.cjs');

function openReadOnlyDatabase(databasePath, projectRoot) {
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const options = sqlite.constants
    ? { readOnly: true, allowExtension: false }
    : { readonly: true, fileMustExist: true };
  const database = new sqlite.DatabaseSync(databasePath, options);
  database.exec('PRAGMA query_only = ON;');
  database.exec('PRAGMA trusted_schema = OFF;');
  return database;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function inspectTable(database, tableName) {
  const columns = normalizeRows(
    database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)});`).all()
  );
  if (columns.length === 0) {
    throw Object.assign(new Error('Configured table is unavailable.'), {
      code: 'TABLE_NOT_FOUND'
    });
  }
  return {
    tableName,
    columns: columns.map((column) => ({
      name: String(column.name),
      type: String(column.type || 'UNKNOWN').toUpperCase(),
      nullable: Number(column.notnull) !== 1,
      primaryKeyPosition: Number(column.pk) || 0
    }))
  };
}

function inspectSchema(database, allowedTables) {
  const existingTables = new Set(
    normalizeRows(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%';"
        )
        .all()
    ).map((row) => String(row.name))
  );
  return allowedTables.map((tableName) => {
    if (!existingTables.has(tableName)) {
      throw Object.assign(new Error('Configured table is unavailable.'), {
        code: 'TABLE_NOT_FOUND'
      });
    }
    return inspectTable(database, tableName);
  });
}

function executeQuery(database, sql, parameters, maxRows, maxOutputBytes) {
  const query = sql.trim().replace(/;\s*$/, '');
  const boundedSql = `SELECT * FROM (${query}) AS lexpilot_bounded_result LIMIT ${maxRows + 1};`;
  const rows = normalizeRows(database.prepare(boundedSql).all(parameters));
  if (rows.length > maxRows) {
    throw Object.assign(new Error('Query result exceeds the configured row limit.'), {
      code: 'ROW_LIMIT_EXCEEDED'
    });
  }
  const outputBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (outputBytes > maxOutputBytes) {
    throw Object.assign(new Error('Query result exceeds the configured output limit.'), {
      code: 'OUTPUT_LIMIT_EXCEEDED'
    });
  }
  return {
    columns: rows.length === 0 ? [] : Object.keys(rows[0]),
    rows,
    rowCount: rows.length,
    outputBytes
  };
}

function run() {
  const projectRoot = path.resolve(workerData.projectRoot);
  const database = openReadOnlyDatabase(workerData.databasePath, projectRoot);
  try {
    if (workerData.operation === 'ping') {
      const row = database.prepare('SELECT 1 AS value;').get();
      return { connected: Number(row.value) === 1 };
    }
    if (workerData.operation === 'schema') {
      return { tables: inspectSchema(database, workerData.allowedTables) };
    }
    if (workerData.operation === 'query') {
      return executeQuery(
        database,
        workerData.sql,
        workerData.parameters,
        workerData.maxRows,
        workerData.maxOutputBytes
      );
    }
    throw Object.assign(new Error('Unsupported SQLite worker operation.'), {
      code: 'OPERATION_NOT_SUPPORTED'
    });
  } finally {
    database.close?.();
  }
}

try {
  parentPort.postMessage({ ok: true, value: run() });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'SQLITE_OPERATION_FAILED',
      message: error instanceof Error ? error.message : 'SQLite operation failed.'
    }
  });
}
