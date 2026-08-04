const { createHash } = require('node:crypto');

const PROFESSIONAL_QUERY_TASK_SCHEMA = 'task-input.legal-professional-query@1.0.0';
const SUPPORTED_OUTPUT_FORMATS = Object.freeze([
  'table',
  'chart',
  'analysis-document',
  'pdf'
]);
const DEFAULT_OUTPUT_FORMATS = SUPPORTED_OUTPUT_FORMATS;
const DATA_SOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{2,127}$/;
const WORKSPACE_ID_PATTERN = /^query-workspace-[0-9a-f]{32}$/;
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'dataSourceId',
  'workspaceId',
  'requestedOutputFormats',
  'effectiveOutputFormats',
  'queryRedacted',
  'queryStoredInReceipt',
  'workspaceKind',
  'workspacePathExposed'
]);

class ProfessionalQueryTaskInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfessionalQueryTaskInputError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProfessionalQueryTaskInputError(code, message);
}

function normalizeRequestedOutputFormats(value) {
  if (value === undefined) return Object.freeze([...DEFAULT_OUTPUT_FORMATS]);
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SUPPORTED_OUTPUT_FORMATS.length ||
    value.some((format) => typeof format !== 'string') ||
    new Set(value).size !== value.length ||
    value.some((format) => !SUPPORTED_OUTPUT_FORMATS.includes(format))
  ) {
    fail(
      'PROFESSIONAL_QUERY_OUTPUT_FORMATS_INVALID',
      'requestedOutputFormats must contain unique supported output formats.'
    );
  }
  return Object.freeze(
    SUPPORTED_OUTPUT_FORMATS.filter((format) => value.includes(format))
  );
}

function deriveWorkspaceId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 200) {
    fail('PROFESSIONAL_QUERY_SESSION_ID_INVALID', 'sessionId is invalid.');
  }
  const digest = createHash('sha256')
    .update(`${PROFESSIONAL_QUERY_TASK_SCHEMA}\0${sessionId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `query-workspace-${digest}`;
}

function validateDataSourceId(value) {
  if (typeof value !== 'string' || !DATA_SOURCE_ID_PATTERN.test(value)) {
    fail('PROFESSIONAL_QUERY_DATA_SOURCE_INVALID', 'The bound data source id is invalid.');
  }
  return value;
}

function createProfessionalQueryTaskInput(options = {}) {
  if (
    options.piiRedacted !== true ||
    typeof options.query !== 'string' ||
    options.query.trim().length < 1 ||
    options.query.length > 5000
  ) {
    fail(
      'PROFESSIONAL_QUERY_TEXT_INVALID',
      'The professional query must be non-empty redacted text.'
    );
  }
  const dataSourceId = validateDataSourceId(options.dataSourceId);
  const requestedOutputFormats = normalizeRequestedOutputFormats(
    options.requestedOutputFormats
  );
  return Object.freeze({
    schema: PROFESSIONAL_QUERY_TASK_SCHEMA,
    query: options.query.trim(),
    data_source_id: dataSourceId,
    workspace_id: deriveWorkspaceId(options.sessionId),
    requested_output_formats: requestedOutputFormats
  });
}

function requireTaskInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join('|') !==
      ['data_source_id', 'query', 'requested_output_formats', 'schema', 'workspace_id']
        .sort()
        .join('|') ||
    input.schema !== PROFESSIONAL_QUERY_TASK_SCHEMA ||
    typeof input.query !== 'string' ||
    input.query.length < 1 ||
    input.query.length > 5000 ||
    !DATA_SOURCE_ID_PATTERN.test(input.data_source_id ?? '') ||
    !WORKSPACE_ID_PATTERN.test(input.workspace_id ?? '')
  ) {
    fail('PROFESSIONAL_QUERY_TASK_INPUT_INVALID', 'Professional query TaskSchema input is invalid.');
  }
  const requestedOutputFormats = normalizeRequestedOutputFormats(
    input.requested_output_formats
  );
  if (
    JSON.stringify(requestedOutputFormats) !==
    JSON.stringify(input.requested_output_formats)
  ) {
    fail('PROFESSIONAL_QUERY_TASK_INPUT_INVALID', 'Output format order is not canonical.');
  }
  return input;
}

function createProfessionalQueryTaskReceipt(input) {
  const taskInput = requireTaskInput(input);
  return Object.freeze({
    schema: taskInput.schema,
    dataSourceId: taskInput.data_source_id,
    workspaceId: taskInput.workspace_id,
    requestedOutputFormats: Object.freeze([...taskInput.requested_output_formats]),
    effectiveOutputFormats: Object.freeze([...DEFAULT_OUTPUT_FORMATS]),
    queryRedacted: true,
    queryStoredInReceipt: false,
    workspaceKind: 'logical-query-session',
    workspacePathExposed: false
  });
}

function restoreProfessionalQueryTaskInput(receipt, query) {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join('|') !== [...RECEIPT_KEYS].sort().join('|') ||
    receipt.schema !== PROFESSIONAL_QUERY_TASK_SCHEMA ||
    receipt.queryRedacted !== true ||
    receipt.queryStoredInReceipt !== false ||
    receipt.workspaceKind !== 'logical-query-session' ||
    receipt.workspacePathExposed !== false ||
    !DATA_SOURCE_ID_PATTERN.test(receipt.dataSourceId ?? '') ||
    !WORKSPACE_ID_PATTERN.test(receipt.workspaceId ?? '') ||
    JSON.stringify(receipt.effectiveOutputFormats) !== JSON.stringify(DEFAULT_OUTPUT_FORMATS)
  ) {
    fail('PROFESSIONAL_QUERY_TASK_RECEIPT_INVALID', 'Professional query task receipt is invalid.');
  }
  const requestedOutputFormats = normalizeRequestedOutputFormats(
    receipt.requestedOutputFormats
  );
  if (
    JSON.stringify(requestedOutputFormats) !==
    JSON.stringify(receipt.requestedOutputFormats) ||
    typeof query !== 'string' ||
    query.trim().length < 1 ||
    query.length > 5000
  ) {
    fail('PROFESSIONAL_QUERY_TASK_RECEIPT_INVALID', 'Task receipt cannot restore safe input.');
  }
  return Object.freeze({
    schema: receipt.schema,
    query: query.trim(),
    data_source_id: receipt.dataSourceId,
    workspace_id: receipt.workspaceId,
    requested_output_formats: requestedOutputFormats
  });
}

module.exports = {
  DEFAULT_OUTPUT_FORMATS,
  PROFESSIONAL_QUERY_TASK_SCHEMA,
  ProfessionalQueryTaskInputError,
  SUPPORTED_OUTPUT_FORMATS,
  createProfessionalQueryTaskInput,
  createProfessionalQueryTaskReceipt,
  normalizeRequestedOutputFormats,
  restoreProfessionalQueryTaskInput
};
