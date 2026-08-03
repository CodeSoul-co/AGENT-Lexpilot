const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const LOG_SCHEMA_VERSION = 1;
const GENESIS_HASH = '0'.repeat(64);
const ENTRY_KEYS = Object.freeze([
  'sessionId',
  'runId',
  'operationType',
  'sql',
  'planHash',
  'schemaFingerprint',
  'artifactId',
  'artifactSha256',
  'artifactStoreId',
  'artifactObjectKey',
  'executionProvider',
  'providerDurationMs',
  'providerOutputBytes',
  'providerReadOnly',
  'sourceRowCount',
  'status',
  'durationMs',
  'rowCount',
  'error'
]);

class ExecutionLogIntegrityError extends Error {
  constructor(code, lineNumber) {
    super('执行日志完整性校验失败，已停止读取或追加。');
    this.name = 'ExecutionLogIntegrityError';
    this.code = code;
    this.lineNumber = lineNumber;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function hashRecord(record) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(record)), 'utf8')
    .digest('hex');
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function validateReceiptFields(record) {
  for (const key of ['artifactStoreId', 'artifactObjectKey']) {
    if (record[key] !== undefined) {
      requireNonEmptyString(record[key], `entry.${key}`);
      if (record[key].length > 256) {
        throw new TypeError(`entry.${key} must not exceed 256 characters.`);
      }
    }
  }
  if (
    record.artifactObjectKey !== undefined &&
    !/^analysis\/[0-9a-f]{64}\.md$/.test(record.artifactObjectKey)
  ) {
    throw new TypeError('entry.artifactObjectKey must be a governed analysis object key.');
  }
  if (record.executionProvider !== undefined) {
    requireNonEmptyString(record.executionProvider, 'entry.executionProvider');
    if (record.executionProvider.length > 128) {
      throw new TypeError('entry.executionProvider must not exceed 128 characters.');
    }
  }
  for (const key of ['providerDurationMs', 'providerOutputBytes', 'sourceRowCount']) {
    if (
      record[key] !== undefined &&
      (!Number.isSafeInteger(record[key]) || record[key] < 0)
    ) {
      throw new TypeError(`entry.${key} must be a non-negative safe integer.`);
    }
  }
  if (record.providerReadOnly !== undefined && record.providerReadOnly !== true) {
    throw new TypeError('entry.providerReadOnly must be true when present.');
  }
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      records: [],
      headHash: GENESIS_HASH,
      legacyCount: 0,
      verifiedCount: 0,
      status: 'empty'
    };
  }

  const records = [];
  let headHash = GENESIS_HASH;
  let legacyCount = 0;
  let verifiedCount = 0;
  let hashedRecordsStarted = false;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      throw new ExecutionLogIntegrityError('INVALID_JSON', index + 1);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new ExecutionLogIntegrityError('INVALID_RECORD', index + 1);
    }
    requireNonEmptyString(record.loggedAt, `line ${index + 1}.loggedAt`);

    if (record.schemaVersion !== LOG_SCHEMA_VERSION) {
      if (hashedRecordsStarted) {
        throw new ExecutionLogIntegrityError('LEGACY_RECORD_AFTER_HASH_CHAIN', index + 1);
      }
      legacyCount += 1;
      headHash = hashRecord({ legacyAnchor: headHash, record });
      records.push(record);
      continue;
    }

    hashedRecordsStarted = true;
    const expectedSequence = legacyCount + verifiedCount + 1;
    if (record.sequence !== expectedSequence) {
      throw new ExecutionLogIntegrityError('SEQUENCE_MISMATCH', index + 1);
    }
    if (record.previousHash !== headHash) {
      throw new ExecutionLogIntegrityError('PREVIOUS_HASH_MISMATCH', index + 1);
    }
    const { entryHash, ...unsignedRecord } = record;
    if (typeof entryHash !== 'string' || entryHash !== hashRecord(unsignedRecord)) {
      throw new ExecutionLogIntegrityError('ENTRY_HASH_MISMATCH', index + 1);
    }
    headHash = entryHash;
    verifiedCount += 1;
    records.push(record);
  }

  let status = 'verified';
  if (records.length === 0) status = 'empty';
  else if (legacyCount > 0 && verifiedCount === 0) status = 'legacy_unverified';
  else if (legacyCount > 0) status = 'verified_with_legacy_anchor';

  return { records, headHash, legacyCount, verifiedCount, status };
}

function createDemoExecutionLog(options = {}) {
  if (typeof options.filePath !== 'string' || options.filePath.trim().length === 0) {
    throw new TypeError('filePath must be a non-empty string.');
  }
  const filePath = path.resolve(options.filePath);
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;

  return Object.freeze({
    append(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('entry must be an object.');
      }
      const state = readState(filePath);
      const record = {
        schemaVersion: LOG_SCHEMA_VERSION,
        sequence: state.records.length + 1,
        entryId: idFactory(),
        loggedAt: clock(),
        previousHash: state.headHash
      };
      for (const key of ENTRY_KEYS) {
        if (entry[key] !== undefined) record[key] = entry[key];
      }
      requireNonEmptyString(record.entryId, 'entry.entryId');
      requireNonEmptyString(record.sessionId, 'entry.sessionId');
      requireNonEmptyString(record.operationType, 'entry.operationType');
      requireNonEmptyString(record.status, 'entry.status');
      validateReceiptFields(record);
      record.entryHash = hashRecord(record);

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
      const state = readState(filePath);
      const records = [...state.records].sort((left, right) =>
        right.loggedAt.localeCompare(left.loggedAt)
      );
      const matched =
        status === undefined ? records : records.filter((record) => record.status === status);
      return matched.slice(0, limit);
    },

    verifyIntegrity() {
      const state = readState(filePath);
      return {
        status: state.status,
        recordCount: state.records.length,
        verifiedCount: state.verifiedCount,
        legacyCount: state.legacyCount,
        headHash: state.headHash
      };
    }
  });
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  ExecutionLogIntegrityError,
  LOG_SCHEMA_VERSION,
  MAX_LIST_LIMIT,
  createDemoExecutionLog
};
