const path = require('node:path');
const { loadHyphaAdaptersLocal } = require('../../scripts/hypha-paths.cjs');
const { MAX_CPU_CORES, MAX_EXECUTION_MS, MAX_MEMORY_MB } = require('./sandbox-execution-policy.cjs');

function createDockerSandboxProviderFactory(options = {}) {
  if (!options.artifactRepository?.outputArtifacts) {
    throw new TypeError('artifactRepository.outputArtifacts is required.');
  }
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const { DockerSandboxProviderFactory } = loadHyphaAdaptersLocal(projectRoot);
  if (typeof DockerSandboxProviderFactory !== 'function') {
    throw new Error('Pinned Hypha baseline does not expose DockerSandboxProviderFactory.');
  }

  return async function providerFactory(workspacePath) {
    const factory = new DockerSandboxProviderFactory({
      providerId: 'provider.docker.lexpilot.v1',
      engineScopeId: 'lexpilot.v1.sandbox',
      policy: {
        workspaceRoot: path.resolve(workspacePath),
        containerCommand: ['sleep', 'infinity'],
        containerWorkspaceRoot: '/workspace',
        maxCpuCores: MAX_CPU_CORES,
        maxMemoryBytes: MAX_MEMORY_MB * 1024 * 1024,
        maxPidsLimit: 64,
        maxTempBytes: 16 * 1024 * 1024,
        maxExecutionTimeoutMs: MAX_EXECUTION_MS,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
        maxCombinedOutputBytes: 2 * 1024 * 1024,
        maxCleanupStopTimeoutSeconds: 1
      },
      outputArtifacts: options.artifactRepository.outputArtifacts,
      ...(options.dockerPath ? { dockerPath: options.dockerPath } : {})
    });
    return factory.create();
  };
}

module.exports = { createDockerSandboxProviderFactory };
