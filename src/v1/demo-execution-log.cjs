const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const ENTRY_KEYS = Object.freeze([
  'sessionId',
  'runId',
  'operationType',
  'sql',
  'status',
  'durationMs',
  'rowCount',
  'error'
]);

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function createDemoExecutionLog(options = {}) {
  if (typeof options.filePath !== 'string' || options.filePath.trim().length === 0) {
    throw new TypeError('filePath must be a non-empty string.');
  }
  const filePath = path.resolve(options.filePath);
  const clock = options.clock ?? (() => new Date().toISOString());

  return Object.freeze({
    append(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('entry must be an object.');
      }
      const record = { loggedAt: clock() };
      for (const key of ENTRY_KEYS) {
        if (entry[key] !== undefined) {
          record[key] = entry[key];
        }
      }
      requireNonEmptyString(record.sessionId, 'entry.sessionId');
      requireNonEmptyString(record.operationType, 'entry.operationType');
      requireNonEmptyString(record.status, 'entry.status');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      return { ...record };
    },

    list(filter = {}) {
      const status = filter?.status;
      const limit = filter?.limit ?? DEFAULT_LIST_LIMIT;
      if (status !== undefined && typeof status !== 'string') {
        throw new TypeError('status must be a string.');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new TypeError(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
      }
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const records = [];
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        try {
          const record = JSON.parse(trimmed);
          if (record && typeof record === 'object' && typeof record.loggedAt === 'string') {
            records.push(record);
          }
        } catch {
          // 单行损坏不影响其他日志记录的读取。
        }
      }
      records.sort((left, right) => right.loggedAt.localeCompare(left.loggedAt));
      const matched =
        status === undefined
          ? records
          : records.filter((record) => record.status === status);
      return matched.slice(0, limit);
    }
  });
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  createDemoExecutionLog
};
