const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { requireAuditActorId } = require('./audit-identity.cjs');
const {
  DATA_DELETION_PHASES,
  createDataDeletionAuditEntry
} = require('./data-deletion-audit-receipt.cjs');

const DATA_DELETION_AUDIT_RECOVERY_SCHEMA = 'lexpilot.data-deletion-audit-recovery.v1';
const OPERATION_ID_PATTERN = /^lexpilot-deletion\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function requireOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw new TypeError('deletionOperationId must be a safe LexPilot deletion identifier.');
  }
  return value;
}

function validateOutcomeEntry(entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    entry.deletionPhase === DATA_DELETION_PHASES.REQUESTED
  ) {
    throw new TypeError('recovery entry must be a completed or failed deletion outcome.');
  }
  const expected = createDataDeletionAuditEntry({
    operationId: entry.deletionOperationId,
    scope: entry.deletionScope,
    phase: entry.deletionPhase,
    targetSessionCount: entry.targetSessionCount,
    targetArtifactCount: entry.targetArtifactCount,
    deletedSessionCount: entry.deletedSessionCount,
    deletedArtifactCount: entry.deletedArtifactCount,
    deletionFailureCount: entry.deletionFailureCount,
    errorCode: entry.errorCode
  });
  if (canonicalJson(entry) !== canonicalJson(expected)) {
    throw new TypeError('recovery entry has undeclared or drifted fields.');
  }
  return expected;
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery record must be an object.');
  }
  if (
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(['actorId', 'entry', 'schemaVersion'].sort()) ||
    value.schemaVersion !== DATA_DELETION_AUDIT_RECOVERY_SCHEMA
  ) {
    fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery envelope has drifted.');
  }
  try {
    requireAuditActorId(value.actorId);
    const entry = validateOutcomeEntry(value.entry);
    return Object.freeze({
      schemaVersion: DATA_DELETION_AUDIT_RECOVERY_SCHEMA,
      actorId: value.actorId,
      entry
    });
  } catch (cause) {
    fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery record failed validation.', cause);
  }
}

function createDataDeletionAuditRecoveryStore(options = {}) {
  if (typeof options.directory !== 'string' || options.directory.trim().length === 0) {
    throw new TypeError('directory must be a non-empty string.');
  }
  const directory = path.resolve(options.directory);

  function recordPath(operationId) {
    return path.join(directory, `${requireOperationId(operationId)}.json`);
  }

  function readRecord(filePath) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (cause) {
      fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery file is unreadable.', cause);
    }
    return validateEnvelope(parsed);
  }

  return Object.freeze({
    enqueue({ actorId, entry } = {}) {
      requireAuditActorId(actorId);
      const validatedEntry = validateOutcomeEntry(entry);
      const envelope = Object.freeze({
        schemaVersion: DATA_DELETION_AUDIT_RECOVERY_SCHEMA,
        actorId,
        entry: validatedEntry
      });
      const finalPath = recordPath(validatedEntry.deletionOperationId);
      if (fs.existsSync(finalPath)) {
        const existing = readRecord(finalPath);
        if (canonicalJson(existing) !== canonicalJson(envelope)) {
          fail(
            'DELETION_AUDIT_RECOVERY_CONFLICT',
            'A different deletion outcome already uses this operation identifier.'
          );
        }
        return Object.freeze({ status: 'already_queued', operationId: validatedEntry.deletionOperationId });
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(
        directory,
        `.${validatedEntry.deletionOperationId}.${randomUUID()}.tmp`
      );
      try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600
        });
        readRecord(temporaryPath);
        fs.renameSync(temporaryPath, finalPath);
      } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      }
      return Object.freeze({ status: 'queued', operationId: validatedEntry.deletionOperationId });
    },

    list() {
      if (!fs.existsSync(directory)) return Object.freeze([]);
      const stat = fs.statSync(directory);
      if (!stat.isDirectory()) {
        fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery path must be a directory.');
      }
      const records = [];
      for (const name of fs.readdirSync(directory).sort()) {
        if (/^\.lexpilot-deletion\..+\.tmp$/.test(name)) continue;
        const match = /^(lexpilot-deletion\.[0-9a-f-]+)\.json$/.exec(name);
        if (!match || !OPERATION_ID_PATTERN.test(match[1])) {
          fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery directory contains an unsafe file.');
        }
        const record = readRecord(path.join(directory, name));
        if (record.entry.deletionOperationId !== match[1]) {
          fail('DELETION_AUDIT_RECOVERY_INVALID', 'Deletion audit recovery filename does not match its record.');
        }
        records.push(record);
      }
      return Object.freeze(records);
    },

    remove(operationId) {
      const filePath = recordPath(operationId);
      if (!fs.existsSync(filePath)) {
        return Object.freeze({ status: 'already_absent', operationId });
      }
      fs.rmSync(filePath);
      return Object.freeze({ status: 'removed', operationId });
    }
  });
}

module.exports = {
  DATA_DELETION_AUDIT_RECOVERY_SCHEMA,
  createDataDeletionAuditRecoveryStore
};
