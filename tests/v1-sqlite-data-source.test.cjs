const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaAdaptersLocal } = require('../scripts/hypha-paths.cjs');
const {
  SQLiteDataSourceError,
  createSQLiteDataSource
} = require('../src/v1/sqlite-data-source.cjs');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-sqlite-source-'));
  const databasePath = path.join(directory, 'labor-cases.sqlite');
  const sqlite = loadHyphaAdaptersLocal(path.resolve(__dirname, '..')).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE labor_cases (
      case_id TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      compensation_amount INTEGER
    );
    INSERT INTO labor_cases VALUES
      ('LC-1', 2024, 'unsigned_contract', 12000),
      ('LC-2', 2025, 'unsigned_contract', 18000),
      ('LC-3', 2025, 'dismissal', NULL);
  `);
  database.close?.();
  return {
    databasePath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

function createSource(databasePath, overrides = {}) {
  return createSQLiteDataSource({
    id: 'local.legal_cases',
    databasePath,
    allowedTables: ['labor_cases'],
    ...overrides
  });
}

test('opens an existing SQLite file read-only without exposing its local path', async () => {
  const fixture = createFixture();
  try {
    const source = createSource(fixture.databasePath);
    assert.deepEqual(source.describe(), {
      id: 'local.legal_cases',
      engine: 'sqlite',
      mode: 'read-only',
      allowedTables: ['labor_cases'],
      timeoutMs: 15000,
      maxRows: 500,
      maxOutputBytes: 1048576,
      credentialsRequired: false
    });
    assert.deepEqual(await source.testConnection(), {
      status: 'connected',
      dataSource: 'local.legal_cases'
    });
    assert.equal(JSON.stringify(source.describe()).includes(fixture.databasePath), false);
  } finally {
    fixture.cleanup();
  }
});

test('introspects only the configured table and returns a stable Schema fingerprint', async () => {
  const fixture = createFixture();
  try {
    const source = createSource(fixture.databasePath);
    const first = await source.inspectSchema();
    const second = await source.inspectSchema();

    assert.equal(first.dataSource, 'local.legal_cases');
    assert.equal(first.engine, 'sqlite');
    assert.equal(first.tableName, 'labor_cases');
    assert.deepEqual(
      first.columns.map((column) => column.name),
      ['case_id', 'year', 'issue_type', 'compensation_amount']
    );
    assert.equal(first.columns[0].primaryKeyPosition, 1);
    assert.match(first.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(first.schemaFingerprint, second.schemaFingerprint);
  } finally {
    fixture.cleanup();
  }
});

test('executes a parameterized SELECT and preserves the database file', async () => {
  const fixture = createFixture();
  try {
    const source = createSource(fixture.databasePath);
    const schema = await source.inspectSchema();
    const before = fs.readFileSync(fixture.databasePath);
    const result = await source.executeReadOnly({
      sql: 'SELECT case_id, year, issue_type FROM labor_cases WHERE year >= :start_year ORDER BY year;',
      parameters: { start_year: 2025 },
      expectedSchemaFingerprint: schema.schemaFingerprint
    });
    const after = fs.readFileSync(fixture.databasePath);

    assert.equal(result.readOnly, true);
    assert.equal(result.rowCount, 2);
    assert.deepEqual(result.columns, ['case_id', 'year', 'issue_type']);
    assert.deepEqual(
      result.rows.map((row) => row.case_id),
      ['LC-2', 'LC-3']
    );
    assert.equal(result.schemaFingerprint, schema.schemaFingerprint);
    assert.deepEqual(after, before);
  } finally {
    fixture.cleanup();
  }
});

test('blocks writes before execution and rejects a changed Schema fingerprint', async () => {
  const fixture = createFixture();
  try {
    const source = createSource(fixture.databasePath);
    const schema = await source.inspectSchema();
    await assert.rejects(
      source.executeReadOnly({
        sql: 'DELETE FROM labor_cases WHERE year = :year;',
        parameters: { year: 2025 },
        expectedSchemaFingerprint: schema.schemaFingerprint
      }),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'SQL_NOT_SINGLE_SELECT'
    );

    const sqlite = loadHyphaAdaptersLocal(path.resolve(__dirname, '..')).loadSqlite(true);
    const writable = new sqlite.DatabaseSync(fixture.databasePath);
    writable.exec('ALTER TABLE labor_cases ADD COLUMN city TEXT;');
    writable.close?.();

    await assert.rejects(
      source.executeReadOnly({
        sql: 'SELECT year FROM labor_cases WHERE year = :year;',
        parameters: { year: 2025 },
        expectedSchemaFingerprint: schema.schemaFingerprint
      }),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'SCHEMA_DRIFT'
    );
  } finally {
    fixture.cleanup();
  }
});

test('fails closed at the row, output-size, and hard-timeout limits', async () => {
  const fixture = createFixture();
  try {
    const schema = await createSource(fixture.databasePath).inspectSchema();
    const query = {
      sql: 'SELECT case_id, year, issue_type, compensation_amount FROM labor_cases WHERE year >= :start_year ORDER BY year;',
      parameters: { start_year: 2024 },
      expectedSchemaFingerprint: schema.schemaFingerprint
    };

    await assert.rejects(
      createSource(fixture.databasePath, { maxRows: 2 }).executeReadOnly(query),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'ROW_LIMIT_EXCEEDED'
    );
    await assert.rejects(
      createSource(fixture.databasePath, { maxOutputBytes: 128 }).executeReadOnly(query),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'OUTPUT_LIMIT_EXCEEDED'
    );
    await assert.rejects(
      createSource(fixture.databasePath, { timeoutMs: 1 }).testConnection(),
      (error) => error instanceof SQLiteDataSourceError && error.code === 'QUERY_TIMEOUT'
    );
  } finally {
    fixture.cleanup();
  }
});

test('rejects missing files and unsafe table declarations during configuration', () => {
  assert.throws(
    () =>
      createSQLiteDataSource({
        id: 'missing',
        databasePath: path.join(os.tmpdir(), 'missing-lexpilot-database.sqlite'),
        allowedTables: ['labor_cases']
      }),
    (error) => error instanceof SQLiteDataSourceError && error.code === 'DATABASE_NOT_FOUND'
  );

  const fixture = createFixture();
  try {
    assert.throws(
      () => createSource(fixture.databasePath, { allowedTables: ['labor_cases; DROP TABLE x'] }),
      /invalid SQLite identifier/
    );
    assert.throws(
      () => createSource(fixture.databasePath, { allowedTables: ['labor_cases', 'private_cases'] }),
      /exactly one table/
    );
  } finally {
    fixture.cleanup();
  }
});
