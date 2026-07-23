const TASK_TYPES = Object.freeze({
  LEGAL_SELF_CHECK: 'legal_self_check',
  PROFESSIONAL_DATA_QUERY: 'professional_data_query'
});

const TASK_TYPE_LABELS = Object.freeze({
  [TASK_TYPES.LEGAL_SELF_CHECK]: 'V0 法律自检',
  [TASK_TYPES.PROFESSIONAL_DATA_QUERY]: 'V1 专业结构化数据查询'
});

const TASK_TYPE_CLASSIFICATION_METHOD = 'deterministic_v0_v1_signals_v0';
const PROFESSIONAL_QUERY_THRESHOLD = 3;

const PROFESSIONAL_QUERY_SIGNALS = Object.freeze([
  { id: 'explicit_sql', pattern: /\b(?:select|insert|update|delete|sql)\b/i, weight: 4 },
  { id: 'schema_reference', pattern: /\bschema\b|表名|字段名|字段类型/i, weight: 3 },
  { id: 'structured_data_source', pattern: /数据库|数据源|案例库|合同库|数据表/i, weight: 3 },
  { id: 'analytic_metric', pattern: /统计|胜诉率|中位数|平均值|趋势|分布|总数|数量/i, weight: 2 },
  { id: 'time_window', pattern: /近\s*[一二三四五六七八九十百\d]+\s*年|按(?:年|月|季度)|同比|环比/i, weight: 1 },
  { id: 'result_artifact', pattern: /表格|图表|报表|导出/i, weight: 1 },
  { id: 'query_action', pattern: /查询|筛选|检索/i, weight: 1 }
]);

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Task classification input must be an object.');
  }
  const allowedKeys = new Set(['piiRedacted', 'redactedText']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Task classification input contains undeclared fields.');
  }
  if (input.piiRedacted !== true) {
    throw new TypeError('Task classification requires redacted input.');
  }
  if (typeof input.redactedText !== 'string' || input.redactedText.trim().length === 0) {
    throw new TypeError('redactedText must be a non-empty string.');
  }
}

function classifyBusinessTask(input) {
  validateInput(input);
  const matchedSignals = PROFESSIONAL_QUERY_SIGNALS.filter(({ pattern }) =>
    pattern.test(input.redactedText)
  );
  const professionalQueryScore = matchedSignals.reduce(
    (total, signal) => total + signal.weight,
    0
  );
  const taskType =
    professionalQueryScore >= PROFESSIONAL_QUERY_THRESHOLD
      ? TASK_TYPES.PROFESSIONAL_DATA_QUERY
      : TASK_TYPES.LEGAL_SELF_CHECK;

  return {
    status: 'classified',
    taskType,
    taskTypeLabel: TASK_TYPE_LABELS[taskType],
    confidence:
      taskType === TASK_TYPES.LEGAL_SELF_CHECK
        ? 'conservative_default'
        : professionalQueryScore >= 5
          ? 'high'
          : 'medium',
    matchedSignals: matchedSignals.map(({ id }) => id),
    classificationMethod: TASK_TYPE_CLASSIFICATION_METHOD,
    trace: [
      {
        type: 'business.task-type.classified',
        data: {
          taskType,
          matchedSignalCount: matchedSignals.length,
          classificationMethod: TASK_TYPE_CLASSIFICATION_METHOD
        }
      }
    ]
  };
}

module.exports = {
  TASK_TYPES,
  TASK_TYPE_LABELS,
  TASK_TYPE_CLASSIFICATION_METHOD,
  classifyBusinessTask
};
