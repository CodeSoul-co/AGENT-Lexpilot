const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadHyphaDomain, loadHyphaKernel } = require('../../scripts/hypha-paths.cjs');
const { detectPii } = require('../v0/pii-redactor.cjs');
const { LEGAL_DOMAINS } = require('../v0/legal-domain.cjs');
const { LABOR_ARTICLE_40_ALLOWED_VALUES } = require('../v0/labor-article-40-facts.cjs');

const AGENT_ID = 'agent.legal-compliance';
const DEFAULT_MODEL_ALIAS = 'legal-compliance-v0';
const DECISION_STATUSES = new Set([
  'needs_domain_clarification',
  'needs_clarification',
  'information_ready',
  'unsupported_domain',
  'clarification_limit_reached'
]);
const SUPPORTED_DOMAINS = new Set(Object.values(LEGAL_DOMAINS));
const KNOWN_FACT_FIELDS = new Set([
  'employmentDuration',
  'writtenContractStatus',
  'issueType',
  'dismissalGround',
  'noticeOrPayStatus',
  'medicalPeriodStatus',
  'workArrangementOutcome',
  'performanceRemediationOutcome',
  'objectiveChangeImpact',
  'contractChangeNegotiationOutcome',
  'relationshipStatus',
  'disputeType',
  'evidenceStatus',
  'repaymentTermStatus',
  'repaymentStatus',
  'taxpayerType',
  'taxIssueType',
  'taxPeriod',
  'rightType',
  'allegedAct',
  'authorizationStatus'
]);
const ACTION_ADVICE_PATTERN = /(?:建议您|建议用户|应当立即|应该立即|请立即|请尽快|立即起诉|立即仲裁|立即报警|委托律师)/;
const ALLOWED_INPUT_KEYS = new Set([
  'runId',
  'sessionId',
  'ownerId',
  'redactedText',
  'piiRedacted',
  'clarificationRound',
  'knownFacts',
  'pendingQuestions'
]);
const ALLOWED_DECISION_KEYS = new Set([
  'status',
  'legalDomain',
  'knownFacts',
  'missingFields',
  'questions',
  'legalConclusionGenerated'
]);

// 模型只允许补全已知事实字段的已知枚举值；'unknown' 不代表已确认事实，不参与合并。
const KNOWN_FACT_VALUE_ENUMS = Object.freeze({
  employmentDuration: Object.freeze(['mentioned']),
  writtenContractStatus: Object.freeze(['signed', 'not_signed']),
  issueType: LABOR_ARTICLE_40_ALLOWED_VALUES.issueType,
  dismissalGround: LABOR_ARTICLE_40_ALLOWED_VALUES.dismissalGround,
  noticeOrPayStatus: LABOR_ARTICLE_40_ALLOWED_VALUES.noticeOrPayStatus,
  medicalPeriodStatus: LABOR_ARTICLE_40_ALLOWED_VALUES.medicalPeriodStatus,
  workArrangementOutcome: LABOR_ARTICLE_40_ALLOWED_VALUES.workArrangementOutcome,
  performanceRemediationOutcome: LABOR_ARTICLE_40_ALLOWED_VALUES.performanceRemediationOutcome,
  objectiveChangeImpact: LABOR_ARTICLE_40_ALLOWED_VALUES.objectiveChangeImpact,
  contractChangeNegotiationOutcome: LABOR_ARTICLE_40_ALLOWED_VALUES.contractChangeNegotiationOutcome,
  relationshipStatus: Object.freeze(['married', 'divorced', 'cohabiting']),
  disputeType: Object.freeze([
    'domestic_violence',
    'bigamy',
    'marriage_freedom',
    'children',
    'property',
    'debt',
    'marriage_status'
  ]),
  evidenceStatus: Object.freeze(['available', 'none_stated']),
  repaymentTermStatus: Object.freeze(['agreed', 'not_agreed']),
  repaymentStatus: Object.freeze(['unpaid', 'partial', 'paid']),
  taxpayerType: Object.freeze(['individual', 'company', 'self_employed']),
  taxIssueType: Object.freeze(['filing', 'withholding', 'additional_tax', 'invoice', 'general']),
  taxPeriod: Object.freeze(['mentioned']),
  rightType: Object.freeze(['written_work', 'image', 'software', 'trademark', 'patent']),
  allegedAct: Object.freeze(['copy', 'repost', 'sale', 'use']),
  authorizationStatus: Object.freeze(['authorized', 'not_authorized'])
});

