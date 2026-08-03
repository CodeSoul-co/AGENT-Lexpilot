const { createHash } = require('node:crypto');
const { loadHyphaCore, loadHyphaTools } = require('../../scripts/hypha-paths.cjs');
const { createSchemaFingerprint, validateWriteSqlPlan } = require('./sql-policy-guard.cjs');

const TOOL_ID = 'lexpilot.sqlite.single-row-write';
const INSERT_SQL = 'INSERT INTO labor_cases (case_id, year, issue_type, outcome, compensation_amount) VALUES (:case_id, :year, :issue_type, :outcome, :compensation_amount);';
const UPDATE_SQL = 'UPDATE labor_cases SET compensation_amount = :compensation_amount WHERE case_id = :case_id;';
const DELETE_SQL = 'DELETE FROM labor_cases WHERE case_id = :case_id;';
const DANGEROUS_PATTERN = /\b(?:drop|alter|truncate|create|replace|grant|revoke|attach|detach|pragma)\b|删表|清空表|修改表结构|建表/i;

function safeTrace(type, data) {
  return { type, data };
}

function parseWriteRequest(text) {
  if (DANGEROUS_PATTERN.test(text)) {
    return { ok: false, code: 'DANGEROUS_OPERATION_DENIED', reason: '结构变更和危险操作已在数据库执行前拒绝。' };
  }
  let match = text.match(/新增案例\s*([A-Za-z0-9-]+)[，,\s]+年份\s*(\d{4})[，,\s]+事项\s*([^，,\n]+)[，,\s]+结果\s*(employee_win|employer_win)[，,\s]+赔偿(?:金额)?\s*(\d+)/i);
  if (match) {
    return {
      ok: true,
      sql: INSERT_SQL,
      parameters: {
        case_id: match[1],
        year: Number(match[2]),
        issue_type: match[3].trim(),
        outcome: match[4].toLowerCase(),
        compensation_amount: Number(match[5])
      }
    };
  }
  match = text.match(/将案例\s*([A-Za-z0-9-]+)\s*的赔偿金额更新为\s*(\d+)/i);
  if (match) {
    return {
      ok: true,
      sql: UPDATE_SQL,
      parameters: { case_id: match[1], compensation_amount: Number(match[2]) }
    };
  }
  match = text.match(/删除案例\s*([A-Za-z0-9-]+)/i);
  if (match) {
    return { ok: true, sql: DELETE_SQL, parameters: { case_id: match[1] } };
  }
  return {
    ok: false,
    code: 'WRITE_TEMPLATE_NOT_SUPPORTED',
    reason: '当前仅支持单案例新增、按案例编号更新赔偿金额、按案例编号删除。'
  };
}

function rejection(input, code, reason) {
  return {
    status: 'rejected',
    runtime: 'sqlite-governed-write',
    runId: input.runId,
    executionAttempted: false,
    reason,
    errorCode: code,
    safety: {
      readOnly: false,
      writeAttempted: true,
      schemaVerified: false,
      confirmationRequired: true,
      humanReviewRequired: true
    },
    trace: [safeTrace('v1.sql.write.rejected', { code })]
  };
}

function invocationIdFor(runId, planHash) {
  return `lexpilot-write-${createHash('sha256').update(`${runId}:${planHash}`).digest('hex').slice(0, 24)}`;
}

