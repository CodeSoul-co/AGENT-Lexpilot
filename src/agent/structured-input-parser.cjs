const {
  normalizeQuestionField,
  normalizeQuestionValue,
  questionDefinitionForField
} = require('./question-contracts.cjs');

const TEXT_VALUE_PATTERNS = Object.freeze({
  noticeOrPayStatus: [
    ['neither', /^(?:均|都)?(?:未|没|没有)(?:提供|通知|支付|给|给付)?(?:任何一项|这两项|两项)?$/],
    ['written_notice_30_days', /提前(?:30|三十)天.*(?:书面)?(?:通知|告诉)/],
    ['extra_month_salary', /(?:额外|另外).*(?:一个月工资|代通知金)/]
  ],
  medicalPeriodStatus: [
    ['not_ended', /^(?:医疗期|休养时间)?(?:尚未|还未|还没|没有|未)(?:届满|结束)$/],
    ['ended', /^(?:医疗期|休养时间)?(?:已经|已)?(?:届满|结束)(?:了)?$/]
  ],
  writtenContractStatus: [
    ['not_signed', /^(?:没有|没|未)(?:签|签订)?(?:书面|劳动)?合同$/],
    ['signed', /^(?:有|已经|已)?(?:签|签订|签了)(?:书面|劳动)?合同$/]
  ],
  workArrangementOutcome: [
    ['cannot_original_or_alternative', /(?:不能|无法).*(?:原工作|原来的工作).*(?:其他|另外|合适|新).*(?:工作|岗位)/],
    ['can_original_or_alternative', /(?:可以|能够|还能).*(?:原工作|其他工作|合适工作|岗位)/]
  ]
});

function splitAnswerSegments(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/[；;，,。\n\r]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function contractMatches(contract, answer) {
  return (
    contract?.questionId === answer?.questionId &&
    normalizeQuestionField(answer?.field) === contract?.fieldName
  );
}

function parseSegmentForField(segment, fieldName) {
  const normalized = segment.replace(/^(?:更正|纠正|改为|应该是|实际是|不是之前的答案[，,:：]?)/u, '').trim();
  const definition = questionDefinitionForField(fieldName);
  for (const option of definition?.options ?? []) {
    if (normalized === option.label || option.aliases?.includes(normalized)) return option.value;
  }
  // A negative sentence that mentions only notice or only payment is incomplete for
  // the combined field. Leave it to the deterministic full-text extractor instead of
  // turning “没有提前通知” into the positive notice enum.
  if (fieldName === 'noticeOrPayStatus' && /(?:没有|没|未)/u.test(normalized)) {
    const simpleCombinedNegative = TEXT_VALUE_PATTERNS.noticeOrPayStatus[0];
    if (simpleCombinedNegative[1].test(normalized)) return simpleCombinedNegative[0];
    return undefined;
  }
  for (const [value, pattern] of TEXT_VALUE_PATTERNS[fieldName] ?? []) {
    if (pattern.test(normalized)) return value;
  }
  return undefined;
}

function parseStructuredAnswers(answers, pendingContracts) {
  if (answers === undefined) return [];
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > pendingContracts.length) {
    throw new TypeError('answers must be a non-empty array within the pending question count.');
  }
  const seen = new Set();
  return answers.map((answer) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      throw new TypeError('Each structured answer must be an object.');
    }
    const contract = pendingContracts.find((candidate) => candidate.questionId === answer.questionId);
    if (!contract || !contractMatches(contract, answer) || seen.has(contract.questionId)) {
      throw new TypeError('Structured answer does not match a pending question.');
    }
    const value = normalizeQuestionValue(contract.fieldName, answer.value);
    if (value === undefined || !contract.allowedValues.includes(value)) {
      throw new TypeError('Structured answer value is not allowed for the pending question.');
    }
    seen.add(contract.questionId);
    return {
      questionId: contract.questionId,
      field: contract.fieldName,
      value,
      evidenceSpan: contract.options.find((option) => option.value === value)?.label ?? '',
      confidence: 1,
      source: 'structured_option',
      correction: answer.correction === true
    };
  });
}

function parseFreeTextAnswers(userText, pendingContracts) {
  const segments = splitAnswerSegments(userText);
  const results = [];
  const usedSegments = new Set();
  for (let index = 0; index < pendingContracts.length; index += 1) {
    const contract = pendingContracts[index];
    let matchedIndex = index < segments.length ? index : -1;
    let value = matchedIndex >= 0 ? parseSegmentForField(segments[matchedIndex], contract.fieldName) : undefined;
    if (value === undefined) {
      matchedIndex = segments.findIndex(
        (segment, segmentIndex) =>
          !usedSegments.has(segmentIndex) && parseSegmentForField(segment, contract.fieldName) !== undefined
      );
      value = matchedIndex >= 0 ? parseSegmentForField(segments[matchedIndex], contract.fieldName) : undefined;
    }
    if (value === undefined || usedSegments.has(matchedIndex)) continue;
    usedSegments.add(matchedIndex);
    const evidenceSpan = segments[matchedIndex];
    results.push({
      questionId: contract.questionId,
      field: contract.fieldName,
      value,
      evidenceSpan,
      confidence: 0.96,
      source: 'explicit_text',
      correction: /^(?:更正|纠正|改为|应该是|实际是|不是之前的答案)/u.test(evidenceSpan)
    });
  }
  return results;
}

function parseStructuredInput(payload, pendingContracts = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Answer payload must be an object.');
  }
  const contracts = Array.isArray(pendingContracts) ? pendingContracts : [];
  const structured = parseStructuredAnswers(payload.answers, contracts);
  const structuredFields = new Set(structured.map((answer) => answer.field));
  const text = typeof payload.userText === 'string' ? payload.userText.trim() : '';
  const textual = text
    ? parseFreeTextAnswers(text, contracts).filter((answer) => !structuredFields.has(answer.field))
    : [];
  const noticeContract = contracts.find(
    (contract) => contract.fieldName === 'noticeOrPayStatus'
  );
  if (
    noticeContract &&
    !structuredFields.has('noticeOrPayStatus') &&
    !textual.some((answer) => answer.field === 'noticeOrPayStatus') &&
    /(?:没有|没|未).{0,12}(?:书面)?(?:通知|告诉)/u.test(text) &&
    /(?:没有|没|未).{0,12}(?:多给|额外支付|代通知金|一个月工资)/u.test(text)
  ) {
    textual.push({
      questionId: noticeContract.questionId,
      field: 'noticeOrPayStatus',
      value: 'neither',
      evidenceSpan: text.slice(0, 200),
      confidence: 0.98,
      source: 'explicit_text',
      correction: false
    });
  }
  if (/(?:更正|纠正|改为|修改为|之前说错了)/u.test(text)) {
    for (const answer of textual) answer.correction = true;
  }
  const answers = [...structured, ...textual];
  return {
    userText: text,
    answers,
    facts: Object.fromEntries(answers.map(({ field, value }) => [field, value])),
    unresolvedFields: contracts
      .filter((contract) => !answers.some((answer) => answer.field === contract.fieldName))
      .map((contract) => contract.fieldName)
  };
}

module.exports = {
  parseFreeTextAnswers,
  parseStructuredInput,
  splitAnswerSegments
};
