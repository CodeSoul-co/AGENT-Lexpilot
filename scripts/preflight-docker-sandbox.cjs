const { loadLocalEnv } = require('./load-env.cjs');
const { createDockerSandboxPreflight } = require('../src/v1/docker-sandbox-preflight.cjs');

loadLocalEnv();

function main() {
  const result = createDockerSandboxPreflight().check({
    dockerPath: process.env.LEGAL_V1_DOCKER_PATH || 'docker',
    imageReference: process.env.LEGAL_V1_SANDBOX_IMAGE,
    imageDigest: process.env.LEGAL_V1_SANDBOX_IMAGE_DIGEST
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