// 事实字段词汇表必须覆盖 KNOWN_FACT_VALUE_ENUMS 的取值集合，供模型把自然语言映射为合法枚举。
const FACT_VOCABULARY = [
  '事实字段与允许取值（unknown 表示用户说不清，不要写入 knownFacts）：',
  'employmentDuration（工作时长）：mentioned=已说明',
  'writtenContractStatus（书面合同）：signed=已签订，not_signed=未签订',
  'issueType（事项类型）：dismissal=辞退，unpaid_wages=欠薪，social_insurance=社保，overtime=加班',
  'dismissalGround（辞退理由）：medical_or_non_work_injury=医疗期或非因工负伤，performance=不能胜任，objective_change=客观情况变化，other=其他',
  'noticeOrPayStatus（通知或代通知金）：written_notice_30_days=提前30天书面通知，extra_month_salary=多付一个月工资，neither=两者都没有',
  'medicalPeriodStatus（医疗期/休养期）：ended=已结束，not_ended=未结束',
  'workArrangementOutcome（工作安排）：cannot_original_or_alternative=原岗位和另行安排都无法从事，can_original_or_alternative=仍可从事',
  'performanceRemediationOutcome（培训或调岗）：training_or_adjustment_still_unqualified=培训或调岗后仍不能胜任，no_training_or_adjustment=未培训也未调岗，became_qualified=已能胜任',
  'objectiveChangeImpact（客观变化影响）：contract_cannot_continue=合同无法继续履行，contract_can_continue=仍可履行',
  'contractChangeNegotiationOutcome（合同协商）：discussed_no_agreement=协商未达成一致，not_discussed=未协商，agreement_reached=已达成一致',
  'relationshipStatus（关系状态）：married=已婚，divorced=已离婚，cohabiting=同居',
  'disputeType（争议类型）：domestic_violence=家暴，bigamy=重婚，marriage_freedom=婚姻自由，children=子女，property=财产，debt=债务，marriage_status=婚姻状态',
  'evidenceStatus（证据情况）：available=有证据，none_stated=未提及',
  'repaymentTermStatus（还款约定）：agreed=有约定，not_agreed=无约定',
  'repaymentStatus（还款状态）：unpaid=未归还，partial=部分归还，paid=已归还',
  'taxpayerType（涉税主体）：individual=个人，company=公司，self_employed=个体经营',
  'taxIssueType（税务事项）：filing=申报，withholding=代扣代缴，additional_tax=补税，invoice=发票，general=一般',
  'taxPeriod（税务期间）：mentioned=已说明',
  'rightType（权利类型）：written_work=文字作品，image=图片，software=软件，trademark=商标，patent=专利',
  'allegedAct（相关行为）：copy=复制，repost=转载，sale=销售，use=使用',
  'authorizationStatus（授权情况）：authorized=已授权，not_authorized=未授权'
].join('\n');

const SYSTEM_INSTRUCTIONS = [
  '你是法律合规审查智能助手 V0 的事实分析 Agent。',
  '你收到的只能是已脱敏文本，不得推测或恢复任何个人身份信息。',
  '你的任务仅限于识别五类法律领域、提取用户已经陈述的事实、判断最低信息是否齐全，并在需要时提出问题。',
  '输入中的 pendingQuestions 是助手上一轮向用户提出的问题；用户的最新回复通常是对这些问题的简略回答（例如“没有，还未结束”），请按问题顺序逐一对应，把答案提取为 knownFacts 中的结构化事实；回答“没有/无”通常对应该字段的否定取值（如 neither、not_signed、not_agreed），“还未/还没”对应 not_ended。',
  FACT_VOCABULARY,
  'knownFacts 只能使用上面已声明的事实字段和枚举值；无法确认的字段不要填写。',
  '每次最多提出 2 个简短问题；不得给出法律结论、诉讼或行动建议。',
  'questions 中的每一项必须是直接问句并以“？”或“?”结尾；禁止使用“建议您”“请立即”“请尽快”等行动建议表达。',
  '只返回 JSON 结构化动作：{"action":"finish","output":{"status":"needs_clarification|information_ready|needs_domain_clarification|unsupported_domain","legalDomain":"labor|marriage_family|private_lending|taxation|intellectual_property","knownFacts":{},"missingFields":[],"questions":[],"legalConclusionGenerated":false}}。'
].join('\n');

class LegalAgentRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'LegalAgentRuntimeError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(value, allowedKeys, code, label) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new LegalAgentRuntimeError(code, `${label} contains unsupported fields: ${unknownKeys.join(', ')}`);
  }
}

function assertPiiSafe(value, code, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const detectedTypes = detectPii(serialized);
  if (detectedTypes.length > 0) {
    throw new LegalAgentRuntimeError(
      code,
      `${label} contains unredacted PII: ${detectedTypes.join(', ')}`
    );
  }
}

function normalizeStringArray(value, fieldName, maximumItems = 20, errorCode = 'AGENT_OUTPUT_INVALID') {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new LegalAgentRuntimeError(
      errorCode,
      `${fieldName} must be an array with at most ${maximumItems} items.`
    );
  }
  const normalized = value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 200) {
      throw new LegalAgentRuntimeError(
        errorCode,
        `${fieldName} must contain non-empty strings no longer than 200 characters.`
      );
    }
    return item.trim();
  });
  return [...new Set(normalized)];
}

function normalizeKnownFacts(value, errorCode = 'AGENT_OUTPUT_INVALID') {
  if (!isPlainObject(value)) {
    throw new LegalAgentRuntimeError(errorCode, 'knownFacts must be an object.');
  }
  const unknownFields = Object.keys(value).filter((field) => !KNOWN_FACT_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new LegalAgentRuntimeError(
      errorCode,
      `knownFacts contains unsupported fields: ${unknownFields.join(', ')}`
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, factValue]) => {
      if (
        !['string', 'number', 'boolean'].includes(typeof factValue) ||
        (typeof factValue === 'string' && (factValue.length === 0 || factValue.length > 200)) ||
        (typeof factValue === 'number' && !Number.isFinite(factValue))
      ) {
        throw new LegalAgentRuntimeError(
          errorCode,
          `knownFacts contains an invalid value for: ${field}`
        );
      }
      return [field, factValue];
    })
  );
}

function filterSupplementalModelFacts(modelFacts, existingFacts = {}) {
  if (!isPlainObject(modelFacts) || !isPlainObject(existingFacts)) return {};
  const supplemental = {};
  for (const [field, value] of Object.entries(modelFacts)) {
    // 确定性管线已提取的事实优先，模型只补缺，不覆盖。
    if (Object.hasOwn(existingFacts, field)) continue;
    if (!KNOWN_FACT_FIELDS.has(field)) continue;
    if (value === 'unknown') continue;
    const allowedValues = KNOWN_FACT_VALUE_ENUMS[field];
    if (!allowedValues || !allowedValues.includes(value)) continue;
    supplemental[field] = value;
  }
  return supplemental;
}