async function createGovernedSQLiteWriteRuntime(options = {}) {
  const dataSource = options.dataSource;
  if (!dataSource || typeof dataSource.executeWrite !== 'function') {
    throw new TypeError('dataSource must expose executeWrite(input).');
  }
  const descriptor = dataSource.describe();
  if (descriptor.engine !== 'sqlite' || descriptor.mode !== 'read-write') {
    throw new TypeError('Governed writes require a read-write SQLite profile.');
  }
  if (descriptor.requiresHumanReview !== true || descriptor.maxAffectedRows !== 1) {
    throw new TypeError('Governed writes require Human Review and a one-row limit.');
  }
  const connection = await dataSource.testConnection();
  if (connection.status !== 'connected') throw new Error('The configured SQLite data source is unavailable.');
  const initialSnapshot = await dataSource.inspectSchema();
  const { InMemoryEventStore } = loadHyphaCore();
  const { GovernedToolRunner, ToolRegistry } = loadHyphaTools();
  const eventStore = options.eventStore ?? new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(
    {
      id: TOOL_ID,
      version: '1.0.0',
      description: 'Execute one approved, parameterized SQLite business-data write.',
      inputSchema: { type: 'object' },
      sideEffectLevel: 'write',
      timeoutPolicy: { timeoutMs: descriptor.timeoutMs, onTimeout: 'fail' },
      retryPolicy: { maxAttempts: 1 },
      auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
      humanApprovalPolicy: { required: true, reason: 'Database write requires explicit confirmation.' }
    },
    async (input) => dataSource.executeWrite(input)
  );
  const runner = new GovernedToolRunner(registry, eventStore);
  const pending = new Map();

  async function governanceReceipt(runId, status) {
    const events = await eventStore.list({ runId });
    return Object.freeze({
      provider: 'hypha.tools.GovernedToolRunner',
      status,
      eventCount: events.length,
      eventTypes: Object.freeze([...new Set(events.map((event) => event.type))])
    });
  }

  return Object.freeze({
    describe() {
      return Object.freeze({
        runtime: 'sqlite-governed-write',
        dataSource: descriptor.id,
        schema: initialSnapshot.schema,
        executionProvider: 'hypha.tools.GovernedToolRunner',
        hyphaSourceModified: false,
        humanReviewRequired: true,
        allowedWriteOperations: [...descriptor.allowedWriteOperations],
        limits: { timeoutMs: descriptor.timeoutMs, maxAffectedRows: descriptor.maxAffectedRows, maxAttempts: 1 }
      });
    },

    async plan(input) {
      const parsed = parseWriteRequest(input.redactedText);
      if (!parsed.ok) return rejection(input, parsed.code, parsed.reason);
      const snapshot = await dataSource.inspectSchema();
      const policy = validateWriteSqlPlan({
        sql: parsed.sql,
        parameters: parsed.parameters,
        schema: snapshot.schema,
        allowedWriteOperations: descriptor.allowedWriteOperations,
        maxAffectedRows: descriptor.maxAffectedRows
      });
      if (!policy.ok) return rejection(input, policy.code, policy.message);
      const invocationId = invocationIdFor(input.runId, policy.planHash);
      const call = {
        toolId: TOOL_ID,
        input: {
          sql: parsed.sql,
          parameters: parsed.parameters,
          expectedSchemaFingerprint: snapshot.schemaFingerprint
        },
        context: {
          runId: input.runId,
          sessionId: input.sessionId,
          stepId: 'database-write',
          invocationId
        }
      };
      const review = await runner.run(call);
      if (review.status !== 'human_review_required') {
        return rejection(input, review.error?.code ?? 'HUMAN_REVIEW_GATE_FAILED', '未能创建 Human Review，写操作未执行。');
      }
      pending.set(invocationId, { runId: input.runId, planHash: policy.planHash, schemaFingerprint: snapshot.schemaFingerprint });
      const receipt = await governanceReceipt(input.runId, 'pending');
      return {
        status: 'awaiting_confirmation',
        runtime: 'sqlite-governed-write',
        runId: input.runId,
        executionAttempted: false,
        schema: snapshot.schema,
        plan: {
          status: 'human_review_required',
          sql: parsed.sql,
          parameters: parsed.parameters,
          explanation: '该操作将修改一条业务数据；确认后在单个 SQLite 事务中执行。',
          operationType: policy.operationType,
          readOnly: false,
          schemaVerified: true,
          policyVersion: policy.policyVersion,
          schemaFingerprint: snapshot.schemaFingerprint,
          schemaSnapshot: snapshot.schema,
          planHash: policy.planHash,
          requiresConfirmation: true,
          humanReviewRequired: true,
          governedInvocationId: invocationId,
          maxAffectedRows: 1
        },
        safety: {
          readOnly: false,
          writeAttempted: true,
          schemaVerified: true,
          schemaFingerprint: snapshot.schemaFingerprint,
          planHash: policy.planHash,
          confirmationRequired: true,
          humanReviewRequired: true,
          humanReviewStatus: 'pending',
          governedInvocationId: invocationId
        },
        governanceReceipt: receipt,
        trace: [
          safeTrace('v1.sql.write.plan.verified', { operationType: policy.operationType, planHash: policy.planHash }),
          safeTrace('human.review.requested', { governedInvocationId: invocationId }),
          safeTrace('v1.sql.write.awaiting_confirmation', { requiresConfirmation: true })
        ]
      };
    },

    async execute(input) {
      const invocationId = input.governedInvocationId;
      const stored = pending.get(invocationId);
      if (
        !stored ||
        stored.runId !== input.runId ||
        stored.planHash !== input.expectedPlanHash ||
        stored.schemaFingerprint !== input.expectedSchemaFingerprint
      ) {
        return rejection(input, 'PLAN_DRIFT', '确认内容与待审批写入计划不一致，写操作未执行。');
      }
      try {
        const result = await runner.approveAndResume(invocationId, 'lexpilot-session-owner', {
          approvedAt: input.confirmedAt
        });
        pending.delete(invocationId);
        if (result.status !== 'completed') {
          const receipt = await governanceReceipt(input.runId, 'resolved_failed');
          return {
            status: 'failed',
            runtime: 'sqlite-governed-write',
            runId: input.runId,
            executionAttempted: true,
            reason: '数据库写入失败，事务未提交。',
            errorCode: result.error?.code ?? 'SQLITE_WRITE_FAILED',
            plan: { ...input.confirmedPlan },
            result: { status: 'failed', affectedRows: 0, transactionStatus: 'rolled_back' },
            safety: {
              readOnly: false,
              writeAttempted: true,
              schemaVerified: true,
              schemaFingerprint: stored.schemaFingerprint,
              planHash: stored.planHash,
              humanReviewRequired: true,
              humanReviewStatus: 'resolved_failed',
              governedInvocationId: invocationId
            },
            providerReceipt: {
              provider: 'hypha.tools.GovernedToolRunner',
              dataSource: descriptor.id,
              readOnly: false,
              affectedRows: 0,
              durationMs: result.durationMs
            },
            governanceReceipt: receipt,
            trace: [
              safeTrace('human.review.approved', { governedInvocationId: invocationId }),
              safeTrace('v1.sql.write.transaction.rolled_back', { code: result.error?.code ?? 'SQLITE_WRITE_FAILED' }),
              safeTrace('human.review.resolved', { status: 'failed' })
            ]
          };
        }
        const receipt = await governanceReceipt(input.runId, 'approved_and_resolved');
        return {
          status: 'completed',
          runtime: 'sqlite-governed-write',
          runId: input.runId,
          executionAttempted: true,
          plan: { ...input.confirmedPlan },
          result: {
            status: result.output.status,
            affectedRows: result.output.affectedRows,
            transactionStatus: result.output.transactionStatus
          },
          safety: {
            readOnly: false,
            writeAttempted: true,
            schemaVerified: true,
            schemaFingerprint: stored.schemaFingerprint,
            planHash: stored.planHash,
            humanReviewRequired: true,
            humanReviewStatus: 'approved_and_resolved',
            governedInvocationId: invocationId
          },
          providerReceipt: {
            provider: 'hypha.tools.GovernedToolRunner',
            dataSource: descriptor.id,
            readOnly: false,
            affectedRows: result.output.affectedRows,
            durationMs: result.durationMs
          },
          governanceReceipt: receipt,
          trace: [
            safeTrace('human.review.approved', { governedInvocationId: invocationId }),
            safeTrace('v1.sql.write.transaction.committed', { affectedRows: result.output.affectedRows }),
            safeTrace('human.review.resolved', { status: 'completed' })
          ]
        };
      } catch (error) {
        pending.delete(invocationId);
        return rejection(input, error?.code ?? 'SQLITE_WRITE_FAILED', '数据库写入失败，事务未提交。');
      }
    },

    async reject(input) {
      const invocationId = input.governedInvocationId;
      if (!pending.has(invocationId)) return { status: 'not_pending' };
      await runner.rejectInvocation(invocationId);
      pending.delete(invocationId);
      return { status: 'rejected', governanceReceipt: await governanceReceipt(input.runId, 'rejected') };
    }
  });
}

module.exports = {
  DELETE_SQL,
  INSERT_SQL,
  TOOL_ID,
  UPDATE_SQL,
  createGovernedSQLiteWriteRuntime,
  parseWriteRequest
};
