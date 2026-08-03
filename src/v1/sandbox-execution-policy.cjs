const { createHash } = require('node:crypto');

const SANDBOX_POLICY_VERSION = 'lexpilot-docker-sandbox-v1';
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_INPUT_FILES = 32;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTION_MS = 30_000;
const MAX_MEMORY_MB = 512;
const MAX_CPU_CORES = 1;

function requireSafeScript(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Sandbox script request must be an object.');
  }
  const allowed = new Set(['language', 'script']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError('Sandbox script request contains undeclared fields.');
  }
  if (!['python', 'shell'].includes(input.language)) {
    throw new TypeError('Sandbox language must be python or shell.');
  }
  if (typeof input.script !== 'string' || input.script.trim().length === 0) {
    throw new TypeError('Sandbox script must be non-empty.');
  }
  if (input.script.includes('\0')) throw new TypeError('Sandbox script contains a NUL byte.');
  if (Buffer.byteLength(input.script, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new TypeError(`Sandbox script must not exceed ${MAX_SCRIPT_BYTES} bytes.`);
  }
  return Object.freeze({ language: input.language, script: input.script });
}

function requirePortableInputPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new TypeError('Sandbox input file path must be a portable relative path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || /^[A-Za-z]:/.test(value)) {
    throw new TypeError('Sandbox input file path must stay within the Workspace.');
  }
  if (['task.py', 'task.sh'].includes(value.toLowerCase())) {
    throw new TypeError('Sandbox input file path conflicts with the managed script.');
  }
  return value;
}

function requireSandboxRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Sandbox request must be an object.');
  }
  const allowed = new Set(['language', 'script', 'inputFiles']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError('Sandbox request contains undeclared fields.');
  }
  const script = requireSafeScript({ language: input.language, script: input.script });
  const inputFiles = input.inputFiles ?? [];
  if (!Array.isArray(inputFiles) || inputFiles.length > MAX_INPUT_FILES) {
    throw new TypeError(`Sandbox request supports at most ${MAX_INPUT_FILES} input files.`);
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = inputFiles.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError('Sandbox input file must be an object.');
    }
    const fileKeys = new Set(['path', 'contentBase64', 'contentSha256']);
    if (Object.keys(file).some((key) => !fileKeys.has(key))) {
      throw new TypeError('Sandbox input file contains undeclared fields.');
    }
    const relativePath = requirePortableInputPath(file.path);
    const folded = relativePath.toLowerCase();
    if (seen.has(folded)) throw new TypeError('Sandbox input file paths must be unique.');
    seen.add(folded);
    if (
      typeof file.contentBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)
    ) {
      throw new TypeError('Sandbox input file contentBase64 is invalid.');
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new TypeError(`Sandbox input files must not exceed ${MAX_INPUT_BYTES} bytes in total.`);
    }
    const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (file.contentSha256 !== actualHash) {
      throw new TypeError('Sandbox input file content does not match its declared SHA-256.');
    }
    return Object.freeze({
      path: relativePath,
      contentBase64: file.contentBase64,
      contentSha256: actualHash
    });
  });
  return Object.freeze({ ...script, inputFiles: Object.freeze(files) });
}

function buildSandboxEnvironment({ imageReference, imageDigest }) {
  if (typeof imageReference !== 'string' || imageReference.trim().length === 0) {
    throw new TypeError('imageReference is required.');
  }
  if (typeof imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new TypeError('imageDigest must be an immutable SHA-256 Docker digest.');
  }
  return Object.freeze({
    id: 'execution-environment.lexpilot.scripts',
    version: '1.0.0',
    revision: createHash('sha256').update(`${imageReference}@${imageDigest}`).digest('hex'),
    provider: 'docker',
    image: {
      reference: imageReference,
      digest: imageDigest,
      pullPolicy: 'if_not_present',
      requireDigestPin: true
    },
    process: {
      shellEnabled: false,
      allowedExecutables: ['python3', '/bin/sh'],
      executableResolution: 'container_path',
      killProcessTreeOnExit: true,
      inheritHostEnvironment: false
    },
    resources: {
      cpuCores: MAX_CPU_CORES,
      memoryMb: MAX_MEMORY_MB,
      pidsLimit: 64,
      tempBytes: 16 * 1024 * 1024,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      maxCombinedOutputBytes: 2 * 1024 * 1024,
      maxExecutionSeconds: 30
    },
    filesystem: {
      rootFilesystem: 'read_only',
      mounts: [{ sourceRef: 'workspace:current', targetPath: '/workspace', mode: 'rw', type: 'workspace' }],
      tmpfs: [{ targetPath: '/tmp', sizeBytes: 16 * 1024 * 1024 }],
      allowDeviceAccess: false,
      allowHostPathMounts: false
    },
    network: { mode: 'disabled', dnsPolicy: 'disabled' },
    security: {
      runAsUser: '65534',
      runAsGroup: '65534',
      nonRootRequired: true,
      noNewPrivileges: true,
      privileged: false,
      dropCapabilities: ['ALL'],
      allowNestedContainers: false
    },
    secrets: {
      injectionMode: 'none',
      redactFromOutput: true,
      redactFromEvents: true
    },
    logging: {
      captureStdout: true,
      captureStderr: true,
      streamOutput: true,
      persistOutputAsArtifact: true
    },
    lifecycle: { reuse: 'never', cleanupOnSuccess: true, cleanupOnFailure: true },
    workingDirectoryPolicy: 'workspace_only',
    defaultTimeoutMs: MAX_EXECUTION_MS
  });
}

module.exports = {
  MAX_CPU_CORES,
  MAX_EXECUTION_MS,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_MEMORY_MB,
  MAX_SCRIPT_BYTES,
  SANDBOX_POLICY_VERSION,
  buildSandboxEnvironment,
  requireSandboxRequest,
  requireSafeScript
};
