(function exposeV1Presentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LexPilotV1Presentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function createV1Presentation() {
  'use strict';

  const COLUMN_DEFINITIONS = Object.freeze({
    year: Object.freeze({ key: 'year', label: '年份' }),
    case_count: Object.freeze({ key: 'case_count', label: '案例数' }),
    employee_win_rate: Object.freeze({ key: 'employee_win_rate', label: '劳动者胜诉率' }),
    median_compensation: Object.freeze({ key: 'median_compensation', label: '赔偿中位数' })
  });
  const DEFAULT_COLUMNS = Object.freeze([
    'year',
    'case_count',
    'employee_win_rate',
    'median_compensation'
  ]);

  function isDemoResult(data) {
    return (
      data?.safety?.dataClassification === 'anonymous-synthetic-demo-data' ||
      Number.isSafeInteger(data?.result?.sourceCaseCount)
    );
  }

  function resolveColumnKeys(data) {
    const contracted = data?.plan?.expectedOutput?.columns;
    const reported = data?.result?.columns;
    const inferred = Object.keys(data?.result?.rows?.[0] ?? {});
    const candidates = Array.isArray(contracted) && contracted.length
      ? contracted
      : Array.isArray(reported) && reported.length
        ? reported
        : inferred.length
          ? inferred
          : DEFAULT_COLUMNS;
    return [...new Set(candidates)].filter((key) =>
      Object.prototype.hasOwnProperty.call(COLUMN_DEFINITIONS, key)
    );
  }

  function formatCell(key, value) {
    if (value === null || value === undefined) return '—';
    if (key === 'employee_win_rate') {
      const number = Number(value);
      return Number.isFinite(number) ? `${number}%` : '—';
    }
    if (key === 'median_compensation') {
      const number = Number(value);
      return Number.isFinite(number) ? `¥${number.toLocaleString('zh-CN')}` : '—';
    }
    return String(value);
  }

  function buildTable(data) {
    const keys = resolveColumnKeys(data);
    const columns = keys.map((key) => COLUMN_DEFINITIONS[key]);
    const rows = (Array.isArray(data?.result?.rows) ? data.result.rows : []).map((row) =>
      keys.map((key) => formatCell(key, row?.[key]))
    );
    return Object.freeze({ columns: Object.freeze(columns), rows: Object.freeze(rows) });
  }

  function buildTitle(data) {
    const configuredName =
      data?.plan?.expectedOutput?.artifactFileName ?? data?.artifact?.fileName;
    const baseName = typeof configuredName === 'string'
      ? configuredName.replace(/\.md$/i, '')
      : '案例统计分析';
    const yearRange = data?.plan?.semanticQuery?.yearRange;
    if (
      Array.isArray(yearRange) &&
      yearRange.length === 2 &&
      Number.isInteger(yearRange[0]) &&
      Number.isInteger(yearRange[1])
    ) {
      const range = yearRange[0] === yearRange[1]
        ? `${yearRange[0]} 年`
        : `${yearRange[0]}-${yearRange[1]} 年`;
      return `${range}${baseName}`;
    }
    return baseName === '案例统计分析' ? '近三年案例统计分析' : baseName;
  }

  function buildCounts(data) {
    const result = data?.result ?? {};
    const sourceCount = Number.isSafeInteger(result.sourceCaseCount)
      ? result.sourceCaseCount
      : Number.isSafeInteger(result.sourceRowCount)
        ? result.sourceRowCount
        : null;
    const matchedCount = Number.isSafeInteger(result.matchedCaseCount)
      ? result.matchedCaseCount
      : Number.isSafeInteger(result.sourceRowCount)
        ? result.sourceRowCount
        : null;
    const groupCount = Number.isSafeInteger(result.resultGroupCount)
      ? result.resultGroupCount
      : Array.isArray(result.rows)
        ? result.rows.length
        : null;
    return Object.freeze({ sourceCount, matchedCount, groupCount });
  }

  function displayCount(value, pendingText = '待执行') {
    return Number.isSafeInteger(value) ? String(value) : pendingText;
  }

  function buildPresentation(data) {
    const demo = isDemoResult(data);
    const counts = buildCounts(data);
    const dataSourceName =
      data?.schema?.displayName ?? data?.schema?.dataSource ?? '已配置数据源';
    const sourceDescription = demo
      ? `${dataSourceName}（${displayCount(counts.sourceCount)} 条匿名合成演示案例）`
      : `${dataSourceName}（本次只读查询匹配 ${displayCount(counts.matchedCount)} 条记录）`;
    const summary = demo
      ? `匿名合成演示案例共 ${displayCount(counts.sourceCount)} 条，本次匹配 ${displayCount(counts.matchedCount)} 条，并按 ${displayCount(counts.groupCount)} 个年度汇总。`
      : `已配置数据源本次只读查询匹配 ${displayCount(counts.matchedCount)} 条记录，并按 ${displayCount(counts.groupCount)} 个年度汇总。`;
    const disclaimer = demo
      ? '本结果基于匿名合成演示数据生成，仅用于产品功能演示，不代表真实案例库统计或法律意见。'
      : '本结果是对已配置数据源的统计输出，不构成法律意见。';
    return Object.freeze({
      title: buildTitle(data),
      table: buildTable(data),
      counts,
      dataSourceName,
      sourceDescription,
      summary,
      disclaimer,
      isDemo: demo
    });
  }

  return Object.freeze({
    COLUMN_DEFINITIONS,
    buildPresentation,
    buildTable,
    buildTitle,
    formatCell,
    resolveColumnKeys
  });
});
