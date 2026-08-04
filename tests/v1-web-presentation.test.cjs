const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildPresentation,
  resolveColumnKeys
} = require('../web/v1-presentation.js');

function configuredResult(overrides = {}) {
  return {
    schema: { dataSource: 'local.legal_cases', tableName: 'labor_cases' },
    plan: {
      semanticQuery: { yearRange: [2023, 2025] },
      expectedOutput: {
        columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
        artifactFileName: '案例统计分析.md'
      }
    },
    result: {
      columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
      rows: [
        {
          year: 2025,
          case_count: 2,
          employee_win_rate: 50,
          median_compensation: 12000
        }
      ],
      sourceRowCount: 2,
      resultGroupCount: 1
    },
    safety: { dataClassification: 'configured-business-data' },
    ...overrides
  };
}

test('builds the configured compensation template table and non-demo report copy', () => {
  const presentation = buildPresentation(configuredResult());

  assert.equal(presentation.title, '2023-2025 年案例统计分析');
  assert.deepEqual(
    presentation.table.columns.map((column) => column.label),
    ['年份', '案例数', '劳动者胜诉率', '赔偿中位数']
  );
  assert.deepEqual(presentation.table.rows, [['2025', '2', '50%', '¥12,000']]);
  assert.equal(presentation.isDemo, false);
  assert.match(presentation.summary, /本次只读查询匹配 2 条记录/);
  assert.equal(presentation.disclaimer, '本结果是对已配置数据源的统计输出，不构成法律意见。');
});

test('keeps the case-count template free of compensation data in tables and PDF inputs', () => {
  const data = configuredResult({
    plan: {
      semanticQuery: { yearRange: [2024, 2025] },
      expectedOutput: {
        columns: ['year', 'case_count', 'employee_win_rate'],
        artifactFileName: '案件数量与胜诉率分析.md'
      }
    },
    result: {
      columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
      rows: [
        {
          year: 2025,
          case_count: 2,
          employee_win_rate: 50,
          median_compensation: 999999,
          private_note: 'must-not-render'
        }
      ],
      sourceRowCount: 2,
      resultGroupCount: 1
    }
  });
  const presentation = buildPresentation(data);
  const serialized = JSON.stringify(presentation);

  assert.equal(presentation.title, '2024-2025 年案件数量与胜诉率分析');
  assert.deepEqual(resolveColumnKeys(data), ['year', 'case_count', 'employee_win_rate']);
  assert.deepEqual(
    presentation.table.columns.map((column) => column.label),
    ['年份', '案例数', '劳动者胜诉率']
  );
  assert.deepEqual(presentation.table.rows, [['2025', '2', '50%']]);
  assert.equal(serialized.includes('999999'), false);
  assert.equal(serialized.includes('must-not-render'), false);
  assert.equal(serialized.includes('赔偿'), false);
});

test('filters unknown result fields when no explicit output contract is available', () => {
  const data = configuredResult({
    plan: {},
    result: {
      columns: ['year', 'case_id', 'private_note', 'employee_win_rate'],
      rows: [{ year: 2025, case_id: 'LC-PRIVATE', private_note: 'secret', employee_win_rate: 75 }]
    }
  });

  assert.deepEqual(resolveColumnKeys(data), ['year', 'employee_win_rate']);
  assert.deepEqual(buildPresentation(data).table.rows, [['2025', '75%']]);
});

test('preserves the anonymous demo summary when the legacy demo runtime has no output contract', () => {
  const presentation = buildPresentation({
    schema: { displayName: '匿名劳动争议案例库' },
    plan: {},
    result: {
      columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
      rows: [{ year: 2025, case_count: 10, employee_win_rate: 60, median_compensation: 20000 }],
      sourceCaseCount: 100,
      matchedCaseCount: 10,
      resultGroupCount: 1
    },
    safety: { dataClassification: 'anonymous-synthetic-demo-data' },
    artifact: { fileName: '案例统计分析.md' }
  });

  assert.equal(presentation.isDemo, true);
  assert.equal(presentation.title, '近三年案例统计分析');
  assert.match(presentation.summary, /匿名合成演示案例共 100 条/);
  assert.match(presentation.disclaimer, /仅用于产品功能演示/);
});
