const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareLegalSelfCheckInput } = require('../src/v0/privacy-gateway.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LEGAL_DOMAINS, classifyLegalDomain } = require('../src/v0/legal-domain.cjs');
const {
  PROHIBITED_CLARIFICATION_TERMS,
  DOMAIN_CLARIFICATION_QUESTION,
  DOMAIN_REQUIREMENTS,
  LABOR_ARTICLE_40_QUESTIONS,
  LABOR_FOLLOW_UP_QUESTIONS,
  analyzeInformationReadiness
} = require('../src/v0/clarification-planner.cjs');

const domainCases = [
  ['老板辞退我，还拖欠工资。', LEGAL_DOMAINS.LABOR],
  ['夫妻准备离婚，主要争议是孩子由谁照顾。', LEGAL_DOMAINS.MARRIAGE_FAMILY],
  ['朋友借钱不还，我手上有借条。', LEGAL_DOMAINS.PRIVATE_LENDING],
  ['公司去年报税时发现发票有问题。', LEGAL_DOMAINS.TAXATION],
  ['别人未经许可转载了我的文章，可能涉及著作权。', LEGAL_DOMAINS.INTELLECTUAL_PROPERTY]
];

const REQUIRED_PROHIBITED_TERMS = Object.freeze([
  '劳动关系',
  '用人单位',
  '举证',
  '诉讼时效',
  '解除婚姻关系',
  '夫妻共同财产',
  '抚养权',
  '债权人',
  '债务人',
  '纳税义务人',
  '计税依据',
  '知识产权',
  '侵权',
  '法律责任',
  '构成要件'
]);

test('classifies all five supported legal domains', () => {
  for (const [text, expectedDomain] of domainCases) {
    const result = classifyLegalDomain(text);
    assert.equal(result.status, 'classified', text);
    assert.equal(result.domain, expectedDomain, text);
    assert.ok(result.confidence > 0);
  }
});

test('defines bounded plain-language clarification contracts for every domain', () => {
  for (const term of REQUIRED_PROHIBITED_TERMS) {
    assert.equal(PROHIBITED_CLARIFICATION_TERMS.includes(term), true, term);
  }
  assert.deepEqual(Object.keys(DOMAIN_REQUIREMENTS).sort(), Object.values(LEGAL_DOMAINS).sort());
  for (const requirements of Object.values(DOMAIN_REQUIREMENTS)) {
    assert.ok(requirements.length >= 2);
    assert.ok(requirements.length <= 3);
    assert.equal(new Set(requirements.map((item) => item.field)).size, requirements.length);
    assert.equal(requirements.every((item) => item.question.endsWith('？')), true);
    for (const { question } of requirements) {
      for (const term of PROHIBITED_CLARIFICATION_TERMS) {
        assert.equal(question.includes(term), false, `${question} contains ${term}`);
      }
    }
  }
  for (const term of PROHIBITED_CLARIFICATION_TERMS) {
    assert.equal(
      DOMAIN_CLARIFICATION_QUESTION.includes(term),
      false,
      `${DOMAIN_CLARIFICATION_QUESTION} contains ${term}`
    );
  }
  for (const question of Object.values(LABOR_ARTICLE_40_QUESTIONS)) {
    assert.equal(question.endsWith('？'), true);
    for (const term of PROHIBITED_CLARIFICATION_TERMS) {
      assert.equal(question.includes(term), false, `${question} contains ${term}`);
    }
  }
});

test('returns at most two jargon-free questions for every supported domain', () => {
  for (const [userText, expectedDomain] of domainCases) {
    const prepared = prepareLegalSelfCheckInput({
      userText,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const result = analyzeInformationReadiness(prepared);

    assert.equal(result.legalDomain, expectedDomain, userText);
    assert.ok(result.questions.length <= 2, userText);
    for (const question of result.questions) {
      for (const term of PROHIBITED_CLARIFICATION_TERMS) {
        assert.equal(question.includes(term), false, `${question} contains ${term}`);
      }
    }
  }
});

test('asks one domain question when top domain scores are tied', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '离婚时还有一张借条需要处理。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'needs_domain_clarification');
  assert.equal(result.legalDomain, undefined);
  assert.equal(result.questions.length, 1);
  assert.equal(result.piiRedacted, true);
});

test('returns at most two plain-language questions for incomplete labor facts', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '老板今天说我明天不用来了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, { clarificationRound: 0 });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.piiRedacted, true);
  assert.equal(result.legalDomain, LEGAL_DOMAINS.LABOR);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.missingFields, ['employmentDuration', 'writtenContractStatus']);
  assert.equal(
    PROHIBITED_CLARIFICATION_TERMS.some((term) => result.questions.join('').includes(term)),
    false
  );
});

