const SOURCE_PRIORITY = Object.freeze({
  model_inference: 1,
  confirmed_history: 2,
  explicit_text: 3,
  structured_option: 4,
  user_correction: 5
});

function resolveFactUpdates({ knownFacts = {}, factSources = {}, answers = [], changedAt }) {
  const nextFacts = { ...knownFacts };
  const nextSources = { ...factSources };
  const changes = [];
  for (const answer of answers) {
    const source = answer.correction ? 'user_correction' : answer.source;
    const previousValue = nextFacts[answer.field];
    const previousSource = nextSources[answer.field]?.source ?? 'confirmed_history';
    const canApply =
      previousValue === undefined ||
      previousValue === answer.value ||
      SOURCE_PRIORITY[source] > SOURCE_PRIORITY[previousSource];
    if (!canApply) continue;
    nextFacts[answer.field] = answer.value;
    nextSources[answer.field] = {
      source,
      confidence: answer.confidence,
      evidenceSpan: answer.evidenceSpan,
      confirmedAt: changedAt
    };
    if (previousValue !== undefined && previousValue !== answer.value) {
      changes.push({
        field: answer.field,
        previousValue,
        nextValue: answer.value,
        source,
        changedAt
      });
    }
  }
  return { knownFacts: nextFacts, factSources: nextSources, changes };
}

module.exports = { SOURCE_PRIORITY, resolveFactUpdates };
