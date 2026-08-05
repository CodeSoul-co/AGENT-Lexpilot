const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ExecutionLogIntegrityError,
  createDemoExecutionLog
} = require('../src/v1/demo-execution-log.cjs');

function withTemporaryLog(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-execution-log-test-'));
  try {
    return run(path.join(directory, 'v1-execution-log.jsonl'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function entry(overrides = {}) {
  return {
    actorId: `actor-sha256-${'a'.repeat(64)}`,
    sessionId: 'session-1',
    runId: 'run-1',
    operationType: 'execute',
    sql: 'SELECT year FROM labor_cases;',
    status: 'completed',
    durationMs: 3,
    rowCount: 3,
    ...overrides
  };
}

test('appends jsonl entries and lists them newest first', () => {
  withTemporaryLog((filePath) => {
    let tick = 0;
    const log = createDemoExecutionLog({
      filePath,
      clock: () => `2026-07-21T03:00:0${tick++}.000Z`
    });
    log.append(entry({ sessionId: 'session-a' }));
    log.append(entry({ sessionId: 'session-b', status: 'cancelled', operationType: 'cancel' }));

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.loggedAt, '2026-07-21T03:00:00.000Z');
    assert.equal(first.actorId, `actor-sha256-${'a'.repeat(64)}`);
    assert.equal(first.sessionId, 'session-a');
    assert.equal(first.operationType, 'execute');
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.sequence, 1);
    assert.match(first.entryId, /^[0-9a-f-]{36}$/);
    assert.match(first.entryHash, /^[0-9a-f]{64}$/);

    const all = log.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].sessionId, 'session-b');
    assert.equal(all[1].sessionId, 'session-a');

    const cancelledOnly = log.list({ status: 'cancelled' });
    assert.equal(cancelledOnly.length, 1);
    assert.equal(cancelledOnly[0].operationType, 'cancel');
  });
});

test('records only governed provider and Artifact Store receipts', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    const objectKey = `analysis/${'a'.repeat(64)}.md`;
    const stored = log.append(
      entry({
        artifactStoreId: 'lexpilot.execution-artifacts.local',
        artifactObjectKey: objectKey,
        executionProvider: 'hypha-adapters-local.loadSqlite',
        providerDurationMs: 12,
        providerOutputBytes: 256,
        providerReadOnly: true,
        sourceRowCount: 5
      })
    );
    assert.equal(stored.artifactObjectKey, objectKey);
    assert.equal(stored.providerReadOnly, true);
    assert.throws(
      () => log.append(entry({ artifactObjectKey: '../private/session.md' })),
      /governed analysis object key/
    );
    assert.throws(() => log.append(entry({ providerReadOnly: false })), /must be true/);
  });
});

test('drops undeclared entry fields so user text never reaches the log', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    log.append(entry({ redactedText: '张三的原始输入', userText: '张三' }));

    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('张三'), false);
    const [record] = log.list();
    assert.deepEqual(Object.keys(record).sort(), [
      'actorId',
      'durationMs',
      'entryHash',
      'entryId',
      'loggedAt',
      'operationType',
      'previousHash',
      'rowCount',
      'runId',
      'schemaVersion',
      'sequence',
      'sessionId',
      'sql',
      'status'
    ]);
  });
});

test('records aggregate owner-erasure counts without owner or session detail lists', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    const record = log.append(entry({
      sessionId: 'owner-erasure',
      runId: undefined,
      sql: undefined,
      operationType: 'owner_history_erasure_completed',
      targetSessionCount: 3,
      targetArtifactCount: 2,
      erasedSessionCount: 3,
      erasedArtifactCount: 2,
      auditRecordsRetained: true,
      ownerId: 'private-owner',
      erasedSessionIds: ['private-session']
    }));
    assert.equal(record.erasedSessionCount, 3);
    assert.equal(record.auditRecordsRetained, true);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes('private-owner'), false);
    assert.equal(raw.includes('private-session'), false);
    assert.throws(
      () => log.append(entry({ erasedArtifactCount: -1 })),
      /non-negative safe integer/
    );
    assert.throws(
      () => log.append(entry({ auditRecordsRetained: 'yes' })),
      /must be a boolean/
    );
  });
});

