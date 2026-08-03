const { createHash } = require('node:crypto');

const POLICY_VERSION = 'demo-readonly-v1';
const WRITE_POLICY_VERSION = 'governed-sqlite-write-v1';
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

function createWritePlanHash({ sql, parameters, schemaFingerprint }) {
  return sha256(
    JSON.stringify(
      canonicalize({ policyVersion: WRITE_POLICY_VERSION, sql, parameters, schemaFingerprint })
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

function validateWriteSqlPlan({ sql, parameters, schema, allowedWriteOperations, maxAffectedRows }) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return reject('SQL_REQUIRED', 'SQL 写入计划不能为空。');
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return reject('PARAMETERS_REQUIRED', 'SQL 写入计划必须提供独立参数对象。');
  }
  if (!schema || typeof schema.tableName !== 'string' || !Array.isArray(schema.columns)) {
    return reject('SCHEMA_INVALID', '数据源 Schema 不完整。');
  }
  if (maxAffectedRows !== 1) {
    return reject('AFFECTED_ROWS_POLICY_INVALID', '写入策略必须限制为单行。');
  }
  const statement = sql.trim().replace(/;\s*$/, '');
  if (statement.includes(';')) {
    return reject('SQL_NOT_SINGLE_STATEMENT', '只允许执行单条写入语句。');
  }
  const dangerous = /\b(?:drop|alter|truncate|create|replace|grant|revoke|attach|detach|pragma)\b/i.exec(statement);
  if (dangerous) {
    return reject('DANGEROUS_OPERATION_DENIED', '结构变更和危险操作已在数据库执行前拒绝。', {
      blockedKeyword: dangerous[0].toLowerCase()
    });
  }
  const operation = /^(insert|update|delete)\b/i.exec(statement)?.[1]?.toLowerCase();
  if (!operation || !allowedWriteOperations?.includes(operation)) {
    return reject('WRITE_OPERATION_NOT_ALLOWED', '写入操作不在授权范围内。');
  }
  const tableMatch =
    operation === 'insert'
      ? /^insert\s+into\s+([a-z_][a-z0-9_]*)\b/i.exec(statement)
      : operation === 'update'
        ? /^update\s+([a-z_][a-z0-9_]*)\b/i.exec(statement)
        : /^delete\s+from\s+([a-z_][a-z0-9_]*)\b/i.exec(statement);
  if (!tableMatch || tableMatch[1].toLowerCase() !== schema.tableName.toLowerCase()) {
    return reject('SQL_TABLE_NOT_ALLOWED', '写入计划引用了未授权数据表。');
  }
  const allowedColumns = new Set(schema.columns.map((column) => String(column.name).toLowerCase()));
  const templates = {
    insert: /^insert\s+into\s+labor_cases\s*\(\s*case_id\s*,\s*year\s*,\s*issue_type\s*,\s*outcome\s*,\s*compensation_amount\s*\)\s*values\s*\(\s*:case_id\s*,\s*:year\s*,\s*:issue_type\s*,\s*:outcome\s*,\s*:compensation_amount\s*\)$/i,
    update: /^update\s+labor_cases\s+set\s+compensation_amount\s*=\s*:compensation_amount\s+where\s+case_id\s*=\s*:case_id$/i,
    delete: /^delete\s+from\s+labor_cases\s+where\s+case_id\s*=\s*:case_id$/i
  };
  if (schema.tableName.toLowerCase() !== 'labor_cases' || !templates[operation].test(statement)) {
    return reject('WRITE_TEMPLATE_NOT_ALLOWED', '写入语句不符合单行参数化模板。');
  }
  const requiredColumns =
    operation === 'insert'
      ? ['case_id', 'year', 'issue_type', 'outcome', 'compensation_amount']
      : operation === 'update'
        ? ['case_id', 'compensation_amount']
        : ['case_id'];
  if (requiredColumns.some((column) => !allowedColumns.has(column))) {
    return reject('SQL_COLUMN_NOT_ALLOWED', '写入计划引用了 Schema 之外的字段。');
  }
  const parameterNames = [...statement.matchAll(/:([a-z_][a-z0-9_]*)\b/gi)].map(
    (match) => match[1].toLowerCase()
  );
  const supplied = Object.keys(parameters).map((name) => name.toLowerCase());
  if (
    new Set(parameterNames).size !== requiredColumns.length ||
    requiredColumns.some((name) => !parameterNames.includes(name) || !supplied.includes(name)) ||
    supplied.some((name) => !requiredColumns.includes(name))
  ) {
    return reject('SQL_PARAMETER_MISMATCH', '写入参数与模板不一致。');
  }
  const schemaFingerprint = createSchemaFingerprint(schema);
  return Object.freeze({
    ok: true,
    operationType: operation,
    readOnly: false,
    requiresHumanReview: true,
    maxAffectedRows,
    policyVersion: WRITE_POLICY_VERSION,
    schemaFingerprint,
    planHash: createWritePlanHash({ sql, parameters, schemaFingerprint })
  });
}

module.exports = {
  POLICY_VERSION,
  WRITE_POLICY_VERSION,
  createPlanHash,
  createSchemaFingerprint,
  validateReadOnlySqlPlan,
  validateWriteSqlPlan
};
