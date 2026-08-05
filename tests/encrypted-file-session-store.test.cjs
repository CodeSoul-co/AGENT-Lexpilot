const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const {
  EncryptedFileLegalSessionStore,
  parseBase64EncryptionKey
} = require('../src/v0/encrypted-file-session-store.cjs');

function withTemporaryDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-session-test-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createService(directory, encryptionKey, ownerId = 'owner-a') {
  return new LegalSelfCheckConversationService({
    store: new EncryptedFileLegalSessionStore({ directory, encryptionKey }),
    ownerId,
    idFactory: () => 'session-visible-to-user',
    clock: () => '2026-07-20T00:00:00.000Z'
  });
}

test('requires an explicit 256-bit encryption key', () => {
  assert.throws(
    () => new EncryptedFileLegalSessionStore({ directory: 'unused', encryptionKey: Buffer.alloc(16) }),
    /32-byte Buffer/
  );
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseBase64EncryptionKey(key.toString('base64')), key);
  assert.throws(() => parseBase64EncryptionKey(Buffer.alloc(16).toString('base64')), /32-byte Buffer/);
  assert.throws(
    () => parseBase64EncryptionKey(`${key.toString('base64')}!`),
    /canonical base64/
  );
});

test('persists encrypted sessions across store instances without plaintext metadata', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    const firstProcess = createService(directory, encryptionKey);
    firstProcess.start({
      userText: '姓名：测试甲，朋友欠款，邮箱 test-user@example.com。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });

    const files = fs.readdirSync(directory);
    assert.equal(files.length, 1);
    assert.equal(files[0].includes('session-visible-to-user'), false);
    const onDisk = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(onDisk)).sort(), [
      'algorithm',
      'authTag',
      'ciphertext',
      'iv',
      'version'
    ]);
    assert.equal(onDisk.includes('session-visible-to-user'), false);
    assert.equal(onDisk.includes('owner-a'), false);
    assert.equal(onDisk.includes('测试甲'), false);
    assert.equal(onDisk.includes('[NAME_1]'), false);
    assert.equal(onDisk.includes('[EMAIL_1]'), false);

    const restartedProcess = createService(directory, encryptionKey);
    const history = restartedProcess.getHistory('session-visible-to-user');
    assert.equal(history.messageCount, 1);
    assert.equal(history.messages[0].redactedText.includes('[NAME_1]'), true);
    assert.equal(history.messages[0].redactedText.includes('[EMAIL_1]'), true);
  });
});

test('persists an updated clarification answer across restart', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    const firstProcess = createService(directory, encryptionKey);
    firstProcess.start({
      userText: '朋友借钱不还。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    const answered = firstProcess.answer(
      'session-visible-to-user',
      '我有转账记录，说好去年年底还款。'
    );
    assert.equal(answered.status, 'completed');
    assert.equal(answered.lawReferences[0].id, 'cn.civil-code.article-675');
    assert.equal(answered.lawComparisons[0].comparisonStatus, 'potential_match');
    assert.equal(answered.resultCards[0].lawReferenceId, 'cn.civil-code.article-675');

    const encryptedFile = fs.readdirSync(directory)[0];
    const onDisk = fs.readFileSync(path.join(directory, encryptedFile), 'utf8');
    assert.equal(onDisk.includes(answered.lawReferences[0].articleText), false);
    assert.equal(onDisk.includes(answered.lawComparisons[0].sanitizedFactExcerpt), false);
    assert.equal(onDisk.includes(answered.resultCards[0].articleText), false);

    const restartedProcess = createService(directory, encryptionKey);
    const history = restartedProcess.getHistory('session-visible-to-user');
    assert.equal(history.status, 'completed');
    assert.equal(history.messageCount, 2);
    assert.equal(history.clarificationRound, 1);
    assert.equal(history.lawReferences[0].id, 'cn.civil-code.article-675');
    assert.equal(history.lawComparisons[0].comparisonStatus, 'potential_match');
    assert.equal(history.resultCards[0].lawReferenceId, 'cn.civil-code.article-675');
  });
});

