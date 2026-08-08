const ANALYSIS_QUESTION_DEFINITIONS = Object.freeze({
  analysisMetrics: Object.freeze({
    questionId: 'analysis-metrics',
    fieldName: 'analysisMetrics',
    prompt: '这次最希望查看哪些指标，例如案件数量、胜诉率或赔偿金额中位数？',
    allowedValues: Object.freeze([]),
    options: Object.freeze([])
  }),
  analysisTimeRange: Object.freeze({
    questionId: 'analysis-time-range',
    fieldName: 'analysisTimeRange',
    prompt: '希望分析哪个时间范围？可以填写明确年份或“近三年”。',
    allowedValues: Object.freeze([]),
    options: Object.freeze([])
  })
});

function parseProfessionalAnalysisIntent(redactedText) {
  if (typeof redactedText !== 'string' || redactedText.trim().length === 0) {
    throw new TypeError('Professional analysis intent requires redacted text.');
  }
  const text = redactedText.trim();
  const writeLike = /\b(?:insert|update|delete|drop|alter|truncate|create|replace)\b|新增|写入|更新|修改|删除|清空|建表/i.test(text);
  const metrics = [
    [/案件(?:数|数量|总数)|案例(?:数|数量|总数)/, '案件数量'],
    [/胜诉率/, '胜诉率'],
    [/赔偿(?:金额)?.{0,4}中位数|赔偿中位数/, '赔偿金额中位数'],
    [/平均(?:值|数|金额)?/, '平均值'],
    [/趋势/, '趋势'],
    [/分布/, '分布']
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const years = [...new Set(text.match(/(?:19|20)\d{2}/g) ?? [])].map(Number).sort();
  const relativeRange = text.match(/近\s*([一二三四五六七八九十百\d]+)\s*年/)?.[0];
  const timeRange = years.length > 0 ? years : relativeRange ?? null;
  const missingFields = [];
  if (!writeLike && metrics.length === 0) missingFields.push('analysisMetrics');
  if (!writeLike && timeRange === null) missingFields.push('analysisTimeRange');
  const questions = missingFields.slice(0, 2).map((field) => ANALYSIS_QUESTION_DEFINITIONS[field]);
  return Object.freeze({
    status: questions.length > 0 ? 'needs_clarification' : 'ready',
    objective: text.slice(0, 500),
    metrics: Object.freeze(metrics),
    dimensions: Object.freeze(/按年|年度|每年/.test(text) ? ['年度'] : []),
    filters: Object.freeze(/未签.{0,4}劳动合同/.test(text) ? ['未签劳动合同'] : []),
    timeRange,
    missingFields: Object.freeze(missingFields),
    questions: Object.freeze(questions.map((question) => question.prompt)),
    questionContracts: Object.freeze(questions)
  });
}

module.exports = { ANALYSIS_QUESTION_DEFINITIONS, parseProfessionalAnalysisIntent };