function normalizeAgentInput(input) {
  if (!isPlainObject(input)) {
    throw new LegalAgentRuntimeError('AGENT_INPUT_INVALID', 'Agent input must be an object.');
  }
  assertNoUnknownKeys(input, ALLOWED_INPUT_KEYS, 'AGENT_INPUT_INVALID', 'Agent input');
  if (input.piiRedacted !== true) {
    throw new LegalAgentRuntimeError(
      'AGENT_PRIVACY_GATE_REJECTED',
      'Agent inference requires piiRedacted=true.'
    );
  }
  if (typeof input.redactedText !== 'string') {
    throw new LegalAgentRuntimeError('AGENT_INPUT_INVALID', 'redactedText must be a string.');
  }
  const redactedText = input.redactedText.trim();
  if (redactedText.length < 1 || redactedText.length > 5000) {
    throw new LegalAgentRuntimeError(
      'AGENT_INPUT_INVALID',
      'redactedText must contain between 1 and 5000 characters.'
    );
  }
  const clarificationRound = input.clarificationRound ?? 0;
  if (!Number.isInteger(clarificationRound) || clarificationRound < 0 || clarificationRound > 5) {
    throw new LegalAgentRuntimeError(
      'AGENT_INPUT_INVALID',
      'clarificationRound must be an integer between 0 and 5.'
    );
  }
  const knownFacts = normalizeKnownFacts(input.knownFacts ?? {}, 'AGENT_INPUT_INVALID');
  const pendingQuestions = normalizeStringArray(
    input.pendingQuestions ?? [],
    'pendingQuestions',
    2,
    'AGENT_INPUT_INVALID'
  );
  const sanitizedPayload = { redactedText, clarificationRound, knownFacts, pendingQuestions };
  assertPiiSafe(sanitizedPayload, 'AGENT_PRIVACY_GATE_REJECTED', 'Agent input');
  return {
    runId: typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim() : randomUUID(),
    sessionId:
      typeof input.sessionId === 'string' && input.sessionId.trim()
        ? input.sessionId.trim()
        : 'ephemeral-session',
    ownerId:
      typeof input.ownerId === 'string' && input.ownerId.trim()
        ? input.ownerId.trim()
        : 'local-owner',
    piiRedacted: true,
    ...sanitizedPayload
  };
}

function normalizeAgentDecision(value) {
  if (!isPlainObject(value)) {
    throw new LegalAgentRuntimeError('AGENT_OUTPUT_INVALID', 'Agent output must be an object.');
  }
  assertNoUnknownKeys(value, ALLOWED_DECISION_KEYS, 'AGENT_OUTPUT_INVALID', 'Agent output');
  if (!DECISION_STATUSES.has(value.status)) {
    throw new LegalAgentRuntimeError('AGENT_OUTPUT_INVALID', 'Agent output status is unsupported.');
  }
  if (value.legalConclusionGenerated !== false) {
    throw new LegalAgentRuntimeError(
      'AGENT_OUTPUT_BOUNDARY_VIOLATION',
      'Agent output must explicitly state legalConclusionGenerated=false.'
    );
  }
  const knownFacts = normalizeKnownFacts(value.knownFacts);
  const missingFields = normalizeStringArray(value.missingFields, 'missingFields');
  const questions = normalizeStringArray(value.questions, 'questions', 2);
  if (
    questions.some(
      (question) => !/[？?]$/.test(question) || ACTION_ADVICE_PATTERN.test(question)
    )
  ) {
    throw new LegalAgentRuntimeError(
      'AGENT_OUTPUT_BOUNDARY_VIOLATION',
      'questions must be questions and cannot contain action advice.'
    );
  }
  const requiresClassifiedDomain = new Set(['needs_clarification', 'information_ready']);
  if (requiresClassifiedDomain.has(value.status) && !SUPPORTED_DOMAINS.has(value.legalDomain)) {
    throw new LegalAgentRuntimeError(
      'AGENT_OUTPUT_INVALID',
      'A classified legalDomain is required for this status.'
    );
  }
  if (value.legalDomain !== undefined && !SUPPORTED_DOMAINS.has(value.legalDomain)) {
    throw new LegalAgentRuntimeError('AGENT_OUTPUT_INVALID', 'legalDomain is unsupported.');
  }
  if (
    (value.status === 'needs_clarification' || value.status === 'needs_domain_clarification') &&
    questions.length === 0
  ) {
    throw new LegalAgentRuntimeError(
      'AGENT_OUTPUT_INVALID',
      'A clarification status requires at least one question.'
    );
  }
  if (value.status === 'information_ready' && (questions.length > 0 || missingFields.length > 0)) {
    throw new LegalAgentRuntimeError(
      'AGENT_OUTPUT_INVALID',
      'information_ready cannot contain questions or missing fields.'
    );
  }
  const decision = {
    status: value.status,
    legalDomain: value.legalDomain,
    knownFacts,
    missingFields,
    questions,
    legalConclusionGenerated: false
  };
  assertPiiSafe(decision, 'AGENT_OUTPUT_BOUNDARY_VIOLATION', 'Agent output');
  return decision;
}

