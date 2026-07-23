const PII_TYPES = Object.freeze({
  ID_CARD: 'ID_CARD',
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  NAME: 'NAME',
  ADDRESS: 'ADDRESS',
  BANK_CARD: 'BANK_CARD'
});

const COMMON_SINGLE_CHARACTER_SURNAMES =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛雷贺倪汤滕殷毕郝邬安常乐于傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪解应宗丁宣邓';
const COMPOUND_SURNAMES = '欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|令狐';
const SELF_REPORTED_NAME_PATTERN = new RegExp(
  `(我叫|本人叫|(?:申请人|当事人)(?:是|为)?)(\\s*)((?:(?:${COMPOUND_SURNAMES})[\\u3400-\\u9fff]{1,2}|[${COMMON_SINGLE_CHARACTER_SURNAMES}][\\u3400-\\u9fff]{1,2}))(?=[，,。；;\\s]|$)`,
  'g'
);

// ID-card and phone patterns tolerate spaces/hyphens between digits ("110 105 ...",
// "138-0013-8000"); the extra lookarounds reject matches embedded in longer digit runs.
const DETECTORS = Object.freeze({
  [PII_TYPES.ID_CARD]: [/(?<![\dXx])(?<![\dXx][ -])(?:\d[ -]?){17}[\dXx](?![\dXx])(?![ -][\dXx])/g],
  [PII_TYPES.PHONE]: [/(?<!\d)(?<!\d[ -])(?:(?:\+?86)[ -]?)?1[3-9](?:[ -]?\d){9}(?!\d)(?![ -]\d)/g],
  [PII_TYPES.EMAIL]: [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  [PII_TYPES.NAME]: [
    /(姓名|联系人)(\s*[:：]\s*)([\u3400-\u9fff·]{2,8})(?=[，,。；;\s]|$)/g,
    SELF_REPORTED_NAME_PATTERN
  ],
  [PII_TYPES.ADDRESS]: [
    /(?:北京市|上海市|天津市|重庆市|[\u3400-\u9fff]{2,8}(?:省|自治区))[\u3400-\u9fffA-Za-z0-9]{2,40}(?:路|街|道|巷|弄)[\u3400-\u9fffA-Za-z0-9-]{0,20}\d{1,6}号/g
  ],
  [PII_TYPES.BANK_CARD]: [
    /(银行卡号|银行卡|卡号)(\s*(?:是|为|[:：])?\s*)(\d(?:[ -]?\d){15,18})(?!\d)/g
  ]
});

function createReplacementState() {
  return {
    values: new Map(),
    counts: {
      [PII_TYPES.ID_CARD]: 0,
      [PII_TYPES.PHONE]: 0,
      [PII_TYPES.EMAIL]: 0,
      [PII_TYPES.NAME]: 0,
      [PII_TYPES.ADDRESS]: 0,
      [PII_TYPES.BANK_CARD]: 0
    }
  };
}

function placeholderFor(state, type, rawValue) {
  const normalizedValue =
    type === PII_TYPES.BANK_CARD || type === PII_TYPES.PHONE || type === PII_TYPES.ID_CARD
      ? rawValue.replace(/[ -]/g, '').toLowerCase()
      : rawValue.toLowerCase();
  const key = `${type}:${normalizedValue}`;
  const existing = state.values.get(key);
  if (existing) return existing;

  state.counts[type] += 1;
  const placeholder = `[${type}_${state.counts[type]}]`;
  state.values.set(key, placeholder);
  return placeholder;
}

function detectPii(text) {
  const detectedTypes = [];
  for (const [type, patterns] of Object.entries(DETECTORS)) {
    const detected = patterns.some((pattern) => {
      pattern.lastIndex = 0;
      const matched = pattern.test(text);
      pattern.lastIndex = 0;
      return matched;
    });
    if (detected) detectedTypes.push(type);
  }
  return detectedTypes;
}

function redactPii(inputText) {
  if (typeof inputText !== 'string') {
    throw new TypeError('PII redactor only accepts strings.');
  }

  const state = createReplacementState();
  let redactedText = inputText;

  const bankCardPattern = DETECTORS[PII_TYPES.BANK_CARD][0];
  bankCardPattern.lastIndex = 0;
  redactedText = redactedText.replace(
    bankCardPattern,
    (_match, label, separator, rawNumber) =>
      `${label}${separator}${placeholderFor(state, PII_TYPES.BANK_CARD, rawNumber)}`
  );

  for (const type of [
    PII_TYPES.ID_CARD,
    PII_TYPES.PHONE,
    PII_TYPES.EMAIL,
    PII_TYPES.ADDRESS
  ]) {
    const pattern = DETECTORS[type][0];
    pattern.lastIndex = 0;
    redactedText = redactedText.replace(pattern, (rawValue) => placeholderFor(state, type, rawValue));
  }

  for (const namePattern of DETECTORS[PII_TYPES.NAME]) {
    namePattern.lastIndex = 0;
    redactedText = redactedText.replace(namePattern, (_match, label, separator, rawName) => {
      return `${label}${separator}${placeholderFor(state, PII_TYPES.NAME, rawName)}`;
    });
  }

  const remainingTypes = detectPii(redactedText);
  if (remainingTypes.length > 0) {
    throw new Error(`PII redaction incomplete for types: ${remainingTypes.join(',')}`);
  }

  return {
    redactedText,
    piiRedacted: true,
    redactionSummary: { ...state.counts }
  };
}

module.exports = { PII_TYPES, detectPii, redactPii };
