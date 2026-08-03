const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DOCKER_PREFLIGHT_TIMEOUT_MS,
  createDockerSandboxPreflight
} = require('../src/v1/docker-sandbox-preflight.cjs');

const digest = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;

function runner(sequence, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return sequence.shift();
  };
}

test('Docker preflight verifies daemon and the exact immutable image without pulling', () => {
  const calls = [];
  const preflight = createDockerSandboxPreflight({
    commandRunner: runner([
      { status: 0, stdout: '27.5.1|27.5.1\n', stderr: '' },
      { status: 0, stdout: `${imageId}\n`, stderr: '' }
    ], calls)
  });
  const result = preflight.check({
    dockerPath: 'docker-custom',
    imageReference: 'python:3.12-alpine',
    imageDigest: digest
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.localImageId, imageId);
  assert.match(result.imageReferenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result, 'imageReference'), false);
  assert.deepEqual(calls[1].args, [
    'image', 'inspect', '--format', '{{.Id}}', `python:3.12-alpine@${digest}`
  ]);
  assert.equal(calls.some((call) => call.args.includes('pull')), false);
  assert.equal(calls[0].options.timeout, DOCKER_PREFLIGHT_TIMEOUT_MS);
});

test('Docker preflight reports missing CLI, daemon, image, and invalid digest separately', () => {
  assert.throws(
    () => createDockerSandboxPreflight({
      commandRunner: () => ({ error: { code: 'ENOENT' } })
    }).check({ imageReference: 'python:3.12-alpine', imageDigest: digest }),
    (error) => error.code === 'SANDBOX_DOCKER_CLI_MISSING'
  );
  assert.throws(
    () => createDockerSandboxPreflight({
      commandRunner: () => ({ status: 1, stdout: '', stderr: 'private daemon detail' })
    }).check({ imageReference: 'python:3.12-alpine', imageDigest: digest }),
    (error) => error.code === 'SANDBOX_DOCKER_DAEMON_UNAVAILABLE' && !error.message.includes('private')
  );
  const missingImage = createDockerSandboxPreflight({
    commandRunner: runner([
      { status: 0, stdout: '27.5.1|27.5.1\n', stderr: '' },
      { status: 1, stdout: '', stderr: 'private registry detail' }
    ], [])
  });
  assert.throws(
    () => missingImage.check({ imageReference: 'python:3.12-alpine', imageDigest: digest }),
    (error) => error.code === 'SANDBOX_DOCKER_IMAGE_MISSING' && !error.message.includes('private')
  );
  assert.throws(
    () => createDockerSandboxPreflight().check({
      imageReference: 'python:3.12-alpine',
      imageDigest: 'latest'
    }),
    (error) => error.code === 'SANDBOX_AUDIT_CONFIG_INVALID'
  );
  assert.throws(
    () => createDockerSandboxPreflight().check({
      imageReference: `python@${digest}`,
      imageDigest: digest
    }),
    (error) => error.code === 'SANDBOX_AUDIT_CONFIG_INVALID'
  );
});
