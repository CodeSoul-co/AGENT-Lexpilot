const {
  V0_DOMAIN_PACK_VERSION,
  PRIVACY_AUTHORIZATION_STATUS,
  V0_ERROR_CODES,
  V0ContractError,
  validateLegalSelfCheckInput
} = require('./contracts.cjs');
const { detectPii, redactPii } = require('./pii-redactor.cjs');

function event(type, data = {}) {
  return { type, data };
}

function safeError(code, message) {
  return { code, message };
}

function prepareLegalSelfCheckInput(input, options = {}) {
  const trace = [];
  const textLength = typeof input?.userText === 'string' ? input.userText.length : null;
  trace.push(event('v0.input.received', { textLength }));

  let validatedInput;
  try {
    validatedInput = validateLegalSelfCheckInput(input);
  } catch (error) {
    const contractError =
      error instanceof V0ContractError
        ? error
        : new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, '输入合同校验失败。');
    trace.push(event('v0.input.rejected', { code: contractError.code }));
    return {
      status: 'failed',
      authorizationStatus: PRIVACY_AUTHORIZATION_STATUS.NOT_RECORDED,
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: false,
      error: safeError(contractError.code, contractError.message),
      trace
    };
  }

  trace.push(event('v0.privacy.consent.checked', { granted: validatedInput.privacyConsent }));
  if (!validatedInput.privacyConsent) {
    const error = safeError(V0_ERROR_CODES.PRIVACY_CONSENT_REQUIRED, '必须先主动同意隐私政策和脱敏说明。');
    trace.push(event('v0.privacy.consent.rejected', { code: error.code }));
    return {
      status: 'rejected',
      authorizationStatus: PRIVACY_AUTHORIZATION_STATUS.REFUSED,
      privacyPolicyVersion: validatedInput.privacyPolicyVersion,
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: false,
      error,
      trace
    };
  }

  const redactor = options.redactor ?? redactPii;
  try {
    const result = redactor(validatedInput.userText);
    if (
      !result ||
      result.piiRedacted !== true ||
      typeof result.redactedText !== 'string' ||
      detectPii(result.redactedText).length > 0
    ) {
      throw new Error('Redactor returned an unsafe result.');
    }
    trace.push(
      event('v0.pii.redaction.completed', {
        piiRedacted: result.piiRedacted === true,
        redactionSummary: result.redactionSummary
      })
    );
    return {
      status: 'ready',
      authorizationStatus: PRIVACY_AUTHORIZATION_STATUS.GRANTED,
      privacyPolicyVersion: validatedInput.privacyPolicyVersion,
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: true,
      redactedText: result.redactedText,
      redactionSummary: result.redactionSummary,
      trace
    };
  } catch (_error) {
    const error = safeError(V0_ERROR_CODES.PII_REDACTION_FAILED, '个人信息脱敏失败，输入未发送到后续处理。');
    trace.push(event('v0.pii.redaction.failed', { code: error.code }));
    return {
      status: 'failed',
      authorizationStatus: PRIVACY_AUTHORIZATION_STATUS.GRANTED,
      privacyPolicyVersion: validatedInput.privacyPolicyVersion,
      domainPackVersion: V0_DOMAIN_PACK_VERSION,
      piiRedacted: false,
      error,
      trace
    };
  }
}

module.exports = { prepareLegalSelfCheckInput };
