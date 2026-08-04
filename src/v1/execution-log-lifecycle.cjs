const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createDemoExecutionLog } = require('./demo-execution-log.cjs');

const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVED_LOG_FILE_NAME = 'execution-log.jsonl';
const ARCHIVE_MANIFEST_FILE_NAME = 'manifest.json';
const DELETE_SOURCE_CONFIRMATION = 'DELETE_VERIFIED_EXECUTION_LOG_SOURCE';
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERIFIED_LOG_STATUSES = new Set(['verified', 'verified_with_legacy_anchor']);

class ExecutionLogLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionLogLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExecutionLogLifecycleError(code, message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireSafeArchiveId(value) {
  if (typeof value !== 'string' || !ARCHIVE_ID_PATTERN.test(value)) {
    fail('ARCHIVE_ID_INVALID', 'archiveId must be a safe non-empty identifier.');
  }
  return value;
}

function requireRegularFile(filePath, code) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(code, 'Required execution log file does not exist.');
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(code, 'Execution log lifecycle only accepts regular files.');
  }
  return stats;
}

function requireDirectory(directoryPath, code) {
  let stats;
  try {
    stats = fs.lstatSync(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(code, 'Required execution log archive does not exist.');
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(code, 'Execution log archive must be a regular directory.');
  }
}

function readJsonFile(filePath, code) {
  requireRegularFile(filePath, code);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail(code, 'Execution log archive manifest is invalid.');
  }
}

function validateManifest(manifest, archiveId) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== ARCHIVE_SCHEMA_VERSION ||
    manifest.archiveId !== archiveId ||
    manifest.logFile !== ARCHIVED_LOG_FILE_NAME ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.recordCount) ||
    manifest.recordCount < 1 ||
    !Number.isSafeInteger(manifest.verifiedCount) ||
    manifest.verifiedCount < 1 ||
    !Number.isSafeInteger(manifest.legacyCount) ||
    manifest.legacyCount < 0 ||
    typeof manifest.headHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.headHash) ||
    !VERIFIED_LOG_STATUSES.has(manifest.integrityStatus) ||
    manifest.sourceDeletionPolicy !== 'verified-archive-and-exact-byte-match' ||
    manifest.restorePolicy !== 'verify-and-never-overwrite'
  ) {
    fail('ARCHIVE_MANIFEST_INVALID', 'Execution log archive manifest failed validation.');
  }
}

function compareIntegrity(actual, expected) {
  return (
    actual.status === expected.integrityStatus &&
    actual.recordCount === expected.recordCount &&
    actual.verifiedCount === expected.verifiedCount &&
    actual.legacyCount === expected.legacyCount &&
    actual.headHash === expected.headHash
  );
}

