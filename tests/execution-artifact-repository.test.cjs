const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ExecutionArtifactRepositoryError,
  createExecutionArtifactRepository
} = require('../src/v1/execution-artifact-repository.cjs');

function artifact(content = '# Verified analysis\n') {
  return {
    artifactId: 'artifact-run-1',
    type: 'analysis-document',
    mimeType: 'text/markdown; charset=utf-8',
    content,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex')
  };
}

test('persists and verifies an analysis Artifact through the pinned Hypha store', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-artifacts-'));
  const repository = createExecutionArtifactRepository({
    rootPath: directory,
    projectRoot: path.resolve(__dirname, '..')
  });
  try {
    const descriptor = repository.describe();
    assert.equal(descriptor.backend, 'hypha.LocalFilesystemExecutionArtifactStore');
    assert.equal(descriptor.rootPathExposed, false);
    assert.equal(JSON.stringify(descriptor).includes(directory), false);

    const receipt = await repository.storeAnalysisArtifact({
      sessionId: 'private-session-id',
      runId: 'private-run-id',
      artifact: artifact()
    });
    assert.equal(receipt.storeId, 'lexpilot.execution-artifacts.local');
    assert.match(receipt.objectKey, /^analysis\/[0-9a-f]{64}\.md$/);
    assert.equal(receipt.objectKey.includes('private-session-id'), false);
    assert.equal(receipt.objectKey.includes('private-run-id'), false);
    assert.equal(receipt.backend, 'hypha.LocalFilesystemExecutionArtifactStore');

    const loaded = await repository.readAnalysisArtifact(receipt);
    assert.equal(loaded.content, artifact().content);
    assert.equal(loaded.contentSha256, artifact().contentSha256);
    assert.equal((await repository.stats()).objects, 1);
    assert.equal((await repository.health()).status, 'healthy');
  } finally {
    await repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects altered content and duplicate immutable object keys', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-artifacts-'));
  const repository = createExecutionArtifactRepository({
    rootPath: directory,
    projectRoot: path.resolve(__dirname, '..')
  });
  try {
    await assert.rejects(
      repository.storeAnalysisArtifact({
        sessionId: 'session-2',
        runId: 'run-2',
        artifact: { ...artifact(), content: '# altered\n' }
      }),
      (error) =>
        error instanceof ExecutionArtifactRepositoryError &&
        error.code === 'ARTIFACT_HASH_MISMATCH'
    );

    const input = { sessionId: 'session-2', runId: 'run-2', artifact: artifact() };
    await repository.storeAnalysisArtifact(input);
    await assert.rejects(repository.storeAnalysisArtifact(input), (error) => {
      assert.equal(error instanceof ExecutionArtifactRepositoryError, true);
      assert.equal(error.message.includes(directory), false);
      return true;
    });
  } finally {
    await repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('physically deletes a verified Artifact and treats a repeated delete as idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-artifact-delete-'));
  const repository = createExecutionArtifactRepository({
    rootPath: directory,
    projectRoot: path.resolve(__dirname, '..')
  });
  try {
    const receipt = await repository.storeAnalysisArtifact({
      sessionId: 'session-delete',
      runId: 'run-delete',
      artifact: artifact()
    });
    assert.deepEqual(await repository.deleteAnalysisArtifact(receipt), {
      status: 'deleted',
      contentSha256: receipt.contentSha256,
      sizeBytes: receipt.sizeBytes
    });
    assert.equal((await repository.stats()).objects, 0);
    await assert.rejects(repository.readAnalysisArtifact(receipt));
    assert.equal((await repository.deleteAnalysisArtifact(receipt)).status, 'already_absent');
  } finally {
    await repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
