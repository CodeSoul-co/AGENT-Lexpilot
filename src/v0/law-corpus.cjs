const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { V0_ERROR_CODES, V0ContractError } = require('./contracts.cjs');
const { LEGAL_DOMAINS } = require('./legal-domain.cjs');

const DEFAULT_LAW_CORPUS_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'resources',
  'law-corpus',
  'v0-minimal.zh-CN.json'
);
const SUPPORTED_DOMAINS = new Set(Object.values(LEGAL_DOMAINS));
const OFFICIAL_SOURCE_HOSTS = new Set([
  'flk.npc.gov.cn',
  'www.npc.gov.cn',
  'www.samr.gov.cn',
  'tjca.miit.gov.cn',
  'www.cnipa.gov.cn',
  'www.nsfc.gov.cn',
  'shanxi.chinatax.gov.cn'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `${fieldName} 必须是非空字符串。`);
  }
}

function validateDate(value, fieldName) {
  requireNonEmptyString(value, fieldName);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `${fieldName} 必须是有效日期。`);
  }
}

function validateOfficialUrl(value, fieldName) {
  requireNonEmptyString(value, fieldName);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `${fieldName} 必须是有效 URL。`);
  }
  if (url.protocol !== 'https:' || !OFFICIAL_SOURCE_HOSTS.has(url.hostname)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `${fieldName} 必须指向允许的官方 HTTPS 来源。`);
  }
}

function validateStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `${fieldName} 必须是非空数组。`);
  }
  value.forEach((item) => requireNonEmptyString(item, `${fieldName}[]`));
}

function validateMatching(matching) {
  if (!matching || typeof matching !== 'object' || Array.isArray(matching)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'entry.matching 必须是对象。');
  }
  const allowed = new Set([
    'factRequirements',
    'factExclusions',
    'safeStopFields',
    'excerptSignals',
    'unresolvedElements'
  ]);
  if (Object.keys(matching).some((key) => !allowed.has(key))) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'entry.matching 包含未声明字段。');
  }
  for (const field of ['factRequirements', 'factExclusions']) {
    const rules = matching[field];
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length === 0) {
      throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `entry.matching.${field} 必须是非空对象。`);
    }
    for (const [factName, values] of Object.entries(rules)) {
      requireNonEmptyString(factName, `entry.matching.${field} field`);
      validateStringArray(values, `entry.matching.${field}.${factName}`);
    }
  }
  validateStringArray(matching.safeStopFields, 'entry.matching.safeStopFields');
  validateStringArray(matching.excerptSignals, 'entry.matching.excerptSignals');
  validateStringArray(matching.unresolvedElements, 'entry.matching.unresolvedElements');
  const requirementFields = Object.keys(matching.factRequirements).sort();
  const stopFields = [...new Set(matching.safeStopFields)].sort();
  if (JSON.stringify(requirementFields) !== JSON.stringify(stopFields)) {
    throw new V0ContractError(
      V0_ERROR_CODES.LAW_CORPUS_INVALID,
      'entry.matching.safeStopFields 必须完整覆盖结构化事实条件。'
    );
  }
  if (matching.unresolvedElements.some((value) => !/^[a-z][a-z0-9_]*$/.test(value))) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, '未解决要素必须使用安全代码。');
  }
}

function validateEntry(entry, seenIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, '法规条目必须是对象。');
  }
  for (const field of ['id', 'lawName', 'articleNumber', 'articleText', 'articleTextSha256']) {
    requireNonEmptyString(entry[field], `entry.${field}`);
  }
  if (seenIds.has(entry.id)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `法规条目 ID 重复：${entry.id}`);
  }
  seenIds.add(entry.id);
  if (!SUPPORTED_DOMAINS.has(entry.legalDomain)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `不支持的法规领域：${entry.legalDomain}`);
  }
  validateDate(entry.publicationDate, 'entry.publicationDate');
  validateDate(entry.effectiveDate, 'entry.effectiveDate');
  validateDate(entry.verifiedAt, 'entry.verifiedAt');
  if (entry.status !== 'effective') {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'V0 最小语料只接受已生效条目。');
  }
  if (!Array.isArray(entry.topics) || entry.topics.length === 0) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'entry.topics 必须是非空数组。');
  }
  for (const topic of entry.topics) requireNonEmptyString(topic, 'entry.topics[]');
  if (entry.retrievalEnabled !== true) {
    throw new V0ContractError(
      V0_ERROR_CODES.LAW_CORPUS_INVALID,
      'entry.retrievalEnabled 必须是布尔值。'
    );
  }
  requireNonEmptyString(entry.selectionReason, 'entry.selectionReason');
  validateMatching(entry.matching);
  if (sha256(entry.articleText) !== entry.articleTextSha256) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, `法规正文摘要不匹配：${entry.id}`);
  }
  if (!entry.source || typeof entry.source !== 'object' || Array.isArray(entry.source)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'entry.source 必须是对象。');
  }
  requireNonEmptyString(entry.source.authority, 'entry.source.authority');
  requireNonEmptyString(entry.source.textAuthority, 'entry.source.textAuthority');
  validateOfficialUrl(entry.source.metadataUrl, 'entry.source.metadataUrl');
  validateOfficialUrl(entry.source.textUrl, 'entry.source.textUrl');
  if (entry.effectiveUntil !== undefined) validateDate(entry.effectiveUntil, 'entry.effectiveUntil');
  if (entry.futureVersion !== undefined) {
    if (!entry.futureVersion || typeof entry.futureVersion !== 'object' || Array.isArray(entry.futureVersion)) {
      throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'entry.futureVersion 必须是对象。');
    }
    validateDate(entry.futureVersion.effectiveDate, 'entry.futureVersion.effectiveDate');
    validateOfficialUrl(entry.futureVersion.url, 'entry.futureVersion.url');
  }
}

function validateLawCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, '法规语料必须是对象。');
  }
  for (const field of ['corpusId', 'version', 'jurisdiction', 'language']) {
    requireNonEmptyString(corpus[field], `corpus.${field}`);
  }
  validateDate(corpus.verifiedAt, 'corpus.verifiedAt');
  if (corpus.jurisdiction !== 'CN' || corpus.language !== 'zh-CN') {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'V0 只接受中国大陆简体中文法规语料。');
  }
  if (!Array.isArray(corpus.entries) || corpus.entries.length === 0) {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, 'corpus.entries 必须是非空数组。');
  }
  const seenIds = new Set();
  corpus.entries.forEach((entry) => validateEntry(entry, seenIds));
  return structuredClone(corpus);
}

function loadLawCorpus(filePath = DEFAULT_LAW_CORPUS_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new V0ContractError(V0_ERROR_CODES.LAW_CORPUS_INVALID, '法规语料文件无法读取或不是有效 JSON。');
  }
  return validateLawCorpus(parsed);
}

module.exports = {
  DEFAULT_LAW_CORPUS_PATH,
  OFFICIAL_SOURCE_HOSTS,
  loadLawCorpus,
  sha256,
  validateLawCorpus
};