test('enforces owner isolation and physically deletes the encrypted file', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    const ownerA = createService(directory, encryptionKey, 'owner-a');
    const ownerB = createService(directory, encryptionKey, 'owner-b');
    ownerA.start({
      userText: '朋友欠款。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });

    assert.equal(ownerB.getHistory('session-visible-to-user'), null);
    assert.deepEqual(ownerB.listHistory(), []);
    assert.equal(
      ownerB.deleteSession('session-visible-to-user', { confirmed: true }).status,
      'not_found'
    );
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.equal(
      ownerA.deleteSession('session-visible-to-user', { confirmed: true }).status,
      'deleted'
    );
    assert.equal(fs.readdirSync(directory).length, 0);
  });
});

test('owner history erasure physically removes every encrypted session file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-owner-erasure-test-'));
  try {
    const encryptionKey = crypto.randomBytes(32);
    let sequence = 0;
    const service = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey }),
      ownerId: 'owner-a',
      idFactory: () => `owner-session-${++sequence}`,
      autoCleanup: false
    });
    for (const userText of ['朋友欠款。', '老板辞退我。']) {
      service.start({ userText, privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
    }
    assert.equal(fs.readdirSync(directory).length, 2);
    const result = await service.eraseOwnerHistory({
      confirmed: true,
      confirmationPhrase: 'DELETE MY HISTORY'
    });
    assert.equal(result.erasedSessionCount, 2);
    assert.equal(fs.readdirSync(directory).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when the key is wrong or encrypted content is tampered with', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    createService(directory, encryptionKey).start({
      userText: '朋友欠款。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });

    const wrongKeyService = createService(directory, crypto.randomBytes(32));
    assert.throws(
      () => wrongKeyService.getHistory('session-visible-to-user'),
      /Encrypted session cannot be read/
    );

    const filePath = path.join(directory, fs.readdirSync(directory)[0]);
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    fs.writeFileSync(filePath, JSON.stringify(envelope), 'utf8');
    assert.throws(
      () => createService(directory, encryptionKey).getHistory('session-visible-to-user'),
      /Encrypted session cannot be read/
    );
  });
});

test('fails closed when encrypted session files are swapped', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    const store = new EncryptedFileLegalSessionStore({ directory, encryptionKey });
    let sequence = 0;
    const service = new LegalSelfCheckConversationService({
      store,
      ownerId: 'owner-a',
      idFactory: () => `session-${++sequence}`,
      clock: () => '2026-07-20T00:00:00.000Z'
    });
    service.start({
      userText: '朋友欠款。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    service.start({
      userText: '老板辞退我。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });

    const firstPath = store.filePath('session-1');
    const secondPath = store.filePath('session-2');
    const firstEnvelope = fs.readFileSync(firstPath);
    const secondEnvelope = fs.readFileSync(secondPath);
    fs.writeFileSync(firstPath, secondEnvelope);
    fs.writeFileSync(secondPath, firstEnvelope);

    assert.throws(() => service.getHistory('session-1'), /Encrypted session cannot be read/);
    assert.throws(() => service.getHistory('session-2'), /Encrypted session cannot be read/);
  });
});

test('startup retention cleanup physically removes encrypted sessions older than 90 days', () => {
  withTemporaryDirectory((directory) => {
    const encryptionKey = crypto.randomBytes(32);
    const oldService = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey }),
      ownerId: 'owner-a',
      idFactory: () => 'expired-encrypted-session',
      clock: () => '2026-01-01T00:00:00.000Z',
      autoCleanup: false
    });
    oldService.start({
      userText: '朋友欠款。',
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    });
    assert.equal(fs.readdirSync(directory).length, 1);

    const restartedService = new LegalSelfCheckConversationService({
      store: new EncryptedFileLegalSessionStore({ directory, encryptionKey }),
      ownerId: 'owner-a',
      clock: () => '2026-04-02T00:00:00.000Z'
    });
    assert.equal(restartedService.lastCleanup.deletedCount, 1);
    assert.equal(restartedService.lastCleanup.failedCount, 0);
    assert.equal(fs.readdirSync(directory).length, 0);
  });
});
