const { TASK_TYPES, classifyBusinessTask } = require('../v0/task-type-classifier.cjs');

class TaskRouter {
  constructor(options = {}) {
    this.classifier = options.classifier ?? classifyBusinessTask;
  }

  route(input, context = {}) {
    const classification = this.classifier(input);
    const activeTaskType = context.activeTaskType;
    const strongDifferentTask =
      activeTaskType &&
      activeTaskType !== classification.taskType &&
      ['high', 'medium'].includes(classification.confidence);
    return {
      ...classification,
      routingStatus: strongDifferentTask ? 'task_switch_confirmation_required' : 'routed',
      taskSwitch:
        strongDifferentTask
          ? {
              from: activeTaskType,
              to: classification.taskType,
              confirmationRequired: true
            }
          : null
    };
  }
}

module.exports = { TASK_TYPES, TaskRouter };
