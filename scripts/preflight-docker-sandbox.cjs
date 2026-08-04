const path = require('node:path');
const { loadLocalEnv } = require('./load-env.cjs');
const { createDockerSandboxPreflight } = require('../src/v1/docker-sandbox-preflight.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');

loadLocalEnv();

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const workspaceExecution = loadWorkspaceExecutionProfile({ projectRoot }).resolve(process.env);
  const result = createDockerSandboxPreflight().check({
    dockerPath: process.env.LEGAL_V1_DOCKER_PATH || 'docker',
    imageReference: workspaceExecution.executionEnvironment.image.reference,
    imageDigest: workspaceExecution.executionEnvironment.image.digest
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'blocked',
    code: typeof error?.code === 'string' ? error.code : 'SANDBOX_PREFLIGHT_FAILED',
    message: 'Docker Sandbox preflight did not complete.'
  })}\n`);
  process.exitCode = 1;
}
