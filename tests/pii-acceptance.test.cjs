const assert = require('node:assert/strict');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');
const { LegalSelfCheckConversationService } = require('../src/v0/conversation-service.cjs');
const { detectPii, redactPii } = require('../src/v0/pii-redactor.cjs');
const { classifyBusinessTask } = require('../src/v0/task-type-classifier.cjs');

const acceptanceCases = [
  {
    label: 'unlabeled Chinese name',
    piiType: 'NAME',
    rawValue: '张三',
    input: '我叫张三，老板昨天辞退了我。',
    placeholder: '[NAME_1]'
  },
  {
    label: 'detailed Chinese address',
    piiType: 'ADDRESS',
    rawValue: '北京市朝阳区建国路88号',
    input: '我住在北京市朝阳区建国路88号，想咨询租赁纠纷。',
    placeholder: '[ADDRESS_1]'
  },
  {
    label: 'bank-card number',
    piiType: 'BANK_CARD',
    rawValue: '6222021234567890123',
    input: '对方要求我把钱转到银行卡号6222021234567890123。',
    placeholder: '[BANK_CARD_1]'
  }
];

for (const acceptanceCase of acceptanceCases) {
  test(`detects and redacts ${acceptanceCase.label}`, () => {
    assert.equal(detectPii(acceptanceCase.input).includes(acceptanceCase.piiType), true);

    const result = redactPii(acceptanceCase.input);
    assert.equal(result.piiRedacted, true);
    assert.equal(result.redactedText.includes(acceptanceCase.rawValue), false);
    assert.equal(result.redactedText.includes(acceptanceCase.placeholder), true);
    assert.equal(detectPii(result.redactedText).length, 0);
  });
}

test('never sends original acceptance-matrix PII to the task classifier', () => {
  const classifierInputs = [];
  const service = new LegalSelfCheckConversationService({
    taskClassifier(input) {
      classifierInputs.push(input.redactedText);
      return classifyBusinessTask(input);
    },
    idFactory: () => 'pii-boundary-session',
    clock: () => '2026-07-20T00:00:00.000Z'
  });
  const rawValues = acceptanceCases.map((item) => item.rawValue);
  const result = service.start({
    userText:
      '我叫张三，住在北京市朝阳区建国路88号，银行卡号6222021234567890123，老板昨天辞退了我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.notEqual(result.status, 'failed');
  assert.equal(classifierInputs.length, 1);
  for (const rawValue of rawValues) {
    assert.equal(classifierInputs[0].includes(rawValue), false);
  }
  assert.match(classifierInputs[0], /\[NAME_1\]/);
  assert.match(classifierInputs[0], /\[ADDRESS_1\]/);
  assert.match(classifierInputs[0], /\[BANK_CARD_1\]/);
});

test('reuses one bank-card placeholder across compact and spaced formats', () => {
  const result = redactPii(
    '银行卡号6222021234567890123，稍后又写成卡号6222 0212 3456 7890 123。'
  );

  assert.equal(result.redactedText.match(/\[BANK_CARD_1\]/g).length, 2);
  assert.equal(result.redactionSummary.BANK_CARD, 1);
});

test('prefers an explicit bank-card label over the generic 18-digit ID pattern', () => {
  const result = redactPii('卡号622202123456789012。');

  assert.equal(result.redactedText.includes('[BANK_CARD_1]'), true);
  assert.equal(result.redactionSummary.BANK_CARD, 1);
  assert.equal(result.redactionSummary.ID_CARD, 0);
});

test('does not redact ordinary words or unrelated numbers', () => {
  const ordinaryText = '我叫了外卖，合同编号202607200001，工作3年，房屋面积88平方米。';

  assert.deepEqual(detectPii(ordinaryText), []);
  assert.equal(redactPii(ordinaryText).redactedText, ordinaryText);
});

const separatorVariantCases = [
  {
    label: 'space-separated ID-card number',
    piiType: 'ID_CARD',
    rawValue: '110 105 1949 1231 002X',
    input: '身份证 110 105 1949 1231 002X',
    placeholder: '[ID_CARD_1]'
  },
  {
    label: 'space-grouped phone number',
    piiType: 'PHONE',
    rawValue: '138 0013 8000',
    input: '我的电话是138 0013 8000',
    placeholder: '[PHONE_1]'
  },
  {
    label: 'hyphen-grouped phone number',
    piiType: 'PHONE',
    rawValue: '138-0013-8000',
    input: '手机138-0013-8000',
    placeholder: '[PHONE_1]'
  }
];

for (const separatorCase of separatorVariantCases) {
  test(`detects and redacts ${separatorCase.label}`, () => {
    assert.equal(detectPii(separatorCase.input).includes(separatorCase.piiType), true);

    const result = redactPii(separatorCase.input);
    assert.equal(result.piiRedacted, true);
    assert.equal(result.redactedText.includes(separatorCase.rawValue), false);
    assert.equal(result.redactedText.includes(separatorCase.placeholder), true);
    assert.equal(detectPii(result.redactedText).length, 0);
  });
}

test('reuses one placeholder across compact and separator-grouped formats', () => {
  const result = redactPii(
    '电话13800138000，也写作138 0013 8000；身份证11010519491231002X，也写作110 105 1949 1231 002X。'
  );

  assert.equal(result.redactedText.match(/\[PHONE_1\]/g).length, 2);
  assert.equal(result.redactedText.match(/\[ID_CARD_1\]/g).length, 2);
  assert.equal(result.redactionSummary.PHONE, 1);
  assert.equal(result.redactionSummary.ID_CARD, 1);
  assert.equal(detectPii(result.redactedText).length, 0);
});

test('does not redact amounts, years, or longer separator-grouped digit runs', () => {
  const ordinaryText = '工资8500元，工龄3年，2024年入职，月薪约8 500元，单号6222 0212 3456 7890 123。';

  assert.deepEqual(detectPii(ordinaryText), []);
  assert.equal(redactPii(ordinaryText).redactedText, ordinaryText);
});
