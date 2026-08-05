const { isInactiveBeyond, validateTimestamp } = require('./retention-policy.cjs');

function clone(value) {
  return structuredClone(value);
}

function assertOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw new TypeError('ownerId must be a non-empty string.');
  }
}

function assertSessionOwner(session) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session must be an object.');
  }
  assertOwnerId(session.ownerId);
}

class InMemoryLegalSessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(session) {
    assertSessionOwner(session);
    if (this.sessions.has(session.id)) {
      throw new Error(`Session already exists: ${session.id}`);
    }
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  get(sessionId, ownerId) {
    assertOwnerId(ownerId);
    const session = this.sessions.get(sessionId);
    return session?.ownerId === ownerId ? clone(session) : null;
  }

  save(session, ownerId) {
    assertSessionOwner(session);
    assertOwnerId(ownerId);
    const existing = this.sessions.get(session.id);
    if (!existing || existing.ownerId !== ownerId || session.ownerId !== ownerId) {
      throw new Error('Session does not exist or is not owned by the caller.');
    }
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  delete(sessionId, ownerId) {
    assertOwnerId(ownerId);
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) {
      return false;
    }
    return this.sessions.delete(sessionId);
  }

  list(ownerId) {
    assertOwnerId(ownerId);
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId)
      .map(clone);
  }

  count(ownerId) {
    if (ownerId === undefined) {
      return this.sessions.size;
    }
    return this.list(ownerId).length;
  }

  scanInactive(inactiveBefore) {
    validateTimestamp(inactiveBefore, 'inactiveBefore');
    const sessions = [];
    let failedCount = 0;
    for (const session of this.sessions.values()) {
      try {
        if (isInactiveBeyond(session, inactiveBefore)) sessions.push(clone(session));
      } catch {
        failedCount += 1;
      }
    }
    return { sessions, failedCount };
  }

  purgeInactive(inactiveBefore) {
    const scanned = this.scanInactive(inactiveBefore);
    let deletedCount = 0;
    let failedCount = scanned.failedCount;
    for (const session of scanned.sessions) {
      try {
        if (!this.delete(session.id, session.ownerId)) throw new Error('Session disappeared.');
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    return { deletedCount, failedCount };
  }
}

module.exports = { assertOwnerId, assertSessionOwner, InMemoryLegalSessionStore };
