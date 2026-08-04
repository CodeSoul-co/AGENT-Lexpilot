const { createHash, createHmac } = require('node:crypto');

const ACTOR_ID_PATTERN = /^actor-(?:hmac-)?sha256-[0-9a-f]{64}$/;

function requireOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw new TypeError('ownerId must be a non-empty string.');
  }
  return ownerId.trim();
}

function requireAuditActorId(actorId) {
  if (typeof actorId !== 'string' || !ACTOR_ID_PATTERN.test(actorId)) {
    throw new TypeError('auditActorId must be a pseudonymous SHA-256 actor id.');
  }
  return actorId;
}

function createAuditActorId(ownerId, key) {
  const normalizedOwnerId = requireOwnerId(ownerId);
  const context = 'lexpilot.execution-audit.actor.v1\0';
  if (key !== undefined) {
    if (!Buffer.isBuffer(key) || key.length < 32) {
      throw new TypeError('audit actor HMAC key must contain at least 32 bytes.');
    }
    const digest = createHmac('sha256', key)
      .update(context, 'utf8')
      .update(normalizedOwnerId, 'utf8')
      .digest('hex');
    return `actor-hmac-sha256-${digest}`;
  }
  const digest = createHash('sha256')
    .update(context, 'utf8')
    .update(normalizedOwnerId, 'utf8')
    .digest('hex');
  return `actor-sha256-${digest}`;
}

module.exports = {
  ACTOR_ID_PATTERN,
  createAuditActorId,
  requireAuditActorId
};
