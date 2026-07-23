const V0_DOMAIN_PACK_VERSION = '0.16.0';
const PRIVACY_POLICY_VERSION = 'legal-compliance-privacy-v0.1';

const PRIVACY_AUTHORIZATION_STATUS = Object.freeze({
  GRANTED: 'granted',
  REFUSED: 'refused',
  NOT_RECORDED: 'not_recorded'
});

const V0_ERROR_CODES = Object.freeze({
  INVALID_USER_TEXT: 'INVALID_USER_TEXT',
  PRIVACY_POLICY_VERSION_UNSUPPORTED: 'PRIVACY_POLICY_VERSION_UNSUPPORTED',
  PRIVACY_CONSENT_REQUIRED: 'PRIVACY_CONSENT_REQUIRED',
  PII_REDACTION_FAILED: 'PII_REDACTION_FAILED',
  TASK_TYPE_CLASSIFICATION_FAILED: 'TASK_TYPE_CLASSIFICATION_FAILED',
  INVALID_CLARIFICATION_CONTEXT: 'INVALID_CLARIFICATION_CONTEXT',
  UNSUPPORTED_LEGAL_DOMAIN: 'UNSUPPORTED_LEGAL_DOMAIN',
  INSUFFICIENT_INFORMATION: 'INSUFFICIENT_INFORMATION',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_ACCEPTING_INPUT: 'SESSION_NOT_ACCEPTING_INPUT',
  SESSION_DELETE_CONFIRMATION_REQUIRED: 'SESSION_DELETE_CONFIRMATION_REQUIRED',
  LAW_CORPUS_INVALID: 'LAW_CORPUS_INVALID',
  INVALID_LAW_RETRIEVAL_QUERY: 'INVALID_LAW_RETRIEVAL_QUERY',
  LAW_RETRIEVAL_FAILED: 'LAW_RETRIEVAL_FAILED',
  LAW_COMPARISON_FAILED: 'LAW_COMPARISON_FAILED',
  RESULT_CARD_BUILD_FAILED: 'RESULT_CARD_BUILD_FAILED'
});

class V0ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V0ContractError';
    this.code = code;
  }
}

function validateLegalSelfCheckInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, '输入必须是对象。');
  }

  const allowedKeys = new Set(['userText', 'privacyConsent', 'privacyPolicyVersion']);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, '输入包含未声明字段。');
  }

  if (typeof input.userText !== 'string') {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, 'userText 必须是字符串。');
  }

  const normalizedText = input.userText.trim();
  if (normalizedText.length < 1 || normalizedText.length > 5000) {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, 'userText 长度必须为 1 到 5000 个字符。');
  }

  if (typeof input.privacyConsent !== 'boolean') {
    throw new V0ContractError(V0_ERROR_CODES.INVALID_USER_TEXT, 'privacyConsent 必须是布尔值。');
  }

  if (input.privacyPolicyVersion !== PRIVACY_POLICY_VERSION) {
    throw new V0ContractError(
      V0_ERROR_CODES.PRIVACY_POLICY_VERSION_UNSUPPORTED,
      '必须确认当前版本的隐私政策。'
    );
  }

  return {
    userText: normalizedText,
    privacyConsent: input.privacyConsent,
    privacyPolicyVersion: input.privacyPolicyVersion
  };
}

module.exports = {
  V0_DOMAIN_PACK_VERSION,
  PRIVACY_POLICY_VERSION,
  PRIVACY_AUTHORIZATION_STATUS,
  V0_ERROR_CODES,
  V0ContractError,
  validateLegalSelfCheckInput
};
