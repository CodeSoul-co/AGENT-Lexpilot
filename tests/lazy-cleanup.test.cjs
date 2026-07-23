const assert = require('node:assert/strict');
const test = require('node:test');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

function createHarness(options = {}) {
  let now = Date.parse('2026-07-20T00:00:00.000Z');
  const store = new InMemoryLegalSessionStore();
  let purgeCalls = 0;
  const originalPurge = store.purgeInactive.bind(store);
  store.purgeInactive = (inactiveBefore) => {
    purgeCalls += 1;
    return originalPurge(inactiveBefore);
  };
  const service = new LegalSelfCheckConversationService({
    store,
    idFactory: () => 'session-1',
    clock: () => new Date(now).toISOString(),
    ...options
  });
  return {
    service,
    purgeCalls: () => purgeCalls,
    advanceDays: (days) => {
      now += days * DAY_MS;
    }
  };
}

test('startup sweep runs once and entry points are throttled within 24h', () => {
  const harness = createHarness();
  assert.equal(harness.purgeCalls(), 1);

  harness.service.listHistory();
  harness.service.getHistory('missing-session');
  harness.service.answer('missing-session', '测试');
  harness.advanceDays(0.5);
  harness.service.listHistory();

  assert.equal(harness.purgeCalls(), 1);
});

test('long-running process re-runs the sweep on entry points after 24h', () => {
  const harness = createHarness();
  assert.equal(harness.purgeCalls(), 1);

  harness.advanceDays(2);
  harness.service.listHistory();
  assert.equal(harness.purgeCalls(), 2);

  harness.service.getHistory('missing-session');
  harness.service.answer('missing-session', '测试');
  assert.equal(harness.purgeCalls(), 2);

  harness.advanceDays(1);
  harness.service.answer('missing-session', '测试');
  assert.equal(harness.purgeCalls(), 3);
});

test('autoCleanup=false disables both startup and lazy sweeps', () => {
  const harness = createHarness({ autoCleanup: false });
  assert.equal(harness.purgeCalls(), 0);

  harness.advanceDays(100);
  harness.service.listHistory();
  harness.service.answer('missing-session', '测试');

  assert.equal(harness.purgeCalls(), 0);
});
