const { randomUUID } = require('node:crypto');
const { TASK_TYPES } = require('../v0/task-type-classifier.cjs');
const { filterSupplementalModelFacts } = require('./legal-v0-agent-runtime.cjs');

function safeAgentTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace.map((event) => ({
    type: typeof event?.type === 'string' ? event.type : undefined,
    phase: typeof event?.phase === 'string' ? event.phase : undefined
  }));
}

function assistantMessage(result) {
  if (result.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY) {
    if (result.v1?.replanRequired === true && result.v1?.schemaDrift?.detected === true) {
      return result.v1.schemaDrift.notification;
    }
    if (result.v1?.status === 'completed') {
      return result.v1?.plan?.readOnly === false
        ? `经确认的数据更新已完成，影响 ${result.v1.result?.affectedRows ?? 0} 行。`
        : '专业数据分析已完成，结果、图表和分析文档已经生成。';
    }
    if (result.v1?.status === 'cancelled') {
      return '已按你的选择取消本次专业数据分析，查询未执行。';
    }
    if (result.v1?.status === 'awaiting_confirmation') {
      return result.v1?.plan?.readOnly === false
        ? '本次请求可能更改数据，请核对影响范围并明确确认。'
        : '已生成只读分析计划，确认后才会执行。';
    }
    return result.v1?.reason ?? '专业数据分析未执行该请求。';
  }
  if (result.status === 'needs_clarification' || result.status === 'needs_domain_clarification') {
    return 'Agent 需要补充少量事实后才能继续核对。';
  }
  if (result.status === 'completed') {
    return `已完成初步法律自检，并从固定法规语料中生成 ${result.resultCards?.length ?? 0} 张可核验卡片。`;
  }
  if (result.status === 'clarification_limit_reached') {
    return '信息仍不足，本次核对已按安全边界结束。';
  }
  if (result.status === 'information_ready') {
    if (result.lawRetrievalStatus === 'no_match') {
      return '事实信息已收集完成，但当前法规语料暂未找到可安全展示的匹配条目。';
    }
    if (
      result.lawRetrievalStatus === 'failed' ||
      result.lawComparisonStatus === 'failed' ||
      result.resultCardStatus === 'failed'
    ) {
      return '事实信息已收集完成，但法规核对环节暂时不可用，请稍后重试。';
    }
    return '事实信息已收集完成，当前条件尚不足以生成可核验的结果卡片。';
  }
  if (result.status === 'unsupported_domain') {
    return '当前描述未能稳定归入支持领域，请选择领域并补充争议主体与具体事项。';
  }
  return 'Agent 已完成本轮处理。';
}

class AgentBackedConversationService {
  constructor(options = {}) {
    this.service = options.service;
    this.agent = options.agent;
    this.inferenceDescriptor = options.inferenceDescriptor ?? {};
    this.inference = options.inference;
    this.ownerId = options.ownerId ?? 'local-user';
    this.resultCache = new Map();
    if (!this.service || typeof this.service.start !== 'function') {
      throw new TypeError('service must expose the legal conversation interface.');
    }
    if (!this.agent || typeof this.agent.run !== 'function' || typeof this.agent.describe !== 'function') {
      throw new TypeError('agent must expose describe() and run(input).');
    }
    const sessionSnapshotRef = this.service.describeCapabilityBinding?.() ?? null;
    const agentSnapshotRef = this.agent.describe().capabilitySnapshotRef ?? null;
    if (
      (sessionSnapshotRef === null) !== (agentSnapshotRef === null) ||
      (sessionSnapshotRef !== null &&
        (sessionSnapshotRef.id !== agentSnapshotRef.id ||
          sessionSnapshotRef.version !== agentSnapshotRef.version ||
          sessionSnapshotRef.snapshotSha256 !== agentSnapshotRef.snapshotSha256))
    ) {
      const error = new Error('Session and Agent capability snapshots do not match.');
      error.code = 'CAPABILITY_SNAPSHOT_COMPOSITION_DRIFT';
      throw error;
    }
    this.capabilitySnapshotRef = sessionSnapshotRef;
  }

  describe() {
    return {
      ...this.agent.describe(),
      inference: { ...this.inferenceDescriptor }
    };
  }

  async start(input) {
    const businessResult = await this.service.start(input);
    return this.runAgent(businessResult);
  }

  async answer(sessionId, userText) {
    const businessResult = await this.service.answer(sessionId, userText);
    return this.runAgent(businessResult);
  }

