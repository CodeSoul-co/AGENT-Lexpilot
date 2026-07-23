const SESSION_RETENTION_DAYS = 90;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function parseTimestamp(value, fieldName) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${fieldName} must be a valid timestamp.`);
  }
  return milliseconds;
}

function validateTimestamp(value, fieldName = 'timestamp') {
  parseTimestamp(value, fieldName);
}

function calculateInactiveBefore(now, retentionDays = SESSION_RETENTION_DAYS) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('retentionDays must be a positive integer.');
  }
  const nowMilliseconds = parseTimestamp(now, 'now');
  return new Date(nowMilliseconds - retentionDays * DAY_IN_MILLISECONDS).toISOString();
}

function isInactiveBeyond(session, inactiveBefore) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('session must be an object.');
  }
  const updatedAt = parseTimestamp(session.updatedAt, 'session.updatedAt');
  const cutoff = parseTimestamp(inactiveBefore, 'inactiveBefore');
  return updatedAt < cutoff;
}

module.exports = {
  SESSION_RETENTION_DAYS,
  calculateInactiveBefore,
  isInactiveBeyond,
  validateTimestamp
};
