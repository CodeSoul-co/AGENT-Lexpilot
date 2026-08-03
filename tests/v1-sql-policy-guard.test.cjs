const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSchemaFingerprint,
  validateReadOnlySqlPlan,
  validateWriteSqlPlan
} = require('../src/v1/sql-policy-guard.cjs');

const SCHEMA = Object.freeze({
  dataSource: 'demo.labor_cases',
  tableName: 'labor_cases',
  columns: Object.freeze([
    { name: 'year', type: 'INTEGER' },
    { name: 'issue_type', type: 'TEXT' }
  ])
});

const WRITE_SCHEMA = Object.freeze({
  dataSource: 'local.legal_cases.write',
  tableName: 'labor_cases',
  columns: Object.freeze([
    { name: 'case_id', type: 'TEXT' },
    { name: 'year', type: 'INTEGER' },
    { name: 'issue_type', type: 'TEXT' },
    { name: 'outcome', type: 'TEXT' },
    { name: 'compensation_amount', type: 'INTEGER' }
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

test('accepts only fixed single-row write templates and rejects DDL or broad updates', () => {
  const accepted = validateWriteSqlPlan({
    sql: 'UPDATE labor_cases SET compensation_amount = :compensation_amount WHERE case_id = :case_id;',
    parameters: { compensation_amount: 12000, case_id: 'LC-1' },
    schema: WRITE_SCHEMA,
    allowedWriteOperations: ['insert', 'update', 'delete'],
    maxAffectedRows: 1
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.operationType, 'update');
  assert.equal(accepted.requiresHumanReview, true);

  const ddl = validateWriteSqlPlan({
    sql: 'DROP TABLE labor_cases;',
    parameters: {},
    schema: WRITE_SCHEMA,
    allowedWriteOperations: ['insert', 'update', 'delete'],
    maxAffectedRows: 1
  });
  assert.equal(ddl.code, 'DANGEROUS_OPERATION_DENIED');

  const broad = validateWriteSqlPlan({
    sql: 'UPDATE labor_cases SET compensation_amount = :compensation_amount;',
    parameters: { compensation_amount: 12000 },
    schema: WRITE_SCHEMA,
    allowedWriteOperations: ['insert', 'update', 'delete'],
    maxAffectedRows: 1
  });
  assert.equal(broad.code, 'WRITE_TEMPLATE_NOT_ALLOWED');
});