test('records only hashed Sandbox inputs and structured lifecycle receipts', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    const privateScript = 'print("private-script-value")';
    const record = log.append(
      entry({
        operationType: 'sandbox_execute',
        sql: undefined,
        language: 'python',
        scriptSha256: `sha256:${'b'.repeat(64)}`,
        sandboxInvocationId: 'lexpilot-sandbox.sandbox-run-plan-1',
        inputFileCount: 1,
        inputBytes: 64,
        generatedArtifactCount: 2,
        executionAttempted: true,
        humanReviewRequired: true,
        humanReviewStatus: 'approved',
        executionProvider: 'docker-sandbox-provider',
        sandboxCleanupVerified: true,
        processTreeTerminationVerified: true,
        resourceAccountingMode: 'docker-stats',
        script: privateScript,
        inputFiles: [{ path: 'private.txt', content: 'private-file-value' }]
      })
    );

    assert.equal(record.operationType, 'sandbox_execute');
    assert.equal(record.generatedArtifactCount, 2);
    assert.equal(record.sandboxCleanupVerified, true);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(privateScript), false);
    assert.equal(raw.includes('private-file-value'), false);
    assert.equal(log.verifyIntegrity().status, 'verified');
    assert.throws(
      () => log.append(entry({ scriptSha256: 'sha256:unsafe' })),
      /scriptSha256/
    );
  });
});

test('honors limit and defaults to 50 entries', () => {
  withTemporaryLog((filePath) => {
    let tick = 0;
    const log = createDemoExecutionLog({
      filePath,
      clock: () => `2026-07-21T03:00:${String(tick++).padStart(2, '0')}.000Z`
    });
    for (let index = 0; index < 55; index += 1) {
      log.append(entry({ sessionId: `session-${index}` }));
    }
    assert.equal(log.list().length, 50);
    assert.equal(log.list({ limit: 2 }).length, 2);
    assert.equal(log.list({ limit: 2 })[0].sessionId, 'session-54');
    assert.throws(() => log.list({ limit: 0 }), /limit/);
    assert.throws(() => log.list({ limit: 501 }), /limit/);
  });
});

test('returns an empty list when the log file does not exist', () => {
  const log = createDemoExecutionLog({
    filePath: path.join(os.tmpdir(), 'v1-execution-log-test-missing', 'none.jsonl')
  });
  assert.deepEqual(log.list(), []);
});

test('fails closed when a damaged line is found', () => {
  withTemporaryLog((filePath) => {
    fs.writeFileSync(
      filePath,
      [
        '{"loggedAt":"2026-07-21T03:00:00.000Z","sessionId":"ok-1","operationType":"execute","status":"completed"}',
        '{not-json',
        'null',
        '{"loggedAt":"2026-07-21T03:00:01.000Z","sessionId":"ok-2","operationType":"cancel","status":"cancelled"}',
        ''
      ].join('\n'),
      'utf8'
    );
    const log = createDemoExecutionLog({ filePath });
    assert.throws(
      () => log.list(),
      (error) => error instanceof ExecutionLogIntegrityError && error.code === 'INVALID_JSON'
    );
    assert.throws(() => log.append(entry()), ExecutionLogIntegrityError);
  });
});

test('exposes append, list, and integrity verification with no mutation interface', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    assert.equal(Object.isFrozen(log), true);
    assert.deepEqual(Object.keys(log).sort(), ['append', 'list', 'verifyIntegrity']);
    assert.equal(log.delete, undefined);
    assert.equal(log.update, undefined);
    assert.equal(log.remove, undefined);
    assert.equal(log.clear, undefined);
    assert.throws(() => log.append({ operationType: 'execute', status: 'completed' }), /sessionId/);
  });
});

test('detects record tampering and missing records inside the hash chain', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    log.append(entry({ sessionId: 'session-a' }));
    log.append(entry({ sessionId: 'session-b' }));

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.status = 'failed';
    fs.writeFileSync(filePath, `${JSON.stringify(tampered)}\n${lines[1]}\n`, 'utf8');
    assert.throws(
      () => log.verifyIntegrity(),
      (error) => error instanceof ExecutionLogIntegrityError && error.code === 'ENTRY_HASH_MISMATCH'
    );

    fs.writeFileSync(filePath, `${lines[1]}\n`, 'utf8');
    assert.throws(
      () => log.verifyIntegrity(),
      (error) => error instanceof ExecutionLogIntegrityError && error.code === 'SEQUENCE_MISMATCH'
    );
  });
});

test('anchors readable legacy records when the first verified record is appended', () => {
  withTemporaryLog((filePath) => {
    fs.writeFileSync(
      filePath,
      '{"loggedAt":"2026-07-21T03:00:00.000Z","sessionId":"legacy","operationType":"execute","status":"completed"}\n',
      'utf8'
    );
    const log = createDemoExecutionLog({ filePath });
    assert.equal(log.verifyIntegrity().status, 'legacy_unverified');

    log.append(entry({ sessionId: 'verified' }));
    const integrity = log.verifyIntegrity();
    assert.equal(integrity.status, 'verified_with_legacy_anchor');
    assert.equal(integrity.legacyCount, 1);
    assert.equal(integrity.verifiedCount, 1);
    assert.equal(log.list().length, 2);
  });
});
