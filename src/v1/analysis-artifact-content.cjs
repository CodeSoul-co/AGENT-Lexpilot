function requireExecutionTimeMs(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('executionTimeMs must be a non-negative safe integer.');
  }
  return value;
}

function buildWinRateChart(rows) {
  return rows.map((row) => {
    const rate = Number(row.employee_win_rate);
    const safeRate = Number.isFinite(rate) ? Math.max(0, Math.min(100, rate)) : 0;
    const bar = '█'.repeat(Math.round(safeRate / 5));
    return `${row.year} | ${bar.padEnd(20, '░')} ${safeRate}%`;
  });
}

function buildExecutionEvidence({ sql, executionTimeMs, rows }) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new TypeError('sql must be a non-empty string.');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array.');
  }
  const duration = requireExecutionTimeMs(executionTimeMs);
  return [
    '## 执行信息',
    '',
    `执行耗时：${duration} ms`,
    '',
    '参数化 SQL 原文（不包含绑定参数值）：',
    '',
    '```sql',
    sql.trim(),
    '```',
    '',
    '## 劳动者胜诉率图表',
    '',
    '```text',
    ...buildWinRateChart(rows),
    '```'
  ];
}

module.exports = {
  buildExecutionEvidence,
  buildWinRateChart,
  requireExecutionTimeMs
};