  async runAgent(businessResult) {
    if (!businessResult?.sessionId || businessResult.status === 'failed' || businessResult.status === 'rejected') {
      return businessResult;
    }
    if (
      businessResult.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY &&
      businessResult.status === 'needs_clarification'
    ) {
      const merged = {
        ...businessResult,
        assistantMessage: '请补充会影响分析执行的指标或时间范围。'
      };
      this.resultCache.set(businessResult.sessionId, {
        assistantMessage: merged.assistantMessage,
        pendingQuestions: [...(merged.questions ?? [])],
        v1: merged.v1
      });
      return merged;
    }
    if (businessResult.status === 'awaiting_confirmation') {
      const merged = {
        ...businessResult,
        assistantMessage: assistantMessage(businessResult)
      };
      this.resultCache.set(businessResult.sessionId, {
        assistantMessage: merged.assistantMessage,
        v1: merged.v1
      });
      return merged;
    }
    const session = this.service.getSession(businessResult.sessionId);
    if (!session) return businessResult;
    const redactedText = session.messages.map((message) => message.redactedText).join('\n');
    const pendingQuestions = this.resultCache.get(session.id)?.pendingQuestions ?? [];
    const runId = randomUUID();
    let agentResult;
    try {
      agentResult = await this.agent.run({
        runId,
        sessionId: session.id,
        ownerId: this.ownerId,
        piiRedacted: true,
        redactedText,
        clarificationRound: session.clarificationRound,
        knownFacts: session.knownFacts,
        pendingQuestions
      });
    } catch (error) {
      const providerRun = this.inference?.getRunStatus?.(runId);
      if (businessResult.taskType === TASK_TYPES.LEGAL_SELF_CHECK) {
        return this.useContractFallback(businessResult, runId, providerRun, error);
      }
      throw error;
    }
    // 模型输出已通过 Agent 输出边界校验（legalConclusionGenerated===false 等）。
    // 此时只允许模型补全确定性管线尚未提取的事实；确定性事实优先，冲突不覆盖。
    let effectiveResult = businessResult;
    if (
      agentResult.taskType === TASK_TYPES.LEGAL_SELF_CHECK &&
      agentResult.decision?.legalConclusionGenerated === false &&
      typeof this.service.applySupplementalFacts === 'function'
    ) {
      const supplementalFacts = filterSupplementalModelFacts(
        agentResult.decision.knownFacts,
        session.knownFacts
      );
      if (Object.keys(supplementalFacts).length > 0) {
        const reanalyzed = this.service.applySupplementalFacts(session.id, supplementalFacts);
        if (reanalyzed) effectiveResult = reanalyzed;
      }
    }
    const descriptor = this.describe();
    const providerRun = this.inference?.getRunStatus?.(agentResult.runId);
    const merged = {
      ...effectiveResult,
      agentExecution: {
        connected: true,
        agentId: agentResult.agentId,
        runtime: agentResult.runtime,
        runId: agentResult.runId,
        taskType: agentResult.taskType,
        providerMode: providerRun?.providerMode ?? descriptor.inference.mode,
        requestedProviderMode:
          providerRun?.requestedProviderMode ?? descriptor.inference.mode,
        fallbackUsed: providerRun?.fallbackUsed ?? false,
        fallbackReason: providerRun?.fallbackReason,
        model: descriptor.inference.model,
        trace: safeAgentTrace(agentResult.trace)
      }
    };
    if (agentResult.taskType === TASK_TYPES.LEGAL_SELF_CHECK) {
      merged.agentDecision = agentResult.decision;
    } else {
      merged.status = agentResult.status;
      merged.v1 = agentResult;
    }
    merged.assistantMessage = assistantMessage(merged);
    this.resultCache.set(session.id, {
      agentExecution: merged.agentExecution,
      assistantMessage: merged.assistantMessage,
      v1: merged.v1,
      pendingQuestions: Array.isArray(merged.questions) ? [...merged.questions] : []
    });
    return merged;
  }

