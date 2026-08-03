const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadHyphaAdaptersLocal } = require('../../scripts/hypha-paths.cjs');

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function artifactReference(ref) {
  return `artifact:${ref.storeId}:${ref.objectKey}`;
}

function safeWorkspaceFile(workspacePath, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new TypeError('Generated file path is invalid.');
  }
  const portableSegments = relativePath.replace(/\\/g, '/').split('/');
  if (portableSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('Generated file path must stay within the Sandbox Workspace.');
  }
  const root = path.resolve(workspacePath);
  const candidate = path.resolve(root, ...portableSegments);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('Generated file path must stay within the Sandbox Workspace.');
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new TypeError('Generated Artifact must be a single-link regular file.');
  }
  const canonical = fs.realpathSync(candidate);
  const canonicalRelative = path.relative(fs.realpathSync(root), canonical);
  if (
    !canonicalRelative ||
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new TypeError('Generated Artifact resolved outside the Sandbox Workspace.');
  }
  return { candidate, stat };
}

function createSandboxArtifactRepository(options = {}) {
  if (typeof options.rootPath !== 'string' || options.rootPath.trim().length === 0) {
    throw new TypeError('rootPath is required.');
  }
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const { LocalFilesystemExecutionArtifactStore } = loadHyphaAdaptersLocal(projectRoot);
  if (typeof LocalFilesystemExecutionArtifactStore !== 'function') {
    throw new Error('Pinned Hypha baseline does not expose LocalFilesystemExecutionArtifactStore.');
  }
  const store = new LocalFilesystemExecutionArtifactStore({
    id: options.id ?? 'lexpilot.sandbox-artifacts.local',
    rootPath: path.resolve(options.rootPath),
    maxObjectBytes: options.maxObjectBytes ?? MAX_ARTIFACT_BYTES,
    now: options.clock
  });

  async function persist({ operationSeed, objectKey, content, mimeType, metadata }) {
    const contentHash = `sha256:${sha256(content)}`;
    const ref = await store.put({
      operationId: `put-${sha256(operationSeed).slice(0, 32)}`,
      objectKey,
      content,
      expectedContentHash: contentHash,
      sizeBytes: content.byteLength,
      mimeType,
      metadata,
      ifAbsent: true
    });
    return artifactReference(ref);
  }

  const outputArtifacts = Object.freeze({
    openStream({ executionId, stream }) {
      if (!['stdout', 'stderr'].includes(stream)) throw new TypeError('Unsupported output stream.');
      const chunks = [];
      let totalBytes = 0;
      let closed = false;
      return {
        async append(chunk) {
          if (closed) throw new Error('Artifact stream is closed.');
          const bytes = Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_OUTPUT_BYTES) throw new Error('Sandbox output Artifact limit exceeded.');
          chunks.push(bytes);
        },
        async complete() {
          if (closed) throw new Error('Artifact stream is closed.');
          closed = true;
          const content = Buffer.concat(chunks);
          const keyHash = sha256(`${executionId}\0${stream}`);
          return persist({
            operationSeed: `${executionId}:${stream}`,
            objectKey: `sandbox-output/${keyHash}.${stream}`,
            content,
            mimeType: 'text/plain; charset=utf-8',
            metadata: { artifactType: 'sandbox-output', stream }
          });
        },
        async abort() {
          closed = true;
          chunks.length = 0;
        }
      };
    }
  });

  return Object.freeze({
    describe() {
      return {
        storeId: store.id,
        backend: 'hypha.LocalFilesystemExecutionArtifactStore',
        visibility: 'private-local',
        rootPathExposed: false,
        maxArtifactBytes: options.maxObjectBytes ?? MAX_ARTIFACT_BYTES
      };
    },
    outputArtifacts,
    async storeGeneratedFiles({ workspacePath, executionId, runId, changedFiles }) {
      if (!Array.isArray(changedFiles)) throw new TypeError('changedFiles must be an array.');
      const stored = [];
      for (const mutation of changedFiles) {
        if (!['created', 'modified', 'renamed'].includes(mutation.operation)) continue;
        const { candidate, stat } = safeWorkspaceFile(workspacePath, mutation.path);
        if (stat.size > (options.maxObjectBytes ?? MAX_ARTIFACT_BYTES)) {
          throw new Error('Generated Artifact limit exceeded.');
        }
        const content = fs.readFileSync(candidate);
        const contentHash = `sha256:${sha256(content)}`;
        if (mutation.afterHash && mutation.afterHash !== contentHash) {
          throw new Error('Generated Artifact changed after Sandbox evidence capture.');
        }
        const identity = sha256(`${runId}\0${executionId}\0${mutation.path}\0${contentHash}`);
        stored.push(await persist({
          operationSeed: identity,
          objectKey: `sandbox-generated/${identity}.bin`,
          content,
          mimeType: 'application/octet-stream',
          metadata: {
            artifactType: 'sandbox-generated-file',
            sourcePathHash: `sha256:${sha256(mutation.path)}`
          }
        }));
      }
      return stored;
    },
    async health() {
      return store.health();
    },
    async close() {
      await store.close();
    }
  });
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_OUTPUT_BYTES,
  createSandboxArtifactRepository
};
