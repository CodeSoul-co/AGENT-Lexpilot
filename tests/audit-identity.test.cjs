const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const {
  createAuditActorId,
  requireAuditActorId
} = require('../src/v1/audit-identity.cjs');

test('derives a stable keyed actor id without exposing the owner identity', () => {
  const key = randomBytes(32);
  const ownerId = 'private-owner@example.test';
  const first = createAuditActorId(ownerId, key);
  const second = createAuditActorId(ownerId, key);

  assert.equal(first, second);
  assert.match(first, /^actor-hmac-sha256-[0-9a-f]{64}$/);
  assert.equal(first.includes(ownerId), false);
  assert.equal(createAuditActorId('another-owner', key) === first, false);
  assert.equal(requireAuditActorId(first), first);
});

test('supports a deterministic local fallback and rejects raw actor identities', () => {
  const actorId = createAuditActorId('local-test-owner');
  assert.match(actorId, /^actor-sha256-[0-9a-f]{64}$/);
  assert.throws(() => requireAuditActorId('local-test-owner'), /pseudonymous/);
  assert.throws(() => createAuditActorId('', randomBytes(32)), /ownerId/);
  assert.throws(() => createAuditActorId('owner', Buffer.alloc(16)), /at least 32 bytes/);
});
