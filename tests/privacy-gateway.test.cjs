const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PRIVACY_AUTHORIZATION_STATUS,
  PRIVACY_POLICY_VERSION,
  V0_ERROR_CODES,
  validateLegalSelfCheckInput
} = require('../src/v0/contracts.cjs');
const { detectPii, redactPii } = require('../src/v0/pii-redactor.cjs');
const { prepareLegalSelfCheckInput } = require('../src/v0/privacy-gateway.cjs');

const syntheticInput =
  '姓名：张三，手机号 13800138000，身份证 11010519491231002X，邮箱 demo.user@example.com。';

test('rejects processing when privacy consent is absent', () => {
  const result = prepareLegalSelfCheckInput({
    userText: syntheticInput,
    privacyConsent: false,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.authorizationStatus, PRIVACY_AUTHORIZATION_STATUS.REFUSED);
  assert.equal(result.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
  assert.equal(result.error.code, V0_ERROR_CODES.PRIVACY_CONSENT_REQUIRED);
  assert.equal('redactedText' in result, false);
  assert.equal(JSON.stringify(result.trace).includes('13800138000'), false);
});

test('rejects missing or outdated privacy-policy versions before redaction', () => {
  for (const privacyPolicyVersion of [undefined, 'legal-compliance-privacy-v0.0']) {
    const input = { userText: syntheticInput, privacyConsent: true };
    if (privacyPolicyVersion !== undefined) input.privacyPolicyVersion = privacyPolicyVersion;
    const result = prepareLegalSelfCheckInput(input);

    assert.equal(result.status, 'failed');
    assert.equal(result.authorizationStatus, PRIVACY_AUTHORIZATION_STATUS.NOT_RECORDED);
    assert.equal(result.error.code, V0_ERROR_CODES.PRIVACY_POLICY_VERSION_UNSUPPORTED);
    assert.equal('redactedText' in result, false);
  }
});

test('redacts supported PII with stable placeholders', () => {
  const text = `${syntheticInput} 再次确认手机号 13800138000。`;
  const result = redactPii(text);

  assert.equal(result.piiRedacted, true);
  assert.equal(detectPii(result.redactedText).length, 0);
  assert.equal(result.redactedText.includes('[NAME_1]'), true);
  assert.equal(result.redactedText.match(/\[PHONE_1\]/g).length, 2);
  assert.equal(result.redactedText.includes('[ID_CARD_1]'), true);
  assert.equal(result.redactedText.includes('[EMAIL_1]'), true);
});

test('returns only sanitized text and PII-safe trace after consent', () => {
  const result = prepareLegalSelfCheckInput({
    userText: syntheticInput,
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'ready');
  assert.equal(result.authorizationStatus, PRIVACY_AUTHORIZATION_STATUS.GRANTED);
  assert.equal(result.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
  assert.equal(result.piiRedacted, true);
  assert.equal(serialized.includes('张三'), false);
  assert.equal(serialized.includes('13800138000'), false);
  assert.equal(serialized.includes('11010519491231002X'), false);
  assert.equal(serialized.includes('demo.user@example.com'), false);
  assert.equal(result.trace.at(-1).type, 'v0.pii.redaction.completed');
});

test('fails closed when the redactor throws', () => {
  const result = prepareLegalSelfCheckInput(
    {
      userText: syntheticInput,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    },
    {
      redactor() {
        throw new Error('synthetic redactor failure');
      }
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, V0_ERROR_CODES.PII_REDACTION_FAILED);
  assert.equal('redactedText' in result, false);
  assert.equal(JSON.stringify(result).includes('13800138000'), false);
});

test('fails closed when a redactor falsely marks raw PII as safe', () => {
  const result = prepareLegalSelfCheckInput(
    {
      userText: syntheticInput,
      privacyConsent: true,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION
    },
    {
      redactor(text) {
        return { piiRedacted: true, redactedText: text, redactionSummary: {} };
      }
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, V0_ERROR_CODES.PII_REDACTION_FAILED);
  assert.equal('redactedText' in result, false);
  assert.equal(JSON.stringify(result).includes('demo.user@example.com'), false);
});

test('rejects empty, oversized, and undeclared input fields', () => {
  assert.throws(
    () =>
      validateLegalSelfCheckInput({
        userText: '   ',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      }),
    (error) => error.code === V0_ERROR_CODES.INVALID_USER_TEXT
  );
  assert.throws(
    () =>
      validateLegalSelfCheckInput({
        userText: '法'.repeat(5001),
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION
      }),
    (error) => error.code === V0_ERROR_CODES.INVALID_USER_TEXT
  );
  assert.throws(
    () =>
      validateLegalSelfCheckInput({
        userText: '测试',
        privacyConsent: true,
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
        rawUserId: 'secret'
      }),
    (error) => error.code === V0_ERROR_CODES.INVALID_USER_TEXT
  );
});
