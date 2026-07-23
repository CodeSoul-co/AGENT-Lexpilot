const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDemoExecutionLog } = require('../src/v1/demo-execution-log.cjs');

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
    assert.equal(first.sessionId, 'session-a');
    assert.equal(first.operationType, 'execute');

    const all = log.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].sessionId, 'session-b');
    assert.equal(all[1].sessionId, 'session-a');

    const cancelledOnly = log.list({ status: 'cancelled' });
    assert.equal(cancelledOnly.length, 1);
    assert.equal(cancelledOnly[0].operationType, 'cancel');
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
      'durationMs',
      'loggedAt',
      'operationType',
      'rowCount',
      'runId',
      'sessionId',
      'sql',
      'status'
    ]);
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

test('skips damaged lines without failing the whole read', () => {
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
    const records = log.list();
    assert.equal(records.length, 2);
    assert.equal(records[0].sessionId, 'ok-2');
    assert.equal(records[1].sessionId, 'ok-1');
  });
});

test('exposes only append and list with no mutation interface', () => {
  withTemporaryLog((filePath) => {
    const log = createDemoExecutionLog({ filePath });
    assert.equal(Object.isFrozen(log), true);
    assert.deepEqual(Object.keys(log).sort(), ['append', 'list']);
    assert.equal(log.delete, undefined);
    assert.equal(log.update, undefined);
    assert.equal(log.remove, undefined);
    assert.equal(log.clear, undefined);
    assert.throws(() => log.append({ operationType: 'execute', status: 'completed' }), /sessionId/);
  });
});
