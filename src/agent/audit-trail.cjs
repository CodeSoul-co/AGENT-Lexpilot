const { randomUUID } = require('node:crypto');

function createAuditTrailEvent(type, data, createdAt) {
  if (typeof type !== 'string' || !type || typeof createdAt !== 'string') {
    throw new TypeError('Audit event requires a type and timestamp.');
  }
  return Object.freeze({
    id: randomUUID(),
    type,
    createdAt,
    data: Object.freeze({ ...(data ?? {}) })
  });
}

module.exports = { createAuditTrailEvent };