test('marks information ready when minimum labor facts are present', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '我在公司工作3年，没签劳动合同，老板今天辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, { clarificationRound: 1 });

  assert.equal(result.status, 'information_ready');
  assert.equal(result.legalDomain, LEGAL_DOMAINS.LABOR);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.questions, []);
});

test('understands common Chinese duration and signed-contract wording', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '老板让我明天不用来了。我工作了一年，双方签过书面合同。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, { clarificationRound: 2 });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.knownFacts.employmentDuration, 'mentioned');
  assert.equal(result.knownFacts.writtenContractStatus, 'signed');
  assert.equal(result.knownFacts.issueType, 'dismissal');
  assert.deepEqual(result.missingFields, ['dismissalGround', 'noticeOrPayStatus']);
  assert.equal(result.questions.includes('您大约工作了多久？'), false);
  assert.equal(result.questions.includes('双方有没有签过书面合同？'), false);
});

test('asks at most two conditional questions for a signed-contract dismissal', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '我在公司工作3年，签了书面合同，老板今天辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missingFields, ['dismissalGround', 'noticeOrPayStatus']);
  assert.deepEqual(result.questions, [
    LABOR_ARTICLE_40_QUESTIONS.dismissalGround,
    LABOR_ARTICLE_40_QUESTIONS.noticeOrPayStatus
  ]);
});

test('selects only the follow-up facts required by the stated dismissal ground', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同。公司因为我生病休养后辞退我，还多给了一个月工资。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missingFields, ['medicalPeriodStatus', 'workArrangementOutcome']);
  assert.equal(result.questions.length, 2);
  assert.equal(result.knownFacts.dismissalGround, 'medical_or_non_work_injury');
  assert.equal(result.knownFacts.noticeOrPayStatus, 'extra_month_salary');
});

test('binds short medical answers to pending facts without over-inferring notice', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。\n没有多给，已结束',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, {
    clarificationRound: 1,
    existingKnownFacts: {
      employmentDuration: 'mentioned',
      writtenContractStatus: 'signed',
      issueType: 'dismissal',
      dismissalGround: 'medical_or_non_work_injury'
    }
  });

  assert.equal(result.knownFacts.medicalPeriodStatus, 'ended');
  assert.equal(Object.hasOwn(result.knownFacts, 'noticeOrPayStatus'), false);
  assert.deepEqual(result.missingFields, ['noticeOrPayStatus', 'workArrangementOutcome']);
  assert.deepEqual(result.questions, [
    LABOR_FOLLOW_UP_QUESTIONS.writtenNoticeOnly,
    LABOR_ARTICLE_40_QUESTIONS.workArrangementOutcome
  ]);
});

test('combines negative notice and pay answers regardless of answer order', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。\n没有多给，已结束。\n也没有提前三十天书面通知。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, { clarificationRound: 2 });

  assert.equal(result.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(result.knownFacts.medicalPeriodStatus, 'ended');
  assert.deepEqual(result.missingFields, ['workArrangementOutcome']);
});

test('binds conversational no-notice wording to the pending written-notice fact', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我，没有多给一个月工资。\n没有告诉我，已经结束了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, {
    clarificationRound: 1,
    latestAnswerText: '没有告诉我，已经结束了。',
    pendingFields: ['noticeOrPayStatus', 'medicalPeriodStatus'],
    existingKnownFacts: {
      employmentDuration: 'mentioned',
      writtenContractStatus: 'signed',
      issueType: 'dismissal',
      dismissalGround: 'medical_or_non_work_injury'
    }
  });

  assert.equal(result.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(result.knownFacts.medicalPeriodStatus, 'ended');
  assert.deepEqual(result.missingFields, ['workArrangementOutcome']);
  assert.deepEqual(result.questions, [LABOR_ARTICLE_40_QUESTIONS.workArrangementOutcome]);
});

test('binds a one-word negative answer only when one pending fact remains', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我，没有提前三十天书面通知，也没有多给一个月工资，休养时间已结束。\n没有',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, {
    clarificationRound: 2,
    latestAnswerText: '没有',
    pendingFields: ['workArrangementOutcome']
  });

  assert.equal(result.status, 'information_ready');
  assert.equal(result.knownFacts.workArrangementOutcome, 'can_original_or_alternative');
});

