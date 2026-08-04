const assert = require('node:assert/strict');
const test = require('node:test');
const {
  POLICY_VERSION,
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
  assert.equal(result.policyVersion, 'constrained-readonly-v2');
  assert.equal(POLICY_VERSION, 'constrained-readonly-v2');
  assert.equal(result.schemaFingerprint, createSchemaFingerprint(SCHEMA));
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
});

test('rejects comments, quoted identifiers, malformed strings, and control characters', () => {
  const cases = [
    {
      sql: 'SELECT year FROM labor_cases WHERE year = :year; -- hidden tail',
      code: 'SQL_COMMENT_BLOCKED'
    },
    {
      sql: 'SELECT year /* hidden */ FROM labor_cases WHERE year = :year;',
      code: 'SQL_COMMENT_BLOCKED'
    },
    {
      sql: 'SELECT `year` FROM labor_cases WHERE year = :year;',
      code: 'SQL_QUOTED_IDENTIFIER_BLOCKED'
    },
    {
      sql: "SELECT year FROM labor_cases WHERE issue_type = 'unterminated AND year = :year;",
      code: 'SQL_STRING_LITERAL_INVALID'
    },
    {
      sql: 'SELECT year\u0000 FROM labor_cases WHERE year = :year;',
      code: 'SQL_CONTROL_CHARACTER_BLOCKED'
    }
  ];

  for (const input of cases) {
    const result = validateReadOnlySqlPlan({
      sql: input.sql,
      parameters: { year: 2025 },
      schema: SCHEMA
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, input.code);
  }
});

test('rejects CTEs, subqueries, joins, set operations, and provider-specific commands', () => {
  const cases = [
    {
      sql: 'WITH recent AS (SELECT year FROM labor_cases) SELECT year FROM recent WHERE year = :year;',
      feature: 'with'
    },
    {
      sql: 'SELECT year FROM labor_cases WHERE year IN (SELECT year FROM labor_cases WHERE year = :year);'
    },
    {
      sql: 'SELECT year FROM labor_cases JOIN private_cases ON year = :year;',
      feature: 'join'
    },
    {
      sql: 'SELECT year FROM labor_cases WHERE year = :year UNION SELECT year FROM private_cases;',
      feature: 'union'
    },
    {
      sql: 'SELECT year INTO private_backup FROM labor_cases WHERE year = :year;',
      feature: 'into'
    },
    { sql: 'PRAGMA table_info(labor_cases);', feature: 'pragma' },
    { sql: "ATTACH DATABASE 'private.sqlite' AS private_db;", feature: 'attach' },
    { sql: 'EXPLAIN SELECT year FROM labor_cases WHERE year = :year;', feature: 'explain' }
  ];

  for (const input of cases) {
    const result = validateReadOnlySqlPlan({
      sql: input.sql,
      parameters: { year: 2025 },
      schema: SCHEMA
    });
    assert.equal(result.ok, false, input.sql);
    assert.equal(result.code, 'SQL_COMPLEX_QUERY_BLOCKED', input.sql);
    if (input.feature) assert.equal(result.blockedFeature, input.feature);
  }
});

test('does not treat blocked words or comment markers inside string literals as SQL structure', () => {
  const result = validateReadOnlySqlPlan({
    sql: "SELECT year FROM labor_cases WHERE issue_type = 'delete -- /* ;' AND year = :year;",
    parameters: { year: 2025 },
    schema: SCHEMA
  });

  assert.equal(result.ok, true);
});

test('rejects non-scalar parameters, invalid names, and duplicate Schema fields', () => {
  const invalidValue = validateReadOnlySqlPlan({
    sql: 'SELECT year FROM labor_cases WHERE year = :year;',
    parameters: { year: { nested: 2025 } },
    schema: SCHEMA
  });
  assert.equal(invalidValue.code, 'SQL_PARAMETER_VALUE_INVALID');
  assert.equal(invalidValue.parameterName, 'year');

  const invalidName = validateReadOnlySqlPlan({
    sql: 'SELECT year FROM labor_cases WHERE year = :year;',
    parameters: { year: 2025, 'bad-name': 1 },
    schema: SCHEMA
  });
  assert.equal(invalidName.code, 'SQL_PARAMETER_NAME_INVALID');

  const duplicateSchema = validateReadOnlySqlPlan({
    sql: 'SELECT year FROM labor_cases WHERE year = :year;',
    parameters: { year: 2025 },
    schema: { ...SCHEMA, columns: [...SCHEMA.columns, { name: 'YEAR', type: 'INTEGER' }] }
  });
  assert.equal(duplicateSchema.code, 'SCHEMA_INVALID');
});

test('rejects hidden or accessor parameters that would be omitted from the plan hash', () => {
  const hidden = { year: 2025 };
  Object.defineProperty(hidden, 'issue_type', {
    enumerable: false,
    value: '未签劳动合同'
  });
  const hiddenResult = validateReadOnlySqlPlan({
    sql: 'SELECT year FROM labor_cases WHERE year = :year AND issue_type = :issue_type;',
    parameters: hidden,
    schema: SCHEMA
  });
  assert.equal(hiddenResult.code, 'PARAMETERS_INVALID');

  const accessor = {};
  Object.defineProperty(accessor, 'year', {
    enumerable: true,
    get() {
      return 2025;
    }
  });
  const accessorResult = validateReadOnlySqlPlan({
    sql: 'SELECT year FROM labor_cases WHERE year = :year;',
    parameters: accessor,
    schema: SCHEMA
  });
  assert.equal(accessorResult.code, 'PARAMETERS_INVALID');
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
