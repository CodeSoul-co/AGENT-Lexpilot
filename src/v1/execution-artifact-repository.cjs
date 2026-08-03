const { createHash } = require('node:crypto');
const path = require('node:path');
const { loadHyphaAdaptersLocal } = require('../../scripts/hypha-paths.cjs');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class ExecutionArtifactRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ExecutionArtifactRepositoryError';
    this.code = code;
  }
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function collectContent(content) {
  const chunks = [];
  for await (const chunk of content.stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createExecutionArtifactRepository(options = {}) {
  requireString(options.rootPath, 'rootPath');
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const adapters = loadHyphaAdaptersLocal(projectRoot);
  const Store = adapters.LocalFilesystemExecutionArtifactStore;
  if (typeof Store !== 'function') {
    throw new Error('Pinned Hypha baseline does not expose LocalFilesystemExecutionArtifactStore.');
  }
  const store = new Store({
    id: options.id ?? 'lexpilot.execution-artifacts.local',
    rootPath: path.resolve(options.rootPath),
    maxObjectBytes: options.maxObjectBytes ?? 1_048_576,
    now: options.clock
  });

  return Object.freeze({
    describe() {
      return Object.freeze({
        storeId: store.id,
        backend: 'hypha.LocalFilesystemExecutionArtifactStore',
        visibility: 'private-local',
        maxObjectBytes: options.maxObjectBytes ?? 1_048_576,
        rootPathExposed: false
      });
    },

    async storeAnalysisArtifact({ sessionId, runId, artifact }) {
      requireString(sessionId, 'sessionId');
      requireString(runId, 'runId');
      if (!artifact || typeof artifact !== 'object') {
        throw new TypeError('artifact must be an object.');
      }
      const artifactId = requireString(artifact.artifactId, 'artifact.artifactId');
      const content = requireString(artifact.content, 'artifact.content');
      const expectedHash = requireString(artifact.contentSha256, 'artifact.contentSha256');
      if (!SHA256_PATTERN.test(expectedHash) || sha256(content) !== expectedHash) {
        throw new ExecutionArtifactRepositoryError(
          'ARTIFACT_HASH_MISMATCH',
          'Analysis Artifact content does not match its declared SHA-256.'
        );
      }
      const objectId = sha256(`${sessionId}\0${runId}\0${artifactId}`);
      const objectKey = `analysis/${objectId}.md`;
      const storageContentHash = `sha256:${expectedHash}`;
      let storageRef;
      try {
        storageRef = await store.put({
          operationId: `put-${objectId}`,
          objectKey,
          content: Buffer.from(content, 'utf8'),
          expectedContentHash: storageContentHash,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          mimeType: artifact.mimeType ?? 'text/markdown; charset=utf-8',
          metadata: {
            artifactId,
            artifactType: artifact.type ?? 'analysis-document',
            provenance: 'agent_generated'
          },
          ifAbsent: true
        });
        const verified = await store.get({
          ref: storageRef,
          expectedContentHash: storageContentHash
        });
        const verifiedBytes = await collectContent(verified);
        if (
          verifiedBytes.toString('utf8') !== content ||
          verified.sizeBytes !== Buffer.byteLength(content, 'utf8') ||
          verified.contentHash !== storageContentHash
        ) {
          throw new ExecutionArtifactRepositoryError(
            'ARTIFACT_VERIFY_FAILED',
            'Persisted Analysis Artifact failed its read-back verification.'
          );
        }
      } catch (error) {
        throw new ExecutionArtifactRepositoryError(
          typeof error?.code === 'string' ? error.code : 'ARTIFACT_STORE_FAILED',
          'Analysis Artifact could not be persisted.',
          { cause: error }
        );
      }
      return Object.freeze({
        storeId: storageRef.storeId,
        objectKey: storageRef.objectKey,
        versionId: storageRef.versionId,
        etag: storageRef.etag,
        contentSha256: expectedHash,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        backend: 'hypha.LocalFilesystemExecutionArtifactStore'
      });
    },

    async readAnalysisArtifact(receipt) {
      if (!receipt || typeof receipt !== 'object') {
        throw new TypeError('receipt must be an object.');
      }
      const ref = {
        storeId: requireString(receipt.storeId, 'receipt.storeId'),
        objectKey: requireString(receipt.objectKey, 'receipt.objectKey'),
        ...(receipt.versionId ? { versionId: receipt.versionId } : {}),
        ...(receipt.etag ? { etag: receipt.etag } : {})
      };
      const expectedContentHash = requireString(
        receipt.contentSha256,
        'receipt.contentSha256'
      );
      try {
        const stored = await store.get({ ref, expectedContentHash: `sha256:${expectedContentHash}` });
        const bytes = await collectContent(stored);
        return Object.freeze({
          content: bytes.toString('utf8'),
          contentSha256: stored.contentHash.replace(/^sha256:/, ''),
          sizeBytes: stored.sizeBytes,
          mimeType: stored.mimeType
        });
      } catch (error) {
        throw new ExecutionArtifactRepositoryError(
          typeof error?.code === 'string' ? error.code : 'ARTIFACT_READ_FAILED',
          'Analysis Artifact could not be read or verified.',
          { cause: error }
        );
      }
    },

    async health() {
      return store.health();
    },

    async stats() {
      return store.stats();
    },

    async close() {
      await store.close();
    }
  });
}

module.exports = { ExecutionArtifactRepositoryError, createExecutionArtifactRepository };
