const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSchemaFingerprint,
  validateReadOnlySqlPlan
} = require('../src/v1/sql-policy-guard.cjs');

const SCHEMA = Object.freeze({
  dataSource: 'demo.labor_cases',
  tableName: 'labor_cases',
  columns: Object.freeze([
    { name: 'year', type: 'INTEGER' },
    { name: 'issue_type', type: 'TEXT' }
  ])
});

test('accepts a single parameterized SELECT against the declared schema', () => {
  const result = validateReadOnlySqlPlan({
    sql: 'SELECT year, COUNT(*) AS case_count FROM labor_cases WHERE year = :year GROUP BY year;',
    parameters: { year: 2025 },
    schema: SCHEMA
  });
  assert.equal(result.ok, true);
  assert.equal(result.operationType, 'select');
  assert.equal(result.readOnly, true);
  assert.equal(result.schemaFingerprint, createSchemaFingerprint(SCHEMA));
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
});

test('rejects writes, multiple statements, unknown tables, and unbound values', () => {
  const cases = [
    {
      sql: 'DELETE FROM labor_cases WHERE year = :year;',
      parameters: { year: 2025 },
      code: 'SQL_NOT_SINGLE_SELECT'
    },
    {
      sql: 'SELECT year FROM labor_cases WHERE year = :year; DROP TABLE labor_cases;',
      parameters: { year: 2025 },
      code: 'SQL_NOT_SINGLE_SELECT'
    },
    {
      sql: 'SELECT year FROM private_cases WHERE year = :year;',
      parameters: { year: 2025 },
      code: 'SQL_TABLE_NOT_ALLOWED'
    },
    {
      sql: 'SELECT year FROM labor_cases WHERE year = 2025;',
      parameters: {},
      code: 'SQL_PARAMETERS_NOT_BOUND'
    },
    {
      sql: 'SELECT secret_field FROM labor_cases WHERE year = :year;',
      parameters: { year: 2025 },
      code: 'SQL_COLUMN_NOT_ALLOWED'
    }
  ];

  for (const input of cases) {
    const result = validateReadOnlySqlPlan({ ...input, schema: SCHEMA });
    assert.equal(result.ok, false);
    assert.equal(result.code, input.code);
  }
});

test('schema changes produce a different fingerprint and plan hash', () => {
  const changedSchema = {
    ...SCHEMA,
    columns: [...SCHEMA.columns, { name: 'outcome', type: 'TEXT' }]
  };
  const sql = 'SELECT year FROM labor_cases WHERE year = :year;';
  const original = validateReadOnlySqlPlan({ sql, parameters: { year: 2025 }, schema: SCHEMA });
  const changed = validateReadOnlySqlPlan({
    sql,
    parameters: { year: 2025 },
    schema: changedSchema
  });
  assert.notEqual(original.schemaFingerprint, changed.schemaFingerprint);
  assert.notEqual(original.planHash, changed.planHash);
});
