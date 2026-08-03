const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const DOCKER_PREFLIGHT_TIMEOUT_MS = 10_000;

function preflightError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireValue(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw preflightError('SANDBOX_AUDIT_CONFIG_MISSING', `${name} is required.`);
  }
  return value.trim();
}

function runDocker(commandRunner, dockerPath, args) {
  const result = commandRunner(dockerPath, args, {
    encoding: 'utf8',
    timeout: DOCKER_PREFLIGHT_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error?.code === 'ENOENT') {
    throw preflightError('SANDBOX_DOCKER_CLI_MISSING', 'Docker CLI is unavailable.');
  }
  if (result.error) {
    throw preflightError('SANDBOX_DOCKER_UNAVAILABLE', 'Docker command could not start.');
  }
  return result;
}

function createDockerSandboxPreflight(options = {}) {
  const commandRunner = options.commandRunner ?? spawnSync;
  return Object.freeze({
    check(input = {}) {
      const dockerPath = requireValue(input.dockerPath ?? 'docker', 'dockerPath');
      const imageReference = requireValue(input.imageReference, 'imageReference');
      const imageDigest = requireValue(input.imageDigest, 'imageDigest');
      if (imageReference.includes('@')) {
        throw preflightError(
          'SANDBOX_AUDIT_CONFIG_INVALID',
          'imageReference must not contain a digest.'
        );
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
        throw preflightError(
          'SANDBOX_AUDIT_CONFIG_INVALID',
          'imageDigest must be an immutable SHA-256 digest.'
        );
      }
      const version = runDocker(commandRunner, dockerPath, [
        'version',
        '--format',
        '{{.Client.Version}}|{{.Server.Version}}'
      ]);
      if (version.status !== 0) {
        throw preflightError('SANDBOX_DOCKER_DAEMON_UNAVAILABLE', 'Docker daemon is unavailable.');
      }
      const versions = version.stdout.trim().split('|');
      if (versions.length !== 2 || versions.some((value) => value.length === 0)) {
        throw preflightError('SANDBOX_DOCKER_UNAVAILABLE', 'Docker version evidence is invalid.');
      }
      const immutableReference = `${imageReference}@${imageDigest}`;
      const image = runDocker(commandRunner, dockerPath, [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        immutableReference
      ]);
      if (image.status !== 0) {
        throw preflightError(
          'SANDBOX_DOCKER_IMAGE_MISSING',
          'The digest-pinned Sandbox image is not available locally.'
        );
      }
      const imageId = image.stdout.trim();
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
        throw preflightError('SANDBOX_DOCKER_IMAGE_INVALID', 'Docker image identity is invalid.');
      }
      return {
        status: 'ready',
        dockerClientVersion: versions[0],
        dockerServerVersion: versions[1],
        imageReferenceHash: `sha256:${createHash('sha256').update(imageReference).digest('hex')}`,
        imageDigest,
        localImageId: imageId
      };
    }
  });
}

module.exports = {
  DOCKER_PREFLIGHT_TIMEOUT_MS,
  createDockerSandboxPreflight
};
