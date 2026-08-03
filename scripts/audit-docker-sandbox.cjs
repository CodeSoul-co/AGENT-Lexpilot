const fs = require('node:fs');
const path = require('node:path');
const { createSandboxArtifactRepository } = require('../src/v1/sandbox-artifact-repository.cjs');
const { createDockerSandboxProviderFactory } = require('../src/v1/docker-sandbox-provider-factory.cjs');
const { createSandboxExecutionRuntime } = require('../src/v1/sandbox-execution-runtime.cjs');

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    const error = new Error(`${name} is required.`);
    error.code = 'SANDBOX_AUDIT_CONFIG_MISSING';
    throw error;
  }
  return value;
}

function emptyDirectory(directory) {
  return !fs.existsSync(directory) || fs.readdirSync(directory).length === 0;
}

async function executeCase(runtime, definition) {
  const runId = `sandbox-audit-${definition.id}`;
  const plan = await runtime.plan({
    language: definition.language,
    script: definition.script,
    runId,
    sessionId: 'sandbox-audit-session'
  });
  const result = await runtime.approve({
    invocationId: plan.invocationId,
    runId,
    approvedAt: new Date().toISOString()
  });
  if (!definition.expectedStatuses.includes(result.status)) {
    const error = new Error(`Sandbox audit case ${definition.id} returned an unexpected status.`);
    error.code = 'SANDBOX_AUDIT_EXPECTATION_FAILED';
    throw error;
  }
  const safeResult = {
    id: definition.id,
    status: result.status,
    eventTypes: result.governanceReceipt.eventTypes,
    cleanupVerified: result.result?.cleanupEvidence?.executionContainerAbsent === true,
    generatedArtifactCount: result.result?.generatedArtifactRefs?.length ?? 0,
    resourceEvidence: result.result?.resourceEvidence
  };
  if (!safeResult.cleanupVerified) {
    const error = new Error(`Sandbox audit case ${definition.id} did not prove cleanup.`);
    error.code = 'SANDBOX_AUDIT_CLEANUP_FAILED';
    throw error;
  }
  definition.validate?.(safeResult);
  return safeResult;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(
    process.env.LEGAL_V1_SANDBOX_WORKSPACE_ROOT ?? path.join(projectRoot, 'data', 'sandbox-workspaces')
  );
  const artifactRoot = path.resolve(
    process.env.LEGAL_V1_SANDBOX_ARTIFACT_ROOT ?? path.join(projectRoot, 'data', 'sandbox-artifacts')
  );
  const imageReference = requireEnvironment('LEGAL_V1_SANDBOX_IMAGE');
  const imageDigest = requireEnvironment('LEGAL_V1_SANDBOX_IMAGE_DIGEST');
  const artifactRepository = createSandboxArtifactRepository({ rootPath: artifactRoot, projectRoot });
  try {
    const runtime = await createSandboxExecutionRuntime({
      workspaceRoot,
      imageReference,
      imageDigest,
      artifactRepository,
      providerFactory: createDockerSandboxProviderFactory({
        projectRoot,
        artifactRepository,
        dockerPath: process.env.LEGAL_V1_DOCKER_PATH
      })
    });
    const policy = runtime.describe().policy;
    const cases = [
      {
        id: 'python-generated-artifact',
        language: 'python',
        script: "from pathlib import Path\nPath('/workspace/result.txt').write_text('sandbox-ok', encoding='utf-8')\nprint('python-ok')",
        expectedStatuses: ['completed']
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
    const results = [];
    for (const definition of cases) results.push(await executeCase(runtime, definition));
    if (!emptyDirectory(workspaceRoot)) {
      const error = new Error('Sandbox Workspace cleanup was incomplete.');
      error.code = 'SANDBOX_AUDIT_CLEANUP_FAILED';
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      provider: 'hypha.DockerSandboxProviderFactory',
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
