const assert = require('node:assert/strict');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const {
  SESSION_RETENTION_DAYS,
  calculateInactiveBefore,
  isInactiveBeyond
} = require('../src/v0/retention-policy.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const NOW = '2026-04-01T00:00:00.000Z';

function shiftedTimestamp(days, milliseconds = 0) {
  return new Date(Date.parse(NOW) - days * DAY_IN_MILLISECONDS + milliseconds).toISOString();
}

function seedSession(store, { id, ownerId, updatedAt, createdAt = updatedAt }) {
  store.create({
    id,
    ownerId,
    domainPackVersion: '0.6.0',
    status: 'needs_clarification',
    clarificationRound: 0,
    createdAt,
    updatedAt,
    messages: [],
    knownFacts: {},
    missingFields: [],
    questions: [],
    trace: [],
    latestTrace: []
  });
}

test('expires only sessions inactive beyond the exact 90-day boundary', () => {
  const cutoff = calculateInactiveBefore(NOW);
  assert.equal(SESSION_RETENTION_DAYS, 90);
  assert.equal(cutoff, shiftedTimestamp(90));
  assert.equal(isInactiveBeyond({ updatedAt: shiftedTimestamp(90, -1) }, cutoff), true);
  assert.equal(isInactiveBeyond({ updatedAt: shiftedTimestamp(90) }, cutoff), false);
  assert.equal(isInactiveBeyond({ updatedAt: shiftedTimestamp(89) }, cutoff), false);
});

test('automatically cleans expired sessions for all owners at service startup', () => {
  const store = new InMemoryLegalSessionStore();
  seedSession(store, {
    id: 'expired-owner-a',
    ownerId: 'owner-a',
    updatedAt: shiftedTimestamp(90, -1)
  });
  seedSession(store, {
    id: 'boundary-owner-b',
    ownerId: 'owner-b',
    updatedAt: shiftedTimestamp(90)
  });
  seedSession(store, {
    id: 'active-owner-a',
    ownerId: 'owner-a',
    updatedAt: shiftedTimestamp(1),
    createdAt: shiftedTimestamp(120)
  });

  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'maintenance-caller',
    clock: () => NOW
  });

  assert.equal(service.lastCleanup.status, 'completed');
  assert.equal(service.lastCleanup.deletedCount, 1);
  assert.equal(service.lastCleanup.failedCount, 0);
  assert.equal(store.count(), 2);
  assert.equal(store.get('expired-owner-a', 'owner-a'), null);
  assert.notEqual(store.get('boundary-owner-b', 'owner-b'), null);
  assert.notEqual(store.get('active-owner-a', 'owner-a'), null);
  const trace = JSON.stringify(service.lastCleanup.trace);
  assert.equal(trace.includes('expired-owner-a'), false);
  assert.equal(trace.includes('owner-a'), false);
});

test('rejects an invalid cleanup cutoff even when the store is empty', () => {
  const store = new InMemoryLegalSessionStore();
  assert.throws(() => store.purgeInactive('invalid'), /inactiveBefore must be a valid timestamp/);
});

test('supports explicit cleanup for a long-running service', () => {
  const store = new InMemoryLegalSessionStore();
  let now = '2026-01-01T00:00:00.000Z';
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'owner-a',
    idFactory: () => 'long-running-session',
    clock: () => now,
    autoCleanup: false
  });
  service.start({
    userText: '朋友借钱不还。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  now = '2026-04-02T00:00:00.000Z';

  const result = service.cleanupInactiveSessions();
  assert.equal(result.deletedCount, 1);
  assert.equal(service.getHistory('long-running-session'), null);
});

test('does not delete sessions with invalid timestamps and reports partial failure', () => {
  const store = new InMemoryLegalSessionStore();
  seedSession(store, { id: 'invalid-time', ownerId: 'owner-a', updatedAt: 'invalid' });

  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'owner-a',
    clock: () => NOW
  });
  assert.equal(service.lastCleanup.status, 'partial_failure');
  assert.equal(service.lastCleanup.deletedCount, 0);
  assert.equal(service.lastCleanup.failedCount, 1);
  assert.notEqual(store.get('invalid-time', 'owner-a'), null);
  assert.equal(JSON.stringify(service.lastCleanup.trace).includes('invalid-time'), false);
});
