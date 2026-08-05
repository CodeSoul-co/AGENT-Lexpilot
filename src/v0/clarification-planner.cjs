const { V0_DOMAIN_PACK_VERSION, V0_ERROR_CODES } = require('./contracts.cjs');
const { LEGAL_DOMAINS, DOMAIN_LABELS, classifyLegalDomain } = require('./legal-domain.cjs');
const {
  assessLaborArticle40Facts
} = require('./labor-article-40-facts.cjs');

const PROHIBITED_CLARIFICATION_TERMS = Object.freeze([
  '劳动关系',
  '用人单位',
  '举证',
  '仲裁时效',
  '诉讼时效',
  '解除劳动合同',
  '解除婚姻关系',
  '夫妻共同财产',
  '抚养权',
  '债权',
  '债务人',
  '债权人',
  '纳税义务人',
  '应纳税所得额',
  '计税依据',
  '知识产权',
  '著作权人',
  '侵权',
  '法律责任',
  '构成要件',
  '授权许可'
]);

const DOMAIN_CLARIFICATION_QUESTION =
  '这件事主要涉及工作或工资、婚姻家庭、借钱还钱、报税或发票，还是文章、图片、软件、商标或专利被他人使用？';

const DOMAIN_REQUIREMENTS = Object.freeze({
  [LEGAL_DOMAINS.LABOR]: [
    { field: 'employmentDuration', question: '您大约工作了多久？' },
    { field: 'writtenContractStatus', question: '双方有没有签过书面合同？' },
    { field: 'issueType', question: '这次主要是被辞退、工资没发、社保，还是其他工作问题？' }
  ],
  [LEGAL_DOMAINS.MARRIAGE_FAMILY]: [
    { field: 'relationshipStatus', question: '您现在是已经结婚、已经离婚，还是没有登记但一直一起生活？' },
    {
      field: 'disputeType',
      question: '主要是在争财产、孩子、欠款、是否要结束婚姻，还是有人动手或强迫结婚？'
    }
  ],
  [LEGAL_DOMAINS.PRIVATE_LENDING]: [
    { field: 'evidenceStatus', question: '有没有借条、转账记录或聊天记录？' },
    { field: 'repaymentTermStatus', question: '双方有没有说过具体什么时候还款？' },
    { field: 'repaymentStatus', question: '目前是完全没还、只还了一部分，还是已经还清？' }
  ],
  [LEGAL_DOMAINS.TAXATION]: [
    { field: 'taxpayerType', question: '这件事涉及个人、公司，还是个体户？' },
    { field: 'taxIssueType', question: '主要是报税、工资扣税、补税、发票，还是其他税方面的问题？' },
    { field: 'taxPeriod', question: '这件事大约发生在哪一年或哪个月份？' }
  ],
  [LEGAL_DOMAINS.INTELLECTUAL_PROPERTY]: [
    { field: 'rightType', question: '涉及的是文章、图片、软件、商标，还是专利？' },
    { field: 'allegedAct', question: '对方具体做了什么，例如复制、转载、销售或使用？' },
    { field: 'authorizationStatus', question: '您之前有没有明确同意对方这样做？' }
  ]
});

const LABOR_ARTICLE_40_QUESTIONS = Object.freeze({
  dismissalGround:
    '公司说辞退您的主要原因是什么：生病或受伤后无法工作、工作表现不符合要求、公司情况发生重大变化，还是其他原因？',
  noticeOrPayStatus: '公司有没有提前三十天书面告诉您，或者另外多给一个月工资？',
  medicalPeriodStatus: '公司规定的看病休养时间是否已经结束？',
  workArrangementOutcome:
    '休养时间结束后，您是否既做不了原来的工作，也做不了公司另外安排的工作？',
  performanceRemediationOutcome:
    '公司是否先培训或调整过岗位，之后仍明确说您不能胜任这份工作？',
  objectiveChangeImpact: '公司所说的变化是否让原来的工作安排确实无法继续？',
  contractChangeNegotiationOutcome: '公司是否和您商量过调整合同内容，但双方没有谈妥？'
});

const LABOR_FOLLOW_UP_QUESTIONS = Object.freeze({
  writtenNoticeOnly: '公司有没有提前三十天书面告诉您？',
  extraMonthPayOnly: '公司有没有另外多给一个月工资？'
});

const NEGATIVE_WRITTEN_NOTICE_PATTERN =
  /(?:没|没有|未).{0,10}(?:提前(?:30|三十)天|书面(?:通知|告诉))/;
