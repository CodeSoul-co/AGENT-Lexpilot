const LEGAL_DOMAINS = Object.freeze({
  LABOR: 'labor',
  MARRIAGE_FAMILY: 'marriage_family',
  PRIVATE_LENDING: 'private_lending',
  TAXATION: 'taxation',
  INTELLECTUAL_PROPERTY: 'intellectual_property'
});

const DOMAIN_LABELS = Object.freeze({
  [LEGAL_DOMAINS.LABOR]: '劳动用工',
  [LEGAL_DOMAINS.MARRIAGE_FAMILY]: '婚姻家庭',
  [LEGAL_DOMAINS.PRIVATE_LENDING]: '民间借贷',
  [LEGAL_DOMAINS.TAXATION]: '税务',
  [LEGAL_DOMAINS.INTELLECTUAL_PROPERTY]: '知识产权'
});

const DOMAIN_SIGNALS = Object.freeze({
  [LEGAL_DOMAINS.LABOR]: [
    ['劳动合同', 5],
    ['辞退', 4],
    ['开除', 4],
    ['解雇', 4],
    ['不用来了', 4],
    ['工资', 3],
    ['社保', 3],
    ['加班', 3],
    ['离职', 2],
    ['老板', 2],
    ['公司', 1]
  ],
  [LEGAL_DOMAINS.MARRIAGE_FAMILY]: [
    ['抚养权', 5],
    ['家庭暴力', 5],
    ['家暴', 5],
    ['重婚', 5],
    ['离婚', 4],
    ['逼婚', 4],
    ['夫妻', 3],
    ['结婚', 3],
    ['婚姻', 3],
    ['共同财产', 3],
    ['配偶', 3],
    ['已婚', 3],
    ['丈夫', 3],
    ['妻子', 3],
    ['老公', 3],
    ['老婆', 3],
    ['同居', 2]
  ],
  [LEGAL_DOMAINS.PRIVATE_LENDING]: [
    ['借钱', 5],
    ['借款', 5],
    ['欠钱', 5],
    ['借条', 4],
    ['还款', 3],
    ['利息', 2],
    ['转账', 1]
  ],
  [LEGAL_DOMAINS.TAXATION]: [
    ['个人所得税', 6],
    ['个税', 5],
    ['税务', 4],
    ['纳税', 4],
    ['补税', 4],
    ['报税', 4],
    ['发票', 3],
    ['扣税', 3]
  ],
  [LEGAL_DOMAINS.INTELLECTUAL_PROPERTY]: [
    ['著作权', 6],
    ['版权', 5],
    ['商标', 5],
    ['专利', 5],
    ['盗版', 4],
    ['抄袭', 4],
    ['转载', 3],
    ['侵权', 2],
    ['作品', 2]
  ]
});

function classifyLegalDomain(redactedText) {
  if (typeof redactedText !== 'string' || redactedText.trim().length === 0) {
    return { status: 'unsupported', confidence: 0, candidates: [] };
  }

  const scores = Object.entries(DOMAIN_SIGNALS).map(([domain, signals]) => {
    const matchedSignals = signals.filter(([signal]) => redactedText.includes(signal));
    return {
      domain,
      score: matchedSignals.reduce((total, [, weight]) => total + weight, 0),
      matchedSignalCount: matchedSignals.length
    };
  });
  scores.sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain));

  const topScore = scores[0].score;
  if (topScore === 0) {
    return { status: 'unsupported', confidence: 0, candidates: [] };
  }

  const candidates = scores.filter((item) => item.score === topScore).map((item) => item.domain);
  if (candidates.length > 1) {
    return { status: 'ambiguous', confidence: 0, candidates };
  }

  const totalScore = scores.reduce((total, item) => total + item.score, 0);
  return {
    status: 'classified',
    domain: scores[0].domain,
    confidence: Number((topScore / totalScore).toFixed(3)),
    candidates: [scores[0].domain],
    matchedSignalCount: scores[0].matchedSignalCount
  };
}

module.exports = { LEGAL_DOMAINS, DOMAIN_LABELS, classifyLegalDomain };
