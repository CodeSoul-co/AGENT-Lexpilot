const TEMPLATE_IDS = Object.freeze({
  OUTCOME_AND_COMPENSATION: 'labor-case-yearly-outcome-statistics.v1',
  CASE_COUNT_AND_WIN_RATE: 'labor-case-yearly-count-win-rate.v1'
});
const TEMPLATE_ID = TEMPLATE_IDS.OUTCOME_AND_COMPENSATION;
const CASE_COUNT_WIN_RATE_TEMPLATE_ID = TEMPLATE_IDS.CASE_COUNT_AND_WIN_RATE;
const DEFAULT_START_YEAR = 2023;
const DEFAULT_END_YEAR = 2025;
const DEFAULT_QUERY_TEXT = '统计近三年案例库中未签劳动合同案件的胜诉率和赔偿中位数。';
const DEFAULT_QUERY_PARAMETERS = Object.freeze({
  start_year: DEFAULT_START_YEAR,
  end_year: DEFAULT_END_YEAR,
  issue_type: '未签劳动合同'
});
const COMMON_REQUIRED_COLUMNS = Object.freeze(['year', 'issue_type', 'outcome']);
const REQUIRED_COLUMNS = Object.freeze([...COMMON_REQUIRED_COLUMNS, 'compensation_amount']);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WRITE_PATTERN =
  /\b(?:insert|update|delete|drop|alter|truncate|create|replace|grant|revoke)\b|新增|写入|修改|删除|清空|建表/i;
const RAW_SQL_PATTERN = /\b(?:select|from|where|join|union|pragma|attach|detach)\b|;/i;
const ISSUE_PATTERN = /未签.{0,4}劳动合同/;
const WIN_RATE_PATTERN = /胜诉率/;
const COMPENSATION_PATTERN = /赔偿(?:金额)?.{0,4}中位数/;
const CASE_COUNT_PATTERN = /(?:案件|案例)(?:总数|数量|数)/;

const TEMPLATES = Object.freeze({
  [TEMPLATE_IDS.OUTCOME_AND_COMPENSATION]: Object.freeze({
    templateId: TEMPLATE_IDS.OUTCOME_AND_COMPENSATION,
    requiredColumns: REQUIRED_COLUMNS,
    selectedColumns: Object.freeze(['year', 'outcome', 'compensation_amount']),
    metrics: Object.freeze(['case_count', 'employee_win_rate', 'median_compensation']),
    resultColumns: Object.freeze([
      'year',
      'case_count',
      'employee_win_rate',
      'median_compensation'
    ]),
    aggregations: Object.freeze(['count', 'ratio', 'median']),
    artifactFileName: '案例统计分析.md',
    explanation(yearRange) {
      return `按 ${yearRange.startYear}-${yearRange.endYear} 年读取未签劳动合同案例，再计算案例数、劳动者胜诉率和胜诉赔偿中位数。`;
    }
  }),
  [TEMPLATE_IDS.CASE_COUNT_AND_WIN_RATE]: Object.freeze({
    templateId: TEMPLATE_IDS.CASE_COUNT_AND_WIN_RATE,
    requiredColumns: COMMON_REQUIRED_COLUMNS,
    selectedColumns: Object.freeze(['year', 'outcome']),
    metrics: Object.freeze(['case_count', 'employee_win_rate']),
    resultColumns: Object.freeze(['year', 'case_count', 'employee_win_rate']),
    aggregations: Object.freeze(['count', 'ratio']),
    artifactFileName: '案件数量与胜诉率分析.md',
    explanation(yearRange) {
      return `按 ${yearRange.startYear}-${yearRange.endYear} 年读取未签劳动合同案例，再计算各年度案件数和劳动者胜诉率。`;
    }
  })
});

function reject(code, message) {
  return Object.freeze({ ok: false, code, message });
}

function validateSchema(schema, requiredColumns = REQUIRED_COLUMNS) {
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
  const missingColumns = requiredColumns.filter((column) => !columnNames.has(column));
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

function resolveTemplate(redactedText) {
  if (!ISSUE_PATTERN.test(redactedText) || !WIN_RATE_PATTERN.test(redactedText)) {
    return undefined;
  }
  if (COMPENSATION_PATTERN.test(redactedText)) {
    return TEMPLATES[TEMPLATE_IDS.OUTCOME_AND_COMPENSATION];
  }
  if (CASE_COUNT_PATTERN.test(redactedText)) {
    return TEMPLATES[TEMPLATE_IDS.CASE_COUNT_AND_WIN_RATE];
  }
  return undefined;
}

function buildSql(tableName, selectedColumns = TEMPLATES[TEMPLATE_ID].selectedColumns) {
  return [
    `SELECT ${selectedColumns.join(', ')}`,
    `FROM ${tableName}`,
    'WHERE year BETWEEN :start_year AND :end_year AND issue_type = :issue_type',
    'ORDER BY year;'
  ].join('\n');
}

function buildExpectedOutput(template) {
  return Object.freeze({
    columns: template.resultColumns,
    chart: Object.freeze({
      type: 'bar',
      metric: 'employee_win_rate',
      seriesName: '胜诉率 %'
    }),
    artifacts: Object.freeze(['table', 'chart', 'analysis-document']),
    artifactFileName: template.artifactFileName
  });
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
  const template = resolveTemplate(redactedText);
  if (!template) {
    return reject(
      'QUERY_TEMPLATE_NOT_SUPPORTED',
      '当前仅支持未签劳动合同案例的年度案件数、胜诉率与可选赔偿中位数模板。'
    );
  }
  const schemaResult = validateSchema(input.schema, template.requiredColumns);
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
    templateId: template.templateId,
    sql: buildSql(schemaResult.tableName, template.selectedColumns),
    parameters,
    explanation: template.explanation(yearRange),
    executionSteps: Object.freeze([
      '核对真实白名单 Schema 与模板所需字段。',
      '使用命名参数执行固定形状的只读 SELECT。',
      '按年份计算允许的聚合指标并生成表格、图表和分析文档。'
    ]),
    expectedOutput: buildExpectedOutput(template),
    semanticQuery: Object.freeze({
      table: schemaResult.tableName,
      selectedColumns: template.selectedColumns,
      yearRange: Object.freeze([yearRange.startYear, yearRange.endYear]),
      issueType: '未签劳动合同',
      metrics: template.metrics,
      aggregations: template.aggregations
    })
  });
}

const DEFAULT_QUERY_SQL = buildSql('labor_cases');

module.exports = {
  CASE_COUNT_WIN_RATE_TEMPLATE_ID,
  COMMON_REQUIRED_COLUMNS,
  DEFAULT_QUERY_PARAMETERS,
  DEFAULT_QUERY_SQL,
  DEFAULT_QUERY_TEXT,
  REQUIRED_COLUMNS,
  TEMPLATE_ID,
  TEMPLATE_IDS,
  planConstrainedText2Sql,
  validateSchema
};