function safeTrace(steps) {
  return steps.map((step) => ({ id: step.id, phase: step.phase }));
}

async function createLegalV0AgentRuntime(options = {}) {
  if (!options.inference || typeof options.inference.infer !== 'function') {
    throw new LegalAgentRuntimeError(
      'AGENT_PROVIDER_REQUIRED',
      'A Hypha-compatible InferenceProvider is required.'
    );
  }
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const domainPackPath = path.join(
    projectRoot,
    'configs',
    'domain-packs',
    'legal-compliance.domain.json'
  );
  const domain = loadHyphaDomain(projectRoot);
  const kernel = loadHyphaKernel(projectRoot);
  const domainPack = await domain.loadDomainPackFile(domainPackPath);
  const compiled = domain.compileDomainPackToHarnessedSystem(domainPack, {
    agentRef: { id: AGENT_ID, version: domainPack.version },
    taskSchemaId: 'task.legal-self-check'
  });
  const agent = domain.applyDomainAgentPatch(
    {
      id: AGENT_ID,
      version: domainPack.version,
      name: 'Legal Compliance Agent V0',
      modelAlias: options.modelAlias ?? DEFAULT_MODEL_ALIAS,
      systemInstructions: SYSTEM_INSTRUCTIONS,
      reasoning: {
        thinkingMode: 'structured',
        agenticMode: 'fsm_react',
        maxSteps: 1,
        persist: 'events_only'
      }
    },
    compiled.agentPatch
  );
  kernel.validateReActAgentSpec(agent);
  const runner = new kernel.ReActAgentRunner({
    inference: options.inference,
    maxIterations: 1,
    reasoningConfig: agent.reasoning,
    verifier: {
      async verify(_context, observation) {
        return { type: 'finish', input: normalizeAgentDecision(observation.value) };
      }
    }
  });

  return Object.freeze({
    describe() {
      return {
        agentId: agent.id,
        agentVersion: agent.version,
        modelAlias: agent.modelAlias,
        domainPackId: domainPack.id,
        domainPackVersion: domainPack.version,
        workflowId: compiled.bindings.workflow.id,
        initialState: compiled.fsmProcess.initialState,
        runtime: 'hypha-react',
        toolRefs: [...(agent.toolRefs ?? [])]
      };
    },
    async run(rawInput) {
      const input = normalizeAgentInput(rawInput);
      const result = await runner.run({
        runId: input.runId,
        stepId: 'v0-fact-analysis',
        sessionId: input.sessionId,
        userId: input.ownerId,
        agent,
        input: {
          redactedText: input.redactedText,
          clarificationRound: input.clarificationRound,
          knownFacts: input.knownFacts,
          pendingQuestions: input.pendingQuestions
        },
        metadata: {
          domainPackId: domainPack.id,
          domainPackVersion: domainPack.version,
          workflowId: compiled.bindings.workflow.id,
          piiRedacted: true
        }
      });
      if (result.status !== 'completed') {
        const cause = result.error instanceof Error ? result.error : undefined;
        throw new LegalAgentRuntimeError(
          'AGENT_RUN_FAILED',
          cause?.message ?? `Hypha Agent run ended with status: ${result.status}`,
          { cause }
        );
      }
      return {
        status: 'completed',
        runtime: 'hypha-react',
        runId: result.runId,
        domainPackVersion: domainPack.version,
        decision: normalizeAgentDecision(result.output),
        trace: safeTrace(result.steps)
      };
    }
  });
}

module.exports = {
  AGENT_ID,
  DEFAULT_MODEL_ALIAS,
  KNOWN_FACT_VALUE_ENUMS,
  SYSTEM_INSTRUCTIONS,
  LegalAgentRuntimeError,
  createLegalV0AgentRuntime,
  filterSupplementalModelFacts,
  normalizeAgentDecision,
  normalizeAgentInput
};