  useContractFallback(businessResult, runId, providerRun, error) {
    const descriptor = this.describe();
    const modelResponded = Boolean(providerRun);
    const merged = {
      ...businessResult,
      agentExecution: {
        connected: true,
        agentId: descriptor.agentId,
        runtime: descriptor.runtime,
        runId,
        taskType: businessResult.taskType,
        providerMode: providerRun?.providerMode ?? 'business-fallback',
        requestedProviderMode:
          providerRun?.requestedProviderMode ?? descriptor.inference.mode,
        fallbackUsed: modelResponded ? providerRun.fallbackUsed ?? false : true,
        fallbackReason: modelResponded
          ? providerRun.fallbackReason
          : 'agent_run_failed',
        model: descriptor.inference.model,
        outputAccepted: false,
        outputRejectionReason: modelResponded
          ? 'contract_validation_failed'
          : 'agent_run_failed',
        agentErrorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN_AGENT_ERROR',
        trace: [{ type: 'business.agent.output-rejected' }]
      },
      agentDecision: {
        status: businessResult.status,
        legalDomain: businessResult.legalDomain,
        knownFacts: { ...(businessResult.knownFacts ?? {}) },
        missingFields: [...(businessResult.missingFields ?? [])],
        questions: [...(businessResult.questions ?? [])],
        legalConclusionGenerated: false
      }
    };
    merged.assistantMessage = assistantMessage(merged);
    this.resultCache.set(businessResult.sessionId, {
      agentExecution: merged.agentExecution,
      assistantMessage: merged.assistantMessage,
      pendingQuestions: Array.isArray(businessResult.questions) ? [...businessResult.questions] : []
    });
    return merged;
  }

  listHistory() {
    return this.service.listHistory().map((session) => ({
      ...session,
      agentConnected: this.resultCache.has(session.sessionId)
    }));
  }

  getHistory(sessionId) {
    const history = this.service.getHistory(sessionId);
    const cached = this.resultCache.get(sessionId);
    if (!history || !cached) return history;
    const { pendingQuestions, v1: cachedV1, ...publicCache } = cached;
    return {
      ...history,
      ...publicCache,
      ...(history.v1 ? { v1: history.v1 } : cachedV1 ? { v1: cachedV1 } : {})
    };
  }

  readV1Artifact(sessionId, artifactId) {
    if (typeof this.service.readV1Artifact !== 'function') {
      const error = new Error('Analysis Artifact download is unavailable.');
      error.code = 'ARTIFACT_DOWNLOAD_UNAVAILABLE';
      throw error;
    }
    return this.service.readV1Artifact(sessionId, artifactId);
  }

  async deleteSession(sessionId, confirmation) {
    const result =
      typeof this.service.deleteSessionWithArtifacts === 'function'
        ? await this.service.deleteSessionWithArtifacts(sessionId, confirmation)
        : await this.service.deleteSession(sessionId, confirmation);
    if (result.deleted) this.resultCache.delete(sessionId);
    return result;
  }

  async eraseOwnerHistory(confirmation) {
    if (typeof this.service.eraseOwnerHistory !== 'function') {
      throw new TypeError('service must expose eraseOwnerHistory(confirmation).');
    }
    const result = await this.service.eraseOwnerHistory(confirmation);
    if (result?.success === true) this.resultCache.clear();
    return result;
  }

  maybeCleanupInactiveSessionsAsync() {
    if (typeof this.service.maybeCleanupInactiveSessionsAsync !== 'function') return null;
    return this.service.maybeCleanupInactiveSessionsAsync();
  }

  async confirmV1Execution(sessionId, confirmation) {
    if (typeof this.service.confirmV1Execution !== 'function') {
      throw new TypeError('service must expose confirmV1Execution(sessionId, confirmation).');
    }
    const result = await this.service.confirmV1Execution(sessionId, confirmation);
    if (result?.sessionId && result.status !== 'failed') {
      const merged = { ...result, assistantMessage: assistantMessage(result) };
      this.resultCache.set(result.sessionId, {
        ...(this.resultCache.get(result.sessionId) ?? {}),
        assistantMessage: merged.assistantMessage,
        v1: merged.v1
      });
      return merged;
    }
    return result;
  }

  async replanV1Execution(sessionId) {
    if (typeof this.service.replanV1Execution !== 'function') {
      throw new TypeError('service must expose replanV1Execution(sessionId).');
    }
    const result = await this.service.replanV1Execution(sessionId);
    if (result?.sessionId && result.status !== 'failed') {
      const merged = { ...result, assistantMessage: assistantMessage(result) };
      this.resultCache.set(result.sessionId, {
        ...(this.resultCache.get(result.sessionId) ?? {}),
        assistantMessage: merged.assistantMessage,
        v1: merged.v1
      });
      return merged;
    }
    return result;
  }

  listV1ExecutionLogs(filter) {
    if (typeof this.service.listV1ExecutionLogs !== 'function') {
      return [];
    }
    return this.service.listV1ExecutionLogs(filter);
  }

  getV1ExecutionLogIntegrity() {
    if (typeof this.service.getV1ExecutionLogIntegrity !== 'function') {
      return { status: 'unavailable', recordCount: 0, verifiedCount: 0, legacyCount: 0 };
    }
    return this.service.getV1ExecutionLogIntegrity();
  }
}

module.exports = { AgentBackedConversationService };
