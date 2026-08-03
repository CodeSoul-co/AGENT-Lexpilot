const { createHash } = require('node:crypto');

const POLICY_VERSION = 'demo-readonly-v1';
const BLOCKED_KEYWORDS = Object.freeze([
  'alter',
  'create',
  'delete',
  'drop',
  'grant',
  'insert',
  'replace',
  'revoke',
  'truncate',
  'update'
]);

const SQL_KEYWORDS = new Set([
  'and',
  'as',
  'asc',
  'between',
  'by',
  'case',
  'count',
  'desc',
  'else',
  'end',
  'from',
  'group',
  'median',
  'order',
  'round',
  'select',
  'sum',
  'then',
  'when',
  'where'
]);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createSchemaFingerprint(schema) {
  return sha256(JSON.stringify(canonicalize(schema)));
}

function createPlanHash({ sql, parameters, schemaFingerprint }) {
  return sha256(
    JSON.stringify(
      canonicalize({ policyVersion: POLICY_VERSION, sql, parameters, schemaFingerprint })
    )
  );
}

function reject(code, message, details = {}) {
  return Object.freeze({
    ok: false,
    code,
    message,
    policyVersion: POLICY_VERSION,
    ...details
  });
}

function validateReadOnlySqlPlan({ sql, parameters, schema }) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return reject('SQL_REQUIRED', 'SQL 计划不能为空。');
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return reject('PARAMETERS_REQUIRED', 'SQL 计划必须提供独立参数对象。');
  }
  if (
    !schema ||
    typeof schema !== 'object' ||
    typeof schema.tableName !== 'string' ||
    !Array.isArray(schema.columns)
  ) {
    return reject('SCHEMA_INVALID', '数据源 Schema 不完整。');
  }

  const withoutStrings = sql.replace(/'(?:''|[^'])*'/g, "''");
  const statements = withoutStrings
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length !== 1 || !/^select\b/i.test(statements[0])) {
    return reject('SQL_NOT_SINGLE_SELECT', '只允许执行单条 SELECT 查询。');
  }

  const blocked = BLOCKED_KEYWORDS.find((keyword) =>
    new RegExp(`\\b${keyword}\\b`, 'i').test(withoutStrings)
  );
  if (blocked) {
    return reject('SQL_WRITE_BLOCKED', '查询包含禁止的写入或结构变更操作。', {
      blockedKeyword: blocked
    });
  }

  const fromMatch = withoutStrings.match(/\bfrom\s+([a-z_][a-z0-9_]*)\b/i);
  if (!fromMatch || fromMatch[1].toLowerCase() !== schema.tableName.toLowerCase()) {
    return reject('SQL_TABLE_NOT_ALLOWED', '查询引用了未授权的数据表。');
  }

  const parameterNames = [...withoutStrings.matchAll(/:([a-z_][a-z0-9_]*)\b/gi)].map(
    (match) => match[1]
  );
  const uniqueParameterNames = [...new Set(parameterNames)];
  if (uniqueParameterNames.length === 0) {
    return reject('SQL_PARAMETERS_NOT_BOUND', '查询必须使用命名参数，不能拼接筛选值。');
  }
  const missingParameters = uniqueParameterNames.filter(
    (name) => !Object.prototype.hasOwnProperty.call(parameters, name)
  );
  if (missingParameters.length > 0) {
    return reject('SQL_PARAMETER_MISSING', '查询参数不完整。', { missingParameters });
  }
  const unusedParameters = Object.keys(parameters).filter(
    (name) => !uniqueParameterNames.includes(name)
  );
  if (unusedParameters.length > 0) {
    return reject('SQL_PARAMETER_UNUSED', '查询包含未使用的参数。', { unusedParameters });
  }

  const knownIdentifiers = new Set([
    schema.tableName.toLowerCase(),
    ...schema.columns.map((column) => String(column.name).toLowerCase()),
    'case_count',
    'employee_win_rate',
    'median_compensation'
  ]);
  const identifierSource = withoutStrings.replace(/:[a-z_][a-z0-9_]*/gi, '');
  const unknownIdentifiers = [...identifierSource.matchAll(/\b[a-z_][a-z0-9_]*\b/gi)]
    .map((match) => match[0].toLowerCase())
    .filter((identifier) => !SQL_KEYWORDS.has(identifier) && !knownIdentifiers.has(identifier));
  if (unknownIdentifiers.length > 0) {
    return reject('SQL_COLUMN_NOT_ALLOWED', '查询引用了 Schema 之外的字段。', {
      unknownIdentifiers: [...new Set(unknownIdentifiers)]
    });
  }

  const schemaFingerprint = createSchemaFingerprint(schema);
  return Object.freeze({
    ok: true,
    operationType: 'select',
    readOnly: true,
    policyVersion: POLICY_VERSION,
    schemaFingerprint,
    planHash: createPlanHash({ sql, parameters, schemaFingerprint })
  });
}

module.exports = {
  POLICY_VERSION,
  createPlanHash,
  createSchemaFingerprint,
  validateReadOnlySqlPlan
};
