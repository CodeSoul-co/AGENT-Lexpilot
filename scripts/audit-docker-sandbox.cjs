const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadLocalEnv } = require('./load-env.cjs');
const { createDockerSandboxPreflight } = require('../src/v1/docker-sandbox-preflight.cjs');
const { createSandboxArtifactRepository } = require('../src/v1/sandbox-artifact-repository.cjs');
const { createDockerSandboxProviderFactory } = require('../src/v1/docker-sandbox-provider-factory.cjs');
const { createSandboxExecutionRuntime } = require('../src/v1/sandbox-execution-runtime.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');

loadLocalEnv();

function emptyDirectory(directory) {
  return !fs.existsSync(directory) || fs.readdirSync(directory).length === 0;
}

function emitProgress(result) {
  process.stderr.write(`${JSON.stringify({
    status: 'case_completed',
    id: result.id,
    resultStatus: result.status,
    errorCode: result.errorCode,
    cleanupVerified: result.cleanupVerified,
    generatedArtifactCount: result.generatedArtifactCount
  })}\n`);
}

function requireGovernanceEvents(eventTypes, decision) {
  const required = [
    'human.review.requested',
    `human.review.${decision}`,
    ...(decision === 'approved' ? ['human.review.resolved'] : [])
  ];
  if (!Array.isArray(eventTypes) || required.some((type) => !eventTypes.includes(type))) {
    const error = new Error('Sandbox audit did not produce complete Human Review evidence.');
    error.code = 'SANDBOX_AUDIT_TRACE_INCOMPLETE';
    throw error;
  }
}

async function rejectCase(runtime, auditId) {
  const runId = `sandbox-audit-unconfirmed-rejected-${auditId}`;
  const plan = await runtime.plan({
    language: 'python',
    script: "raise SystemExit('must-not-run')",
    runId,
    sessionId: `sandbox-audit-session-${auditId}`
  });
  const result = await runtime.reject({ invocationId: plan.invocationId, runId });
  requireGovernanceEvents(result.governanceReceipt.eventTypes, 'rejected');
  if (result.executionAttempted !== false) {
    const error = new Error('Rejected Sandbox audit case attempted execution.');
    error.code = 'SANDBOX_AUDIT_UNCONFIRMED_EXECUTION';
    throw error;
  }
  return {
    id: 'unconfirmed-rejected',
    status: result.status,
    executionAttempted: false,
    eventTypes: result.governanceReceipt.eventTypes,
    cleanupVerified: true,
    generatedArtifactCount: 0
  };
}

async function executeCase(runtime, definition, auditId) {
  const runId = `sandbox-audit-${definition.id}-${auditId}`;
  const plan = await runtime.plan({
    language: definition.language,
    script: definition.script,
    runId,
    sessionId: `sandbox-audit-session-${auditId}`
  });
  const result = await runtime.approve({
    invocationId: plan.invocationId,
    runId,
    approvedAt: new Date().toISOString()
  });
  const safeResult = {
    id: definition.id,
    status: result.status,
    errorCode: result.result?.errorCode,
    eventTypes: result.governanceReceipt.eventTypes,
    cleanupVerified: result.result?.cleanupEvidence?.executionContainerAbsent === true,
    generatedArtifactCount: result.result?.generatedArtifactRefs?.length ?? 0,
    resourceEvidence: result.result?.resourceEvidence
  };
  if (!definition.expectedStatuses.includes(result.status)) {
    emitProgress(safeResult);
    const error = new Error(`Sandbox audit case ${definition.id} returned an unexpected status.`);
    error.code = 'SANDBOX_AUDIT_EXPECTATION_FAILED';
    throw error;
  }
  requireGovernanceEvents(result.governanceReceipt.eventTypes, 'approved');
  if (!safeResult.cleanupVerified) {
    const error = new Error(`Sandbox audit case ${definition.id} did not prove cleanup.`);
    error.code = 'SANDBOX_AUDIT_CLEANUP_FAILED';
    throw error;
  }
  definition.validate?.(safeResult);
  return safeResult;
}