const CONTEXTUAL_NEGATIVE_WRITTEN_NOTICE_PATTERN =
  /(?:没|没有|未)(?:有)?(?:人|公司)?(?:书面)?(?:告诉|通知)(?:我|本人)?/;
const NEGATIVE_EXTRA_MONTH_PAY_PATTERN =
  /(?:没|没有|未)(?:有)?(?:另外|额外)?(?:多给|支付(?:了)?(?:.{0,4})?(?:一个月工资|代通知金)|给了?(?:.{0,4})?(?:一个月工资|代通知金)|代通知金)/;
const POSITIVE_WRITTEN_NOTICE_PATTERN = /提前(?:30|三十)天.{0,8}(?:书面)?(?:通知|告诉)/;
const ORAL_NOTICE_PATTERN = /口头(?:的)?(?:通知|告诉)/;
const POSITIVE_EXTRA_MONTH_PAY_PATTERN =
  /额外支付.{0,6}一个月工资|(?:另外)?多给了?.{0,6}一个月工资|(?:支付|给了?)代通知金/;
const STANDALONE_ENDED_PATTERN =
  /(?:^|[\n，,。；;])\s*(?:已经|已)?结束(?:了)?\s*(?=$|[\n，,。；;])/;
const SIMPLE_NEGATIVE_ANSWER_PATTERN = /^(?:没有|没|不是|否|并没有|都没有)[。！!？?]?$/;

function firstCategory(text, categories) {
  for (const [value, pattern] of categories) {
    if (pattern.test(text)) return value;
  }
  return undefined;
}

function hasNegativeWrittenNotice(text, context = {}) {
  return (
    NEGATIVE_WRITTEN_NOTICE_PATTERN.test(text) ||
    ORAL_NOTICE_PATTERN.test(text) ||
    (context.pendingFields?.includes('noticeOrPayStatus') &&
      CONTEXTUAL_NEGATIVE_WRITTEN_NOTICE_PATTERN.test(context.latestAnswerText ?? ''))
  );
}

function extractNoticeOrPayStatus(text, context = {}) {
  const negativeNotice = hasNegativeWrittenNotice(text, context);
  const negativePay = NEGATIVE_EXTRA_MONTH_PAY_PATTERN.test(text);
  if (negativeNotice && negativePay) return 'neither';
  if (!negativeNotice && POSITIVE_WRITTEN_NOTICE_PATTERN.test(text)) return 'written_notice_30_days';
  if (!negativePay && POSITIVE_EXTRA_MONTH_PAY_PATTERN.test(text)) return 'extra_month_salary';
  return undefined;
}

function contextualQuestion(requirement, text, context = {}) {
  if (requirement.field !== 'noticeOrPayStatus') return requirement.question;
  const negativeNotice = hasNegativeWrittenNotice(text, context);
  const negativePay = NEGATIVE_EXTRA_MONTH_PAY_PATTERN.test(text);
  if (negativePay && !negativeNotice) return LABOR_FOLLOW_UP_QUESTIONS.writtenNoticeOnly;
  if (negativeNotice && !negativePay) return LABOR_FOLLOW_UP_QUESTIONS.extraMonthPayOnly;
  return requirement.question;
}

function normalizeExistingKnownFacts(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([field, fact]) =>
        typeof field !== 'string' ||
        !['string', 'number', 'boolean'].includes(typeof fact) ||
        (typeof fact === 'string' && (fact.length === 0 || fact.length > 200)) ||
        (typeof fact === 'number' && !Number.isFinite(fact))
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries);
}

