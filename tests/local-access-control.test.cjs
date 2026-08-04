const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACCESS_ACTIONS,
  LOCAL_ACCESS_SCHEMA,
  createLocalAccessControl
} = require('../src/web/local-access-control.cjs');

test('binds the ordinary-user role at server startup without exposing its subject', () => {
  const access = createLocalAccessControl({ subjectId: 'private-owner', role: 'user' });
  assert.deepEqual(access.describe(), {
    schema: LOCAL_ACCESS_SCHEMA,
    role: 'user',
    grants: ['session:use', 'artifact:download'],
    identityBinding: 'server-startup',
    clientRoleSelectable: false,
    productionAuthentication: false,
    separationOfDuties: false
  });
  assert.equal(JSON.stringify(access.describe()).includes('private-owner'), false);
  assert.equal(access.assertAllowed(ACCESS_ACTIONS.ARTIFACT_DOWNLOAD).allowed, true);
  assert.throws(
    () => access.assertAllowed(ACCESS_ACTIONS.DATA_SOURCE_MANAGE),
    (error) => error?.code === 'LOCAL_ACCESS_DENIED'
  );
  assert.throws(
    () => access.assertAllowed(ACCESS_ACTIONS.SESSION_USE, 'another-owner'),
    (error) => error?.code === 'LOCAL_ACCESS_DENIED'
  );
});

test('grants administrative operations only to the server-bound administrator role', () => {
  const access = createLocalAccessControl({ subjectId: 'private-admin', role: 'administrator' });
  assert.deepEqual(access.describe().grants, Object.values(ACCESS_ACTIONS));
  for (const action of Object.values(ACCESS_ACTIONS)) {
    assert.equal(access.assertAllowed(action).action, action);
  }
});

test('rejects undeclared roles, actions, and empty server subjects', () => {
  assert.throws(
    () => createLocalAccessControl({ subjectId: 'owner', role: 'reviewer' }),
    /role must be user or administrator/
  );
  assert.throws(
    () => createLocalAccessControl({ subjectId: '' }),
    /subjectId must be a non-empty/
  );
  const access = createLocalAccessControl({ subjectId: 'owner' });
  assert.throws(
    () => access.assertAllowed('artifact:delete'),
    /action is not declared/
  );
});