function createExecutionLogLifecycle(options = {}) {
  if (typeof options.filePath !== 'string' || options.filePath.trim().length === 0) {
    throw new TypeError('filePath must be a non-empty string.');
  }
  if (
    typeof options.archiveDirectory !== 'string' ||
    options.archiveDirectory.trim().length === 0
  ) {
    throw new TypeError('archiveDirectory must be a non-empty string.');
  }
  const filePath = path.resolve(options.filePath);
  const archiveDirectory = path.resolve(options.archiveDirectory);
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;

  function archivePaths(archiveId, root = archiveDirectory) {
    requireSafeArchiveId(archiveId);
    const directory = path.join(root, archiveId);
    return {
      directory,
      logFilePath: path.join(directory, ARCHIVED_LOG_FILE_NAME),
      manifestFilePath: path.join(directory, ARCHIVE_MANIFEST_FILE_NAME)
    };
  }

  function inspectArchivePaths(archiveId, locations) {
    requireSafeArchiveId(archiveId);
    requireDirectory(locations.directory, 'ARCHIVE_NOT_FOUND');
    const manifest = readJsonFile(locations.manifestFilePath, 'ARCHIVE_MANIFEST_INVALID');
    validateManifest(manifest, archiveId);
    requireRegularFile(locations.logFilePath, 'ARCHIVE_LOG_INVALID');
    const bytes = fs.readFileSync(locations.logFilePath);
    if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256) {
      fail('ARCHIVE_HASH_MISMATCH', 'Archived execution log bytes do not match the manifest.');
    }
    let integrity;
    try {
      integrity = createDemoExecutionLog({ filePath: locations.logFilePath }).verifyIntegrity();
    } catch {
      fail('ARCHIVE_LOG_INTEGRITY_FAILED', 'Archived execution log hash chain is invalid.');
    }
    if (!compareIntegrity(integrity, manifest)) {
      fail('ARCHIVE_LOG_INTEGRITY_FAILED', 'Archived execution log does not match its manifest.');
    }
    return { locations, manifest, bytes, integrity };
  }

  function inspectArchiveAt(archiveId) {
    return inspectArchivePaths(archiveId, archivePaths(archiveId));
  }

  return Object.freeze({
    archive() {
      requireRegularFile(filePath, 'SOURCE_LOG_NOT_FOUND');
      let integrity;
      try {
        integrity = createDemoExecutionLog({ filePath }).verifyIntegrity();
      } catch {
        fail('SOURCE_LOG_INTEGRITY_FAILED', 'Source execution log hash chain is invalid.');
      }
      if (!VERIFIED_LOG_STATUSES.has(integrity.status) || integrity.verifiedCount < 1) {
        fail('SOURCE_LOG_NOT_VERIFIED', 'Only a verified non-empty execution log can be archived.');
      }
      const bytes = fs.readFileSync(filePath);
      const archiveId = requireSafeArchiveId(idFactory());
      const createdAt = clock();
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
        throw new TypeError('clock must return a valid timestamp string.');
      }
      const manifest = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        archiveId,
        createdAt,
        logFile: ARCHIVED_LOG_FILE_NAME,
        bytes: bytes.length,
        sha256: sha256(bytes),
        recordCount: integrity.recordCount,
        verifiedCount: integrity.verifiedCount,
        legacyCount: integrity.legacyCount,
        headHash: integrity.headHash,
        integrityStatus: integrity.status,
        sourceDeletionPolicy: 'verified-archive-and-exact-byte-match',
        restorePolicy: 'verify-and-never-overwrite'
      };

      if (fs.existsSync(archiveDirectory)) {
        requireDirectory(archiveDirectory, 'ARCHIVE_DIRECTORY_INVALID');
      } else {
        fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
      }
      const finalPaths = archivePaths(archiveId);
      if (fs.existsSync(finalPaths.directory)) {
        fail('ARCHIVE_ALREADY_EXISTS', 'Execution log archive already exists.');
      }
      const temporaryDirectory = path.join(
        archiveDirectory,
        `.${archiveId}.${randomUUID()}.tmp`
      );
      const temporaryPaths = {
        directory: temporaryDirectory,
        logFilePath: path.join(temporaryDirectory, ARCHIVED_LOG_FILE_NAME),
        manifestFilePath: path.join(temporaryDirectory, ARCHIVE_MANIFEST_FILE_NAME)
      };
      try {
        fs.mkdirSync(temporaryPaths.directory, { mode: 0o700 });
        fs.writeFileSync(temporaryPaths.logFilePath, bytes, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(
          temporaryPaths.manifestFilePath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        inspectArchivePaths(archiveId, temporaryPaths);
        fs.renameSync(temporaryPaths.directory, finalPaths.directory);
      } finally {
        if (fs.existsSync(temporaryPaths.directory)) {
          fs.rmSync(temporaryPaths.directory, { recursive: true, force: true });
        }
      }
      const inspected = inspectArchiveAt(archiveId);
      return Object.freeze({
        status: 'verified',
        archiveId,
        createdAt: inspected.manifest.createdAt,
        bytes: inspected.manifest.bytes,
        sha256: inspected.manifest.sha256,
        recordCount: inspected.manifest.recordCount,
        headHash: inspected.manifest.headHash
      });
    },

    verifyArchive(archiveId) {
      const inspected = inspectArchiveAt(archiveId);
      return Object.freeze({
        status: 'verified',
        archiveId,
        createdAt: inspected.manifest.createdAt,
        bytes: inspected.manifest.bytes,
        sha256: inspected.manifest.sha256,
        recordCount: inspected.manifest.recordCount,
        headHash: inspected.manifest.headHash
      });
    },

    deleteSource({ archiveId, confirmation } = {}) {
      if (confirmation !== DELETE_SOURCE_CONFIRMATION) {
        fail('SOURCE_DELETE_CONFIRMATION_REQUIRED', 'Explicit source deletion confirmation is required.');
      }
      const archived = inspectArchiveAt(archiveId);
      requireRegularFile(filePath, 'SOURCE_LOG_NOT_FOUND');
      const sourceBytes = fs.readFileSync(filePath);
      if (
        sourceBytes.length !== archived.manifest.bytes ||
        sha256(sourceBytes) !== archived.manifest.sha256
      ) {
        fail('SOURCE_LOG_CHANGED', 'Source execution log changed after the selected archive was created.');
      }
      let sourceIntegrity;
      try {
        sourceIntegrity = createDemoExecutionLog({ filePath }).verifyIntegrity();
      } catch {
        fail('SOURCE_LOG_INTEGRITY_FAILED', 'Source execution log hash chain is invalid.');
      }
      if (!compareIntegrity(sourceIntegrity, archived.manifest)) {
        fail('SOURCE_LOG_CHANGED', 'Source execution log no longer matches the selected archive.');
      }
      fs.unlinkSync(filePath);
      return Object.freeze({ status: 'deleted', archiveId, sourceDeleted: true });
    },

    restoreSource(archiveId) {
      const archived = inspectArchiveAt(archiveId);
      if (fs.existsSync(filePath)) {
        fail('SOURCE_LOG_ALREADY_EXISTS', 'Restore never overwrites an existing execution log.');
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.restore.tmp`;
      try {
        fs.writeFileSync(temporaryPath, archived.bytes, { flag: 'wx', mode: 0o600 });
        const restoredBytes = fs.readFileSync(temporaryPath);
        if (
          restoredBytes.length !== archived.manifest.bytes ||
          sha256(restoredBytes) !== archived.manifest.sha256
        ) {
          fail('RESTORE_VERIFICATION_FAILED', 'Restored execution log bytes failed verification.');
        }
        const restoredIntegrity = createDemoExecutionLog({
          filePath: temporaryPath
        }).verifyIntegrity();
        if (!compareIntegrity(restoredIntegrity, archived.manifest)) {
          fail('RESTORE_VERIFICATION_FAILED', 'Restored execution log hash chain failed verification.');
        }
        try {
          fs.linkSync(temporaryPath, filePath);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            fail('SOURCE_LOG_ALREADY_EXISTS', 'Restore never overwrites an existing execution log.');
          }
          throw error;
        }
        fs.unlinkSync(temporaryPath);
      } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
      return Object.freeze({
        status: 'restored',
        archiveId,
        sourceRestored: true,
        recordCount: archived.manifest.recordCount,
        headHash: archived.manifest.headHash
      });
    }
  });
}

module.exports = {
  ARCHIVE_MANIFEST_FILE_NAME,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVED_LOG_FILE_NAME,
  DELETE_SOURCE_CONFIRMATION,
  ExecutionLogLifecycleError,
  createExecutionLogLifecycle
};