function extractFacts(domain, text, context = {}) {
  switch (domain) {
    case LEGAL_DOMAINS.LABOR: {
      const facts = compactFacts({
        employmentDuration: /(?:\d+|[一二三四五六七八九十百两]+)\s*(?:年(?:半)?|个?月)|半年/.test(text)
          ? 'mentioned'
          : undefined,
        writtenContractStatus: firstCategory(text, [
          [
            'not_signed',
            /(?:没|没有|未)签(?:过|订|署|了)?(?:.{0,4}(?:书面|劳动)?合同)?|无劳动合同/
          ],
          [
            'signed',
            /签(?:了|过|订|署)(?:.{0,4}(?:书面|劳动)?合同)?|有(?:书面|劳动)?合同/
          ]
        ]),
        issueType: firstCategory(text, [
          ['dismissal', /辞退|开除|解雇|不用来了|不用来|被离职/],
          ['unpaid_wages', /欠薪|拖欠工资|工资没发|未发工资/],
          ['social_insurance', /社保|五险/],
          ['overtime', /加班/]
        ]),
        dismissalGround: firstCategory(text, [
          ['medical_or_non_work_injury', /患病|生病|非因工负伤|不是工伤.{0,4}(?:受伤|负伤)|医疗期|休养/],
          ['performance', /不能胜任|不胜任|工作表现|能力不达标|绩效不合格/],
          ['objective_change', /客观情况发生重大变化|公司搬迁|工厂搬迁|项目(?:结束|终止)|部门撤销|岗位取消|业务调整/],
          ['other', /严重违纪|旷工|试用期|协商解除|经济性裁员/]
        ]),
        noticeOrPayStatus: extractNoticeOrPayStatus(text, context),
        medicalPeriodStatus: firstCategory(text, [
          [
            'not_ended',
            /医疗期(?:还没有|还没|没有|未)(?:届满|结束)|休养时间(?:还没有|还没|没有|未)结束/
          ],
          ['ended', /医疗期(?:已经|已)?(?:届满|结束)|休养时间(?:已经|已)?结束/]
        ]),
        workArrangementOutcome: firstCategory(text, [
          [
            'cannot_original_or_alternative',
            /(?:不能|无法).{0,8}原(?:来)?(?:的)?工作.{0,14}(?:也|并且).{0,8}(?:另行安排|另外安排|其他|新).{0,6}工作/
          ],
          ['can_original_or_alternative', /还能.{0,8}(?:原来的|其他|新).{0,6}工作|可以.{0,8}(?:原来的|其他|新).{0,6}工作/]
        ]),
        performanceRemediationOutcome: firstCategory(text, [
          [
            'training_or_adjustment_still_unqualified',
            /(?:培训|调岗|调整岗位).{0,18}(?:仍|还是|依然).{0,8}(?:不能胜任|做不好|不合格)/
          ],
          ['no_training_or_adjustment', /(?:没有|没|未).{0,10}(?:培训|调岗|调整岗位)/],
          ['became_qualified', /(?:培训|调岗|调整岗位).{0,18}(?:已经胜任|可以胜任|能做好|合格)/]
        ]),
        objectiveChangeImpact: firstCategory(text, [
          ['contract_cannot_continue', /(?:原来的工作|工作安排|劳动合同|合同).{0,10}(?:无法|不能).{0,6}(?:继续|履行)/],
          ['contract_can_continue', /(?:仍然|还|可以).{0,6}(?:继续工作|继续履行|按原安排)/]
        ]),
        contractChangeNegotiationOutcome: firstCategory(text, [
          ['discussed_no_agreement', /(?:商量|协商).{0,14}(?:没有谈妥|没谈妥|未达成一致|没有达成一致|不同意)/],
          ['not_discussed', /(?:没有|没|未).{0,8}(?:商量|协商)/],
          ['agreement_reached', /(?:商量|协商).{0,14}(?:谈妥|达成一致|同意)/]
        ])
      });
      if (
        facts.dismissalGround === 'medical_or_non_work_injury' &&
        facts.medicalPeriodStatus === undefined &&
        STANDALONE_ENDED_PATTERN.test(text)
      ) {
        facts.medicalPeriodStatus = 'ended';
      }
      const pendingFields = Array.isArray(context.pendingFields)
        ? context.pendingFields.filter((field) => !(field in facts))
        : [];
      if (
        SIMPLE_NEGATIVE_ANSWER_PATTERN.test((context.latestAnswerText ?? '').trim()) &&
        pendingFields.length === 1
      ) {
        const pendingField = pendingFields[0];
        if (pendingField === 'noticeOrPayStatus') facts.noticeOrPayStatus = 'neither';
        if (pendingField === 'medicalPeriodStatus') facts.medicalPeriodStatus = 'not_ended';
        if (pendingField === 'workArrangementOutcome') {
          facts.workArrangementOutcome = 'can_original_or_alternative';
        }
      }
      return facts;
    }
    case LEGAL_DOMAINS.MARRIAGE_FAMILY:
      return compactFacts({
        relationshipStatus: firstCategory(text, [
          ['divorced', /已经离婚|离婚后/],
          ['married', /已婚|夫妻|配偶|丈夫|妻子|老公|老婆|想离婚|准备离婚|结婚/],
          ['cohabiting', /同居|共同生活/]
        ]),
        disputeType: firstCategory(text, [
          ['domestic_violence', /家暴|家庭暴力|殴打|打我|动手打/],
          ['bigamy', /重婚|另有配偶|又和别人结婚/],
          ['marriage_freedom', /包办婚姻|买卖婚姻|逼婚|强迫结婚|干涉婚姻自由/],
          ['children', /孩子|子女|抚养/],
          ['property', /财产|房产|存款/],
          ['debt', /债务|欠款/],
          ['marriage_status', /离婚/]
        ])
      });
    case LEGAL_DOMAINS.PRIVATE_LENDING:
      return compactFacts({
        evidenceStatus: firstCategory(text, [
          ['none_stated', /没有借条|没借条|没有证据/],
          ['available', /借条|转账记录|聊天记录|借款合同|收据/]
        ]),
        repaymentTermStatus: firstCategory(text, [
          ['not_agreed', /没约定.{0,4}还款|没有约定.{0,4}还款/],
          ['agreed', /到期|还款日期|约定.{0,8}还|说好.{0,8}还/]
        ]),
        repaymentStatus: firstCategory(text, [
          ['partial', /还了一部分|部分还款/],
          ['unpaid', /没还|未还|不还|借钱不还|欠钱不还/],
          ['paid', /已经还清|已还清/]
        ])
      });
    case LEGAL_DOMAINS.TAXATION:
      return compactFacts({
        taxpayerType: firstCategory(text, [
          ['self_employed', /个体户|个体经营/],
          ['company', /公司|企业/],
          ['individual', /个人|个税|工资扣税/]
        ]),
        taxIssueType: firstCategory(text, [
          ['filing', /申报|报税/],
          ['withholding', /扣税/],
          ['additional_tax', /补税/],
          ['invoice', /发票/],
          ['general', /税务|纳税|个人所得税|个税/]
        ]),
        taxPeriod: /(?:20\d{2}年|今年|去年|前年|\d{1,2}月)/.test(text) ? 'mentioned' : undefined
      });
    case LEGAL_DOMAINS.INTELLECTUAL_PROPERTY:
      return compactFacts({
        rightType: firstCategory(text, [
          ['trademark', /商标/],
          ['patent', /专利/],
          ['software', /软件|代码/],
          ['image', /图片|摄影|照片/],
          ['written_work', /文章|文字|作品|著作权|版权/]
        ]),
        allegedAct: firstCategory(text, [
          ['sale', /销售|售卖/],
          ['copy', /复制|抄袭|盗版/],
          ['repost', /转载|发布/],
          ['use', /使用|冒用/]
        ]),
        authorizationStatus: firstCategory(text, [
          ['not_authorized', /未授权|没授权|没有授权|未经许可|未经同意/],
          ['authorized', /已经授权|取得授权|获得许可/]
        ])
      });
    default:
      return {};
  }
}