async function main() {
  // Artifact identities include runId/executionId. A unique id keeps repeated
  // acceptance runs independent without deleting evidence from earlier runs.
  const auditId = randomUUID();
  const projectRoot = path.resolve(__dirname, '..');
  const workspaceExecution = loadWorkspaceExecutionProfile({ projectRoot }).resolve(process.env);
  const workspaceRoot = workspaceExecution.workspaceRoot;
  const artifactRoot = path.resolve(
    process.env.LEGAL_V1_SANDBOX_ARTIFACT_ROOT ?? path.join(projectRoot, 'data', 'sandbox-artifacts')
  );
  const imageReference = workspaceExecution.executionEnvironment.image.reference;
  const imageDigest = workspaceExecution.executionEnvironment.image.digest;
  const dockerPath = process.env.LEGAL_V1_DOCKER_PATH || 'docker';
  const preflight = createDockerSandboxPreflight().check({
    dockerPath,
    imageReference,
    imageDigest
  });
  const artifactRepository = createSandboxArtifactRepository({ rootPath: artifactRoot, projectRoot });
  try {
    const runtime = await createSandboxExecutionRuntime({
      workspaceRoot,
      imageReference,
      imageDigest,
      expectedExecutionEnvironment: workspaceExecution.executionEnvironment,
      artifactRepository,
      providerFactory: createDockerSandboxProviderFactory({
        projectRoot,
        artifactRepository,
        dockerPath
      })
    });
    const policy = runtime.describe().policy;
    const cases = [
      {
        id: 'python-generated-artifact',
        language: 'python',
        script: "from pathlib import Path\nPath('/workspace/result.txt').write_text('sandbox-ok', encoding='utf-8')\nprint('python-ok')",
        expectedStatuses: ['completed'],
        validate(result) {
          if (result.generatedArtifactCount < 1) {
            const error = new Error('Generated Sandbox file was not persisted as an Artifact.');
            error.code = 'SANDBOX_AUDIT_ARTIFACT_MISSING';
            throw error;
          }
        }
      },
      {
        id: 'shell-literal-argv',
        language: 'shell',
        script: "printf 'shell-ok\\n'",
        expectedStatuses: ['completed']
      },
      {
        id: 'network-disabled',
        language: 'python',
        script: "import socket\ns = socket.socket()\ns.settimeout(2)\ntry:\n    s.connect(('1.1.1.1', 53))\nexcept OSError:\n    print('network-blocked')\nelse:\n    raise SystemExit(90)\nfinally:\n    s.close()",
        expectedStatuses: ['completed']
      },
      {
        id: 'path-escape-denied',
        language: 'python',
        script: "from pathlib import Path\nPath('/escape.txt').write_text('denied')",
        expectedStatuses: ['failed']
      },
      {
        id: 'symlink-artifact-denied',
        language: 'shell',
        script: "ln -s /etc/passwd /workspace/leak.txt",
        expectedStatuses: ['failed']
      },
      {
        id: 'timeout-cleanup',
        language: 'shell',
        script: 'sleep 31',
        expectedStatuses: ['timed_out']
      },
      {
        id: 'cpu-limit',
        language: 'python',
        script: "import time\nend = time.monotonic() + 3\nvalue = 0\nwhile time.monotonic() < end:\n    value += 1\nprint(value)",
        expectedStatuses: ['completed'],
        validate(result) {
          if (
            typeof result.resourceEvidence?.cpuPercent !== 'number' ||
            result.resourceEvidence.cpuPercent > 110
          ) {
            const error = new Error('Docker CPU accounting did not prove the one-core limit.');
            error.code = 'SANDBOX_AUDIT_CPU_EVIDENCE_MISSING';
            throw error;
          }
        }
      },
      {
        id: 'memory-limit',
        language: 'python',
        script: "blocks = []\nwhile True:\n    blocks.append(bytearray(16 * 1024 * 1024))",
        expectedStatuses: ['oom_killed', 'failed'],
        validate(result) {
          if (
            typeof result.resourceEvidence?.memoryLimitBytes !== 'number' ||
            result.resourceEvidence.memoryLimitBytes > 512 * 1024 * 1024
          ) {
            const error = new Error('Docker memory accounting did not prove the 512 MiB limit.');
            error.code = 'SANDBOX_AUDIT_MEMORY_EVIDENCE_MISSING';
            throw error;
          }
        }
      }
    ];
    const rejected = await rejectCase(runtime, auditId);
    emitProgress(rejected);
    const results = [rejected];
    for (const definition of cases) {
      const result = await executeCase(runtime, definition, auditId);
      emitProgress(result);
      results.push(result);
    }
    if (!emptyDirectory(workspaceRoot)) {
      const error = new Error('Sandbox Workspace cleanup was incomplete.');
      error.code = 'SANDBOX_AUDIT_CLEANUP_FAILED';
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      provider: 'hypha.DockerSandboxProviderFactory',
      preflight,
      policy,
      cases: results,
      workspaceCleanupVerified: true,
      hyphaSourceModified: false
    }, null, 2)}\n`);
  } finally {
    await artifactRepository.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'blocked',
    code: typeof error?.code === 'string' ? error.code : 'SANDBOX_AUDIT_FAILED',
    message: 'Real Docker Sandbox acceptance did not complete.'
  })}\n`);
  process.exitCode = 1;
});
