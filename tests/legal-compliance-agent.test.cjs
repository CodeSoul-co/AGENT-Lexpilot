const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  AGENT_ID,
  createLegalComplianceAgent
} = require('../src/agent/legal-compliance-agent.cjs');

const projectRoot = path.resolve(__dirname, '..');

function v0Inference(captured = []) {
  return {
    id: 'test-v0-inference',
    async infer(request) {
      captured.push(request);
      return {
        id: 'test-v0-response',
        output: {
          action: 'finish',
          output: {
            status: 'needs_clarification',
            legalDomain: 'labor',
            knownFacts: { issueType: 'dismissal' },
            missingFields: ['employmentDuration'],
            questions: ['您大约工作了多久？'],
            legalConclusionGenerated: false
          }
        }
      };
    }
  };
}

test('one legal-compliance Agent exposes both V0 and V1 task routes', async () => {
  const agent = await createLegalComplianceAgent({ projectRoot, inference: v0Inference() });
  const descriptor = agent.describe();

  assert.equal(descriptor.agentId, 'agent.legal-compliance');
  assert.equal(descriptor.agentId, AGENT_ID);
  assert.equal(descriptor.taskRouter, 'TASK-002');
  assert.deepEqual(descriptor.supportedTaskTypes, [
    'legal_self_check',
    'professional_data_query'
  ]);
  assert.equal(descriptor.capabilityStatus.legal_self_check, 'ready');
  assert.equal(descriptor.capabilityStatus.professional_data_query, 'handoff_only');
  assert.equal(descriptor.workflows.legal_self_check.id, 'workflow.legal-self-check');
  assert.equal(descriptor.workflows.professional_data_query.id, null);
  assert.equal(descriptor.workflows.professional_data_query.status, 'not_implemented');
});

test('the unified Agent routes a V0 legal issue into the Hypha ReAct workflow', async () => {
  const captured = [];
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: v0Inference(captured)
  });
  const result = await agent.run({
    runId: 'run_unified_v0',
    piiRedacted: true,
    redactedText: '公司通知我明天不用来了。'
  });

  assert.equal(result.agentId, AGENT_ID);
  assert.equal(result.taskType, 'legal_self_check');
  assert.equal(result.runtime, 'hypha-react');
  assert.equal(result.status, 'completed');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].agentId, AGENT_ID);
  assert.ok(result.trace.some((event) => event.type === 'business.agent.task-routed'));
  assert.ok(result.trace.some((event) => event.phase === 'complete'));
});

test('the same Agent routes a V1 request without pretending SQL was executed', async () => {
  const captured = [];
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: v0Inference(captured)
  });
  const result = await agent.run({
    runId: 'run_unified_v1',
    piiRedacted: true,
    redactedText: '请基于真实 Schema 生成 SELECT 查询并导出表格。'
  });

  assert.equal(result.agentId, AGENT_ID);
  assert.equal(result.taskType, 'professional_data_query');
  assert.equal(result.status, 'professional_query_identified');
  assert.equal(result.executionAttempted, false);
  assert.equal(result.handoff.status, 'not_implemented');
  assert.equal(captured.length, 0);
  assert.doesNotMatch(JSON.stringify(result.trace), /SELECT|Schema|表格/);
});

test('a connected V1 runtime remains behind the same Agent identity and router', async () => {
  const received = [];
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: v0Inference(),
    v1Runtime: {
      async run(input) {
        received.push(input);
        return {
          status: 'plan_ready',
          runtime: 'hypha-v1-governed',
          trace: [{ phase: 'plan', data: { query: input.redactedText } }]
        };
      }
    }
  });
  const result = await agent.run({
    runId: 'run_unified_v1_connected',
    piiRedacted: true,
    redactedText: '统计数据库中近三年的案件数量并生成图表。'
  });

  assert.equal(agent.describe().capabilityStatus.professional_data_query, 'connected');
  assert.equal(result.agentId, AGENT_ID);
  assert.equal(result.taskType, 'professional_data_query');
  assert.equal(result.status, 'plan_ready');
  assert.equal(received.length, 1);
  assert.equal(received[0].piiRedacted, true);
  assert.equal(received[0].redactedText.includes('数据库'), true);
  assert.doesNotMatch(JSON.stringify(result.trace), /数据库|案件数量/);
});

test('the unified Agent refuses a V1 runtime that bypasses confirmation', async () => {
  const agent = await createLegalComplianceAgent({
    projectRoot,
    inference: v0Inference(),
    v1Runtime: {
      async run() {
        return { status: 'completed', executionAttempted: true, trace: [] };
      }
    }
  });

  await assert.rejects(
    agent.run({
      runId: 'run_unified_v1_bypass',
      piiRedacted: true,
      redactedText: '统计数据库中近三年的案件数量。'
    }),
    (error) => error.code === 'V1_CONFIRMATION_GATE_BYPASSED'
  );
});

test('the unified Agent privacy gate runs before either task route', async () => {
  const agent = await createLegalComplianceAgent({ projectRoot, inference: v0Inference() });

  await assert.rejects(
    agent.run({
      piiRedacted: true,
      redactedText: '手机号13800138000，请查询数据库。'
    }),
    (error) => error.code === 'AGENT_PRIVACY_GATE_REJECTED'
  );
});
