const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CASE_COUNT_WIN_RATE_TEMPLATE_ID,
  DEFAULT_QUERY_TEXT,
  TEMPLATE_ID,
  planConstrainedText2Sql
} = require('../src/v1/constrained-text2sql-planner.cjs');

const SCHEMA = Object.freeze({
  dataSource: 'local.legal_cases',
  tableName: 'labor_cases',
  columns: Object.freeze([
    { name: 'year', type: 'INTEGER' },
    { name: 'issue_type', type: 'TEXT' },
    { name: 'outcome', type: 'TEXT' },
    { name: 'compensation_amount', type: 'INTEGER' }
  ])
});

function plan(redactedText, schema = SCHEMA) {
  return planConstrainedText2Sql({ piiRedacted: true, redactedText, schema });
}

test('generates a parameterized read-only template from the allowlisted Schema', () => {
  const result = plan('统计2024年至2025年未签劳动合同案件的胜诉率和赔偿中位数。');

  assert.equal(result.ok, true);
  assert.equal(result.templateId, TEMPLATE_ID);
  assert.match(result.sql, /^SELECT/);
  assert.match(result.sql, /FROM labor_cases/);
  assert.match(result.sql, /:start_year/);
  assert.equal(result.sql.includes('2024'), false);
  assert.deepEqual(result.parameters, {
    start_year: 2024,
    end_year: 2025,
    issue_type: '未签劳动合同'
  });
  assert.deepEqual(result.semanticQuery.yearRange, [2024, 2025]);
  assert.deepEqual(result.semanticQuery.aggregations, ['count', 'ratio', 'median']);
  assert.deepEqual(result.expectedOutput.columns, [
    'year',
    'case_count',
    'employee_win_rate',
    'median_compensation'
  ]);
  assert.equal(result.executionSteps.length, 3);
});

test('generates an independent case-count and win-rate template without compensation access', () => {
  const result = plan('查询案例库近三年未签劳动合同案件数量和胜诉率。');

  assert.equal(result.ok, true);
  assert.equal(result.templateId, CASE_COUNT_WIN_RATE_TEMPLATE_ID);
  assert.match(result.sql, /^SELECT year, outcome$/m);
  assert.equal(result.sql.includes('compensation_amount'), false);
  assert.deepEqual(result.semanticQuery.selectedColumns, ['year', 'outcome']);
  assert.deepEqual(result.semanticQuery.metrics, ['case_count', 'employee_win_rate']);
  assert.deepEqual(result.semanticQuery.aggregations, ['count', 'ratio']);
  assert.deepEqual(result.expectedOutput.columns, [
    'year',
    'case_count',
    'employee_win_rate'
  ]);
  assert.equal(result.expectedOutput.artifactFileName, '案件数量与胜诉率分析.md');
});

test('does not reinterpret an unspecified compensation amount metric as a median', () => {
  const result = plan('统计2025年未签劳动合同案件的胜诉率和赔偿金额。');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUERY_TEMPLATE_NOT_SUPPORTED');
});

test('maps the bounded near-three-years phrase to deterministic configured years', () => {
  const result = plan(DEFAULT_QUERY_TEXT);

  assert.equal(result.ok, true);
  assert.deepEqual(result.parameters, {
    start_year: 2023,
    end_year: 2025,
    issue_type: '未签劳动合同'
  });
});

test('rejects writes, raw SQL, unknown templates, and ambiguous ranges', () => {
  const cases = [
    ['删除全部案例并统计胜诉率和赔偿中位数。', 'WRITE_OPERATION_BLOCKED'],
    [
      'SELECT year FROM labor_cases WHERE year = 2025; 统计未签劳动合同胜诉率和赔偿中位数。',
      'RAW_SQL_INPUT_BLOCKED'
    ],
    ['统计2025年知识产权案件数量。', 'QUERY_TEMPLATE_NOT_SUPPORTED'],
    [
      '统计2022年、2023年和2024年未签劳动合同案件胜诉率和赔偿中位数。',
      'TEXT2SQL_YEAR_RANGE_AMBIGUOUS'
    ]
  ];

  for (const [redactedText, code] of cases) {
    const result = plan(redactedText);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes(redactedText), false);
  }
});

test('fails closed when required Schema columns or a year range are missing', () => {
  const schemaWithoutCompensation = {
    ...SCHEMA,
    columns: SCHEMA.columns.filter((column) => column.name !== 'compensation_amount')
  };
  const missingColumn = plan(DEFAULT_QUERY_TEXT, schemaWithoutCompensation);
  assert.equal(missingColumn.code, 'TEXT2SQL_SCHEMA_UNSUPPORTED');
  assert.deepEqual(missingColumn.missingColumns, ['compensation_amount']);

  const independentTemplate = plan(
    '统计2025年未签劳动合同案件数量和胜诉率。',
    schemaWithoutCompensation
  );
  assert.equal(independentTemplate.ok, true);
  assert.equal(independentTemplate.templateId, CASE_COUNT_WIN_RATE_TEMPLATE_ID);

  const missingRange = plan('统计未签劳动合同案件的胜诉率和赔偿中位数。');
  assert.equal(missingRange.code, 'TEXT2SQL_YEAR_RANGE_REQUIRED');
});

test('rejects raw or unsanitized envelopes without throwing', () => {
  const raw = planConstrainedText2Sql({
    piiRedacted: false,
    redactedText: DEFAULT_QUERY_TEXT,
    schema: SCHEMA
  });
  assert.equal(raw.code, 'TEXT2SQL_INPUT_INVALID');
});