test('extracts enough explicit performance facts without making a legal conclusion', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同。公司说我不能胜任工作后辞退我，没有培训或调岗，也没有提前三十天书面通知，也没有多给一个月工资。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'information_ready');
  assert.equal(result.knownFacts.dismissalGround, 'performance');
  assert.equal(result.knownFacts.performanceRemediationOutcome, 'no_training_or_adjustment');
  assert.equal(result.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(Object.hasOwn(result, 'legalConclusionGenerated'), false);
});

test('does not treat an oral notice as the written thirty-day notice', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '我在公司工作3年，签了书面合同。公司说我不能胜任工作，提前三十天口头通知辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.notEqual(result.knownFacts.noticeOrPayStatus, 'written_notice_30_days');
  assert.equal(Object.hasOwn(result.knownFacts, 'noticeOrPayStatus'), false);
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.questions.includes(LABOR_FOLLOW_UP_QUESTIONS.extraMonthPayOnly), true);

  const combined = prepareLegalSelfCheckInput({
    userText:
      '我在公司工作3年，签了书面合同。公司说我不能胜任工作，提前三十天口头通知辞退我。\n也没有多给一个月工资',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const followedUp = analyzeInformationReadiness(combined, {
    clarificationRound: 1,
    latestAnswerText: '也没有多给一个月工资',
    pendingFields: ['noticeOrPayStatus', 'performanceRemediationOutcome']
  });

  assert.equal(followedUp.knownFacts.noticeOrPayStatus, 'neither');
});

test('extracts complete medical and objective-change dismissal branches', () => {
  const cases = [
    {
      userText:
        '我在公司工作3年，签了书面合同。生病休养时间已经结束，既不能做原来的工作，也不能做公司另外安排的工作。公司提前三十天书面告诉我会辞退。',
      expectedFacts: {
        dismissalGround: 'medical_or_non_work_injury',
        noticeOrPayStatus: 'written_notice_30_days',
        medicalPeriodStatus: 'ended',
        workArrangementOutcome: 'cannot_original_or_alternative'
      }
    },
    {
      userText:
        '我在公司工作3年，签了书面合同。公司项目结束，原来的工作安排无法继续，公司和我商量调整合同但没有谈妥，后来多给了一个月工资并辞退我。',
      expectedFacts: {
        dismissalGround: 'objective_change',
        noticeOrPayStatus: 'extra_month_salary',
        objectiveChangeImpact: 'contract_cannot_continue',
        contractChangeNegotiationOutcome: 'discussed_no_agreement'
      }
    }
  ];

  for (const item of cases) {
    const prepared = prepareLegalSelfCheckInput({
      userText: item.userText,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const result = analyzeInformationReadiness(prepared);

    assert.equal(result.status, 'information_ready', item.userText);
    for (const [field, value] of Object.entries(item.expectedFacts)) {
      assert.equal(result.knownFacts[field], value, `${field}: ${item.userText}`);
    }
  }
});

test('keeps the existing unsigned-contract path ready without Article 40 questions', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '我在公司工作3年，没签劳动合同，老板今天辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'information_ready');
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.missingFields, []);
});

test('recognizes a marriage-family issue covered by the verified corpus', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '我已婚，丈夫长期对我实施家庭暴力。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'information_ready');
  assert.equal(result.legalDomain, LEGAL_DOMAINS.MARRIAGE_FAMILY);
  assert.deepEqual(result.knownFacts, {
    relationshipStatus: 'married',
    disputeType: 'domestic_violence'
  });
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.questions, []);
});

test('returns an unsupported-domain result without inventing a domain', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '楼上每天晚上很吵。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);

  assert.equal(result.status, 'unsupported_domain');
  assert.equal(result.legalDomain, undefined);
  assert.deepEqual(result.questions, []);
});

test('stops asking questions at the fifth clarification round', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '朋友借钱不还。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared, { clarificationRound: 5 });

  assert.equal(result.status, 'clarification_limit_reached');
  assert.deepEqual(result.questions, []);
  assert.ok(result.missingFields.length > 0);
});

test('rejects raw or otherwise unsanitized clarification input', () => {
  const result = analyzeInformationReadiness({
    status: 'ready',
    piiRedacted: false,
    redactedText: '手机号 13800138000，老板辞退我。'
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.piiRedacted, false);
  assert.equal(JSON.stringify(result).includes('13800138000'), false);
});

test('domain and clarification traces contain facts only, not the user text', () => {
  const prepared = prepareLegalSelfCheckInput({
    userText: '姓名：张三，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const result = analyzeInformationReadiness(prepared);
  const serializedTrace = JSON.stringify(result.trace);

  assert.equal(serializedTrace.includes('张三'), false);
  assert.equal(serializedTrace.includes('老板辞退我'), false);
});
