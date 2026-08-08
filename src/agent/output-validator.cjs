const { TASK_TYPES } = require('../v0/task-type-classifier.cjs');

function validateAgentOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError('Agent output must be an object.');
  }
  if (output.taskType === TASK_TYPES.LEGAL_SELF_CHECK) {
    if (output.decision?.legalConclusionGenerated !== false) {
      const error = new Error('Legal output boundary rejected the response.');
      error.code = 'UNSUPPORTED_LEGAL_CONCLUSION';
      throw error;
    }
  }
  if (
    output.taskType === TASK_TYPES.PROFESSIONAL_DATA_QUERY &&
    output.executionAttempted === true
  ) {
    const error = new Error('Data analysis execution requires an explicit review confirmation.');
    error.code = 'V1_CONFIRMATION_GATE_BYPASSED';
    throw error;
  }
  return output;
}

module.exports = { validateAgentOutput };
