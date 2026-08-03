const {
  AGENT_ID,
  createLegalV0AgentRuntime,
  normalizeAgentInput
} = require('./legal-v0-agent-runtime.cjs');
const {
  TASK_TYPES,
  classifyBusinessTask
} = require('../v0/task-type-classifier.cjs');

const AGENT_NAME = '法律合规审查智能助手';
const ROUTER_RUNTIME = 'hypha-agent-router';

function safeRoutingTrace(classification) {
  return [
    ...classification.trace,
    {
      type: 'business.agent.task-routed',
      data: {
        agentId: AGENT_ID,
        taskType: classification.taskType
      }
    }
  ];
}

function safeRuntimeTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace.map((event) => {
    const safeEvent = {};
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      if (typeof event.type === 'string') safeEvent.type = event.type;
      if (typeof event.phase === 'string') safeEvent.phase = event.phase;
    }
    return safeEvent;
  });
}

async function createLegalComplianceAgent(options = {}) {
  const v0Runtime = await createLegalV0AgentRuntime({
    projectRoot: options.projectRoot,
    inference: options.inference,
    modelAlias: options.v0ModelAlias
  });
  const v1Runtime = options.v1Runtime;
  if (
    v1Runtime !== undefined &&
    typeof v1Runtime.plan !== 'function' &&
    typeof v1Runtime.run !== 'function'
  ) {
    throw new TypeError('v1Runtime must expose plan(input) or run(input).');
  }

  return Object.freeze({
    describe() {
      const v0Descriptor = v0Runtime.describe();
      return {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        agentVersion: v0Descriptor.agentVersion,
        domainPackId: v0Descriptor.domainPackId,
        domainPackVersion: v0Descriptor.domainPackVersion,
        runtime: ROUTER_RUNTIME,
        taskRouter: 'TASK-002',
        supportedTaskTypes: [
          TASK_TYPES.LEGAL_SELF_CHECK,
          TASK_TYPES.PROFESSIONAL_DATA_QUERY
        ],
        capabilityStatus: {
          [TASK_TYPES.LEGAL_SELF_CHECK]: 'ready',
          [TASK_TYPES.PROFESSIONAL_DATA_QUERY]: v1Runtime ? 'connected' : 'handoff_only'
        },
        workflows: {
          [TASK_TYPES.LEGAL_SELF_CHECK]: {
            id: v0Descriptor.workflowId,
            status: 'ready'
          },
          [TASK_TYPES.PROFESSIONAL_DATA_QUERY]: {
            id: null,
            status: v1Runtime ? 'connected' : 'not_implemented'
          }
        }
      };
    },

    async run(rawInput) {
      const input = normalizeAgentInput(rawInput);
      const classification = classifyBusinessTask({
        piiRedacted: true,
        redactedText: input.redactedText
      });
      const routingTrace = safeRoutingTrace(classification);

      if (classification.taskType === TASK_TYPES.LEGAL_SELF_CHECK) {
        const result = await v0Runtime.run(input);
        return {
          ...result,
          agentId: AGENT_ID,
          taskType: classification.taskType,
          taskTypeRecognition: classification,
          trace: [...routingTrace, ...result.trace]
        };
      }

      if (v1Runtime) {
        const result =
          typeof v1Runtime.plan === 'function'
            ? await v1Runtime.plan(input)
            : await v1Runtime.run(input);
        if (result?.executionAttempted === true) {
          const error = new Error('Direct Agent routing cannot execute V1 before confirmation.');
          error.code = 'V1_CONFIRMATION_GATE_BYPASSED';
          throw error;
        }
        return {
          ...result,
          agentId: AGENT_ID,
          taskType: classification.taskType,
          taskTypeRecognition: classification,
          trace: [...routingTrace, ...safeRuntimeTrace(result.trace)]
        };
      }

      return {
        status: 'professional_query_identified',
        runtime: ROUTER_RUNTIME,
        agentId: AGENT_ID,
        runId: input.runId,
        taskType: classification.taskType,
        taskTypeRecognition: classification,
        executionAttempted: false,
        handoff: {
          capability: 'v1_structured_data_query',
          status: 'not_implemented',
          reason: 'V1 governed SQL execution runtime is not connected.'
        },
        trace: routingTrace
      };
    }
  });
}

module.exports = {
  AGENT_ID,
  AGENT_NAME,
  ROUTER_RUNTIME,
  createLegalComplianceAgent
};
