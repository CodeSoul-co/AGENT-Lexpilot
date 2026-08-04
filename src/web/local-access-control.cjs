const LOCAL_ACCESS_SCHEMA = 'access-control.local-demo@1.0.0';
const LOCAL_ROLES = Object.freeze({
  USER: 'user',
  ADMINISTRATOR: 'administrator'
});
const ACCESS_ACTIONS = Object.freeze({
  SESSION_USE: 'session:use',
  ARTIFACT_DOWNLOAD: 'artifact:download',
  DATA_SOURCE_MANAGE: 'data-source:manage',
  EXECUTION_LOG_READ: 'execution-log:read',
  HUMAN_REVIEW_APPROVE: 'human-review:approve'
});

const ROLE_GRANTS = Object.freeze({
  [LOCAL_ROLES.USER]: Object.freeze([
    ACCESS_ACTIONS.SESSION_USE,
    ACCESS_ACTIONS.ARTIFACT_DOWNLOAD
  ]),
  [LOCAL_ROLES.ADMINISTRATOR]: Object.freeze(Object.values(ACCESS_ACTIONS))
});

class LocalAccessControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalAccessControlError';
    this.code = code;
  }
}

function requireRole(value) {
  const role = value ?? LOCAL_ROLES.USER;
  if (!Object.values(LOCAL_ROLES).includes(role)) {
    throw new TypeError('local access role must be user or administrator.');
  }
  return role;
}

function requireSubjectId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('local access subjectId must be a non-empty server-bound value.');
  }
  return value.trim();
}

function requireAction(value) {
  if (!Object.values(ACCESS_ACTIONS).includes(value)) {
    throw new TypeError('access action is not declared by the local policy.');
  }
  return value;
}

function createLocalAccessControl(options = {}) {
  const role = requireRole(options.role);
  const subjectId = requireSubjectId(options.subjectId ?? 'local-user');
  const grants = ROLE_GRANTS[role];
  const grantSet = new Set(grants);

  return Object.freeze({
    describe() {
      return Object.freeze({
        schema: LOCAL_ACCESS_SCHEMA,
        role,
        grants: Object.freeze([...grants]),
        identityBinding: 'server-startup',
        clientRoleSelectable: false,
        productionAuthentication: false,
        separationOfDuties: false
      });
    },

    assertAllowed(action, expectedSubjectId = subjectId) {
      const normalizedAction = requireAction(action);
      if (requireSubjectId(expectedSubjectId) !== subjectId || !grantSet.has(normalizedAction)) {
        throw new LocalAccessControlError(
          'LOCAL_ACCESS_DENIED',
          '当前本地身份无权执行该操作。'
        );
      }
      return Object.freeze({
        schema: LOCAL_ACCESS_SCHEMA,
        role,
        action: normalizedAction,
        allowed: true,
        subjectMatched: true
      });
    }
  });
}

module.exports = {
  ACCESS_ACTIONS,
  LOCAL_ACCESS_SCHEMA,
  LOCAL_ROLES,
  LocalAccessControlError,
  createLocalAccessControl
};
