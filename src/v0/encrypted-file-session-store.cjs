const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isInactiveBeyond, validateTimestamp } = require('./retention-policy.cjs');
const { assertOwnerId, assertSessionOwner } = require('./session-store.cjs');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const AAD = Buffer.from('legal-compliance-session:v1', 'utf8');

function clone(value) {
  return structuredClone(value);
}

function assertEncryptionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('encryptionKey must be a 32-byte Buffer.');
  }
}

function parseBase64EncryptionKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Base64 encryption key is required.');
  }
  const key = Buffer.from(value, 'base64');
  assertEncryptionKey(key);
  if (key.toString('base64') !== value) {
    key.fill(0);
    throw new TypeError('Encryption key must use canonical base64 encoding.');
  }
  return key;
}

class EncryptedFileLegalSessionStore {
  constructor(options = {}) {
    if (typeof options.directory !== 'string' || options.directory.trim().length === 0) {
      throw new TypeError('directory must be a non-empty string.');
    }
    assertEncryptionKey(options.encryptionKey);
    this.directory = path.resolve(options.directory);
    this.encryptionKey = Buffer.from(options.encryptionKey);
  }

  create(session) {
    assertSessionOwner(session);
    const filePath = this.filePath(session.id);
    if (fs.existsSync(filePath)) {
      throw new Error('Session already exists.');
    }
    this.write(filePath, session);
    return clone(session);
  }

  get(sessionId, ownerId) {
    assertOwnerId(ownerId);
    const filePath = this.filePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const session = this.read(filePath);
    return session.ownerId === ownerId ? clone(session) : null;
  }

  save(session, ownerId) {
    assertSessionOwner(session);
    assertOwnerId(ownerId);
    const filePath = this.filePath(session.id);
    if (!fs.existsSync(filePath)) {
      throw new Error('Session does not exist or is not owned by the caller.');
    }
    const existing = this.read(filePath);
    if (existing.ownerId !== ownerId || session.ownerId !== ownerId) {
      throw new Error('Session does not exist or is not owned by the caller.');
    }
    this.write(filePath, session);
    return clone(session);
  }

  delete(sessionId, ownerId) {
    assertOwnerId(ownerId);
    const filePath = this.filePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const session = this.read(filePath);
    if (session.ownerId !== ownerId) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }

  list(ownerId) {
    assertOwnerId(ownerId);
    if (!fs.existsSync(this.directory)) {
      return [];
    }
    return fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.session'))
      .map((entry) => this.read(path.join(this.directory, entry.name)))
      .filter((session) => session.ownerId === ownerId)
      .map(clone);
  }

  count(ownerId) {
    return this.list(ownerId).length;
  }

  purgeInactive(inactiveBefore) {
    validateTimestamp(inactiveBefore, 'inactiveBefore');
    if (!fs.existsSync(this.directory)) {
      return { deletedCount: 0, failedCount: 0 };
    }
    let deletedCount = 0;
    let failedCount = 0;
    const entries = fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.session'));
    for (const entry of entries) {
      const filePath = path.join(this.directory, entry.name);
      try {
        const session = this.read(filePath);
        if (isInactiveBeyond(session, inactiveBefore)) {
          fs.unlinkSync(filePath);
          deletedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    }
    return { deletedCount, failedCount };
  }

  filePath(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string.');
    }
    return path.join(this.directory, this.opaqueFileName(sessionId));
  }

  opaqueFileName(sessionId) {
    const opaqueName = crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex');
    return `${opaqueName}.session`;
  }

  write(filePath, session) {
    fs.mkdirSync(this.directory, { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(session), 'utf8'),
      cipher.final()
    ]);
    const envelope = {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
    const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(envelope), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      fs.renameSync(temporaryPath, filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    }
  }

  read(filePath) {
    try {
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
        throw new Error('Unsupported encrypted session envelope.');
      }
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        this.encryptionKey,
        Buffer.from(envelope.iv, 'base64')
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ]);
      const session = JSON.parse(plaintext.toString('utf8'));
      assertSessionOwner(session);
      if (path.basename(filePath) !== this.opaqueFileName(session.id)) {
        throw new Error('Encrypted session file does not match its content.');
      }
      return session;
    } catch {
      throw new Error('Encrypted session cannot be read.');
    }
  }
}

module.exports = {
  ALGORITHM,
  EncryptedFileLegalSessionStore,
  parseBase64EncryptionKey
};