function laborArticle40ConditionalRequirements(knownFacts) {
  if (
    knownFacts.issueType !== 'dismissal' ||
    knownFacts.writtenContractStatus !== 'signed'
  ) {
    return [];
  }
  const assessment = assessLaborArticle40Facts({ piiRedacted: true, knownFacts });
  if (assessment.status === 'not_supported_by_declared_ground') return [];
  return assessment.missingFields
    .filter((field) => Object.hasOwn(LABOR_ARTICLE_40_QUESTIONS, field))
    .map((field) => ({ field, question: LABOR_ARTICLE_40_QUESTIONS[field] }));
}

function compactFacts(facts) {
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

function safeTraceEvent(type, data) {
  return { type, data };
}

function analyzeInformationReadiness(preparedInput, options = {}) {
  const clarificationRound = options.clarificationRound ?? 0;
  const existingKnownFacts = normalizeExistingKnownFacts(options.existingKnownFacts);
  const existingLegalDomain = options.existingLegalDomain;
  const latestAnswerText =
    typeof options.latestAnswerText === 'string' ? options.latestAnswerText.trim() : '';
  const pendingFields = Array.isArray(options.pendingFields)
    ? options.pendingFields.filter((field) => typeof field === 'string')
    : [];
  const answerContext = { latestAnswerText, pendingFields };
  const trace = [];

  if (
    !preparedInput ||
    preparedInput.status !== 'ready' ||
    preparedInput.piiRedacted !== true ||
    typeof preparedInput.redactedText !== 'string' ||
    !Number.isInteger(clarificationRound) ||
    clarificationRound < 0 ||
    clarificationRound > 5 ||
    existingKnownFacts === null ||
    (existingLegalDomain !== undefined &&
      !Object.values(LEGAL_DOMAINS).includes(existingLegalDomain))
  ) {
    return {
      status: 'failed',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: false,
      error: {
        code: V0_ERROR_CODES.INVALID_CLARIFICATION_CONTEXT,
        message: '领域识别只接受已完成脱敏的有效输入。'
      },
      trace: [safeTraceEvent('v0.clarification.rejected', { code: V0_ERROR_CODES.INVALID_CLARIFICATION_CONTEXT })]
    };
  }

  const classification = existingLegalDomain
    ? {
        status: 'classified',
        domain: existingLegalDomain,
        confidence: 1,
        candidates: [existingLegalDomain],
        matchedSignalCount: 0,
        source: 'session_locked'
      }
    : classifyLegalDomain(preparedInput.redactedText);
  trace.push(
    safeTraceEvent('v0.legal-domain.classified', {
      status: classification.status,
      domain: classification.domain,
      confidence: classification.confidence,
      candidateCount: classification.candidates.length,
      source: classification.source ?? 'deterministic_signals'
    })
  );

  if (classification.status === 'unsupported') {
    return {
      status: 'unsupported_domain',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      clarificationRound,
      questions: [],
      error: {
        code: V0_ERROR_CODES.UNSUPPORTED_LEGAL_DOMAIN,
        message: '当前描述无法归入首版支持的五个领域。'
      },
      trace
    };
  }

  if (classification.status === 'ambiguous') {
    const limitReached = clarificationRound >= 5;
    return {
      status: limitReached ? 'clarification_limit_reached' : 'needs_domain_clarification',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      domainCandidates: classification.candidates,
      clarificationRound,
      questions: limitReached
        ? []
        : [DOMAIN_CLARIFICATION_QUESTION],
      error: limitReached
        ? { code: V0_ERROR_CODES.INSUFFICIENT_INFORMATION, message: '达到追问上限后仍无法确认领域。' }
        : undefined,
      trace
    };
  }

  const knownFacts = {
    ...existingKnownFacts,
    ...extractFacts(classification.domain, preparedInput.redactedText, answerContext)
  };
  const requirements = DOMAIN_REQUIREMENTS[classification.domain];
  const baseMissingFields = requirements.filter(
    (requirement) => !(requirement.field in knownFacts)
  );
  const conditionalRequirements =
    baseMissingFields.length === 0 && classification.domain === LEGAL_DOMAINS.LABOR
      ? laborArticle40ConditionalRequirements(knownFacts)
      : [];
  const missingFields = [...baseMissingFields, ...conditionalRequirements];

  trace.push(
    safeTraceEvent('v0.information.checked', {
      domain: classification.domain,
      knownFieldCount: Object.keys(knownFacts).length,
      missingFields: missingFields.map((item) => item.field),
      clarificationRound
    })
  );

  if (missingFields.length === 0) {
    return {
      status: 'information_ready',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      legalDomain: classification.domain,
      legalDomainLabel: DOMAIN_LABELS[classification.domain],
      confidence: classification.confidence,
      knownFacts,
      missingFields: [],
      clarificationRound,
      questions: [],
      trace
    };
  }

  if (clarificationRound >= 5) {
    return {
      status: 'clarification_limit_reached',
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      legalDomain: classification.domain,
      legalDomainLabel: DOMAIN_LABELS[classification.domain],
      knownFacts,
      missingFields: missingFields.map((item) => item.field),
      clarificationRound,
      questions: [],
      error: {
        code: V0_ERROR_CODES.INSUFFICIENT_INFORMATION,
        message: '达到追问上限后信息仍不完整。'
      },
      trace
    };
  }

  return {
    status: 'needs_clarification',
    domainPackVersion: V0_DOMAIN_PACK_VERSION,
    piiRedacted: true,
    legalDomain: classification.domain,
    legalDomainLabel: DOMAIN_LABELS[classification.domain],
    confidence: classification.confidence,
    knownFacts,
    missingFields: missingFields.map((item) => item.field),
    clarificationRound,
    questions: missingFields
      .slice(0, 2)
      .map((item) => contextualQuestion(item, preparedInput.redactedText, answerContext)),
    trace
  };
}

module.exports = {
  PROHIBITED_CLARIFICATION_TERMS,
  DOMAIN_CLARIFICATION_QUESTION,
  DOMAIN_REQUIREMENTS,
  LABOR_ARTICLE_40_QUESTIONS,
  LABOR_FOLLOW_UP_QUESTIONS,
  extractFacts,
  analyzeInformationReadiness
};
