const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');
const { COMPARISON_RULES, compareFactsToLaw } = require('../src/v0/law-comparison-engine.cjs');
const { buildLegalResultCards } = require('../src/v0/legal-result-card-builder.cjs');

function positiveFacts(entry) {
  if (entry.id === 'cn.labor-contract-law.article-40') {
    return {
      issueType: 'dismissal',
      dismissalGround: 'performance',
      noticeOrPayStatus: 'neither',
      performanceRemediationOutcome: 'training_or_adjustment_still_unqualified'
    };
  }
  return Object.fromEntries(
    Object.entries(entry.matching.factRequirements).map(([field, values]) => [field, values[0]])
  );
}

function negativeFacts(entry) {
  if (entry.id === 'cn.labor-contract-law.article-40') return { issueType: 'unpaid_wages' };
  const facts = positiveFacts(entry);
  const [field, values] = Object.entries(entry.matching.factExclusions)[0];
  facts[field] = values[0];
  return facts;
}

function comparison(entry, knownFacts) {
  const message = entry.id === 'cn.labor-contract-law.article-40'
    ? '公司辞退并说明了通知和工资事实。'
    : `${entry.matching.excerptSignals[0]}相关事实已说明。`;
  return compareFactsToLaw({
    piiRedacted: true,
    legalDomain: entry.legalDomain,
    knownFacts,
    redactedMessages: [message],
    lawReferences: [entry]
  }).comparisons[0];
}

function main() {
  const corpus = loadLawCorpus();
  const failures = [];
  const counts = {
    retrievalEnabled: 0,
    matchingRules: Object.keys(COMPARISON_RULES).length,
    positivePassed: 0,
    negativePassed: 0,
    insufficientPassed: 0,
    resultCardPassed: 0
  };
  for (const entry of corpus.entries) {
    if (entry.retrievalEnabled === true) counts.retrievalEnabled += 1;
    const positive = comparison(entry, positiveFacts(entry));
    if (positive?.comparisonStatus === 'potential_match' && positive.legalConclusionGenerated === false) counts.positivePassed += 1;
    else failures.push({ id: entry.id, gate: 'positive' });
    const negative = comparison(entry, negativeFacts(entry));
    if (negative?.comparisonStatus === 'not_supported_by_facts' && negative.legalConclusionGenerated === false) counts.negativePassed += 1;
    else failures.push({ id: entry.id, gate: 'negative' });
    const insufficientFacts = positiveFacts(entry);
    delete insufficientFacts[entry.id === 'cn.labor-contract-law.article-40' ? 'dismissalGround' : entry.matching.safeStopFields[0]];
    const insufficient = comparison(entry, insufficientFacts);
    if (insufficient?.comparisonStatus === 'insufficient_for_comparison') counts.insufficientPassed += 1;
    else failures.push({ id: entry.id, gate: 'insufficient' });
    const cards = buildLegalResultCards({
      piiRedacted: true,
      legalDomain: entry.legalDomain,
      lawReferences: [entry],
      lawComparisons: [positive]
    });
    if (
      cards.resultCards.length === 1 &&
      cards.resultCards[0].officialSource.url === entry.source.textUrl &&
      cards.resultCards[0].legalConclusionGenerated === false &&
      !Object.hasOwn(cards.resultCards[0], 'actionAdvice')
    ) counts.resultCardPassed += 1;
    else failures.push({ id: entry.id, gate: 'result_card' });
  }
  const target = corpus.entries.length;
  const ok = counts.retrievalEnabled === target && Object.values(counts).every((count) => count === target);
  const report = { ok, status: ok ? 'ready' : 'incomplete', entryCount: target, ...counts, failures };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`Law capability audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
