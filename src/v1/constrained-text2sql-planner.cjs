const TEMPLATE_ID = 'labor-case-yearly-outcome-statistics.v1';
const DEFAULT_START_YEAR = 2023;
const DEFAULT_END_YEAR = 2025;
const DEFAULT_QUERY_TEXT = '统计近三年案例库中未签劳动合同案件的胜诉率和赔偿中位数。';
const DEFAULT_QUERY_PARAMETERS = Object.freeze({
  start_year: DEFAULT_START_YEAR,
  end_year: DEFAULT_END_YEAR,
  issue_type: '未签劳动合同'
});
const REQUIRED_COLUMNS = Object.freeze([
  'year',
  'issue_type',
  'outcome',
  'compensation_amount'
]);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WRITE_PATTERN =
  /\b(?:insert|update|delete|drop|alter|truncate|create|replace|grant|revoke)\b|新增|写入|修改|删除|清空|建表/i;
const RAW_SQL_PATTERN = /\b(?:select|from|where|join|union|pragma|attach|detach)\b|;/i;

function reject(code, message) {
  return Object.freeze({ ok: false, code, message });
}

function validateSchema(schema) {
  if (
    !schema ||
    typeof schema !== 'object' ||
    typeof schema.tableName !== 'string' ||
    !IDENTIFIER_PATTERN.test(schema.tableName) ||
    !Array.isArray(schema.columns)
  ) {
    return reject('TEXT2SQL_SCHEMA_INVALID', '当前 Schema 不能用于受约束查询规划。');
  }
  const columnNames = new Set(
    schema.columns
      .map((column) => column?.name)
      .filter((name) => typeof name === 'string' && IDENTIFIER_PATTERN.test(name))
  );
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !columnNames.has(column));
  if (missingColumns.length > 0) {
    return Object.freeze({
      ...reject('TEXT2SQL_SCHEMA_UNSUPPORTED', '当前 Schema 缺少查询模板所需字段。'),
      missingColumns: Object.freeze(missingColumns)
    });
  }
  return Object.freeze({ ok: true, tableName: schema.tableName });
}

function extractYearRange(redactedText, options) {
  const years = [...new Set(redactedText.match(/(?:19|20)\d{2}/g) ?? [])].map(Number);
  if (years.length > 2) {
    return reject('TEXT2SQL_YEAR_RANGE_AMBIGUOUS', '查询包含超过两个不同年份，无法确定范围。');
  }
  if (years.length === 1) {
    return Object.freeze({ ok: true, startYear: years[0], endYear: years[0] });
  }
  if (years.length === 2) {
    const [startYear, endYear] = years.sort((left, right) => left - right);
    if (endYear - startYear > 10) {
      return reject('TEXT2SQL_YEAR_RANGE_TOO_WIDE', '查询年份范围不能超过十年。');
    }
    return Object.freeze({ ok: true, startYear, endYear });
  }
  if (!/近三年/.test(redactedText)) {
    return reject('TEXT2SQL_YEAR_RANGE_REQUIRED', '查询必须提供明确年份或“近三年”范围。');
  }
  const startYear = options.defaultStartYear ?? DEFAULT_START_YEAR;
  const endYear = options.defaultEndYear ?? DEFAULT_END_YEAR;
  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(endYear) ||
    startYear > endYear ||
    endYear - startYear !== 2
  ) {
    throw new TypeError('defaultStartYear/defaultEndYear must define exactly three years.');
  }
  return Object.freeze({ ok: true, startYear, endYear });
}

function buildSql(tableName) {
  return [
    'SELECT year, outcome, compensation_amount',
    `FROM ${tableName}`,
    'WHERE year BETWEEN :start_year AND :end_year AND issue_type = :issue_type',
    'ORDER BY year;'
  ].join('\n');
}

function planConstrainedText2Sql(input, options = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    input.piiRedacted !== true ||
    typeof input.redactedText !== 'string' ||
    input.redactedText.trim().length === 0
  ) {
    return reject('TEXT2SQL_INPUT_INVALID', '受约束查询规划只接受非空脱敏文本。');
  }
  const redactedText = input.redactedText.trim();
  if (WRITE_PATTERN.test(redactedText)) {
    return reject('WRITE_OPERATION_BLOCKED', '当前数据源模式只允许只读查询。');
  }
  if (RAW_SQL_PATTERN.test(redactedText)) {
    return reject('RAW_SQL_INPUT_BLOCKED', '不接受用户提供的原始 SQL。');
  }
  if (
    !/未签.{0,4}劳动合同/.test(redactedText) ||
    !/胜诉率/.test(redactedText) ||
    !/赔偿.{0,4}(?:中位数|金额)/.test(redactedText)
  ) {
    return reject(
      'QUERY_TEMPLATE_NOT_SUPPORTED',
      '当前仅支持未签劳动合同案例的年度胜诉率与赔偿中位数模板。'
    );
  }
  const schemaResult = validateSchema(input.schema);
  if (!schemaResult.ok) return schemaResult;
  const yearRange = extractYearRange(redactedText, options);
  if (!yearRange.ok) return yearRange;
  const parameters = Object.freeze({
    start_year: yearRange.startYear,
    end_year: yearRange.endYear,
    issue_type: '未签劳动合同'
  });
  return Object.freeze({
    ok: true,
    templateId: TEMPLATE_ID,
    sql: buildSql(schemaResult.tableName),
    parameters,
    explanation: `按 ${yearRange.startYear}-${yearRange.endYear} 年读取未签劳动合同案例，再计算案例数、劳动者胜诉率和胜诉赔偿中位数。`,
    semanticQuery: Object.freeze({
      table: schemaResult.tableName,
      yearRange: Object.freeze([yearRange.startYear, yearRange.endYear]),
      issueType: '未签劳动合同',
      metrics: Object.freeze(['case_count', 'employee_win_rate', 'median_compensation'])
    })
  });
}

const DEFAULT_QUERY_SQL = buildSql('labor_cases');

module.exports = {
  DEFAULT_QUERY_PARAMETERS,
  DEFAULT_QUERY_SQL,
  DEFAULT_QUERY_TEXT,
  REQUIRED_COLUMNS,
  TEMPLATE_ID,
  planConstrainedText2Sql,
  validateSchema
};
