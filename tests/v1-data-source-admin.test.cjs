const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaAdaptersLocal } = require('../scripts/hypha-paths.cjs');
const {
  DataSourceAdminError,
  createDataSourceAdmin
} = require('../src/v1/data-source-admin.cjs');

const projectRoot = path.resolve(__dirname, '..');
const SECRET_VALUES = Object.freeze([
  'TEST_ONLY_SQLITE_PATH_VALUE',
  'TEST_ONLY_PG_HOST_VALUE',
  'TEST_ONLY_PG_USER_VALUE',
  'TEST_ONLY_PG_PASSWORD_VALUE',
  'TEST_ONLY_PG_DATABASE_VALUE',
  'TEST_ONLY_MYSQL_HOST_VALUE',
  'TEST_ONLY_MYSQL_DATABASE_VALUE',
  'TEST_ONLY_MYSQL_USER_VALUE',
  'TEST_ONLY_MYSQL_PASSWORD_VALUE'
]);

function configuredEnvironment() {
  return {
    LEGAL_V1_RUNTIME: 'postgresql',
    LEGAL_V1_SQLITE_PATH: SECRET_VALUES[0],
    LEGAL_V1_PG_HOST: SECRET_VALUES[1],
    LEGAL_V1_PG_PORT: '5432',
    LEGAL_V1_PG_DATABASE: SECRET_VALUES[4],
    LEGAL_V1_PG_USER: SECRET_VALUES[2],
    LEGAL_V1_PG_PASSWORD: SECRET_VALUES[3],
    LEGAL_V1_PG_TLS_MODE: 'require',
    LEGAL_V1_MYSQL_HOST: SECRET_VALUES[5],
    LEGAL_V1_MYSQL_PORT: '3306',
    LEGAL_V1_MYSQL_DATABASE: SECRET_VALUES[6],
    LEGAL_V1_MYSQL_USER: SECRET_VALUES[7],
    LEGAL_V1_MYSQL_PASSWORD: SECRET_VALUES[8],
    LEGAL_V1_MYSQL_TLS_MODE: 'require'
  };
}

function createSQLiteFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexpilot-admin-schema-'));
  const databasePath = path.join(directory, 'labor-cases.sqlite');
  const sqlite = loadHyphaAdaptersLocal(projectRoot).loadSqlite(true);
  const database = new sqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE labor_cases (
      year INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      compensation_amount INTEGER
    );
  `);
  database.close?.();
  return {
    databasePath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

test('lists three read-only profiles using booleans and environment names, never values', () => {
  const admin = createDataSourceAdmin({ projectRoot, env: configuredEnvironment() });
  const result = admin.listProfiles();
  assert.equal(result.status, 'ok');
  assert.equal(result.activeRuntime, 'postgresql');
  assert.equal(result.credentialInputAccepted, false);
  assert.equal(result.credentialValuesExposed, false);
  assert.deepEqual(
    result.profiles.map((profile) => profile.engine),
    ['sqlite', 'postgresql', 'mysql']
  );
  assert.equal(result.profiles.every((profile) => profile.accessMode === 'read-only'), true);
  assert.equal(result.profiles.find((profile) => profile.engine === 'postgresql').active, true);
  assert.equal(
    result.profiles.every((profile) => profile.configurationStatus === 'ready'),
    true
  );
  const serialized = JSON.stringify(result);
  for (const secret of SECRET_VALUES) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('LEGAL_V1_PG_PASSWORD'), true);
});

test('reports missing environment references without attempting a connection', async () => {
  let sourceFactoryCalls = 0;
  const admin = createDataSourceAdmin({
    projectRoot,
    env: { LEGAL_V1_RUNTIME: 'demo' },
    sourceFactory: async () => {
      sourceFactoryCalls += 1;
      throw new Error('must not be called');
    }
  });
  const result = await admin.validateProfile('network.legal_cases.postgresql');
  assert.equal(result.status, 'not_configured');
  assert.equal(result.connectionAttempted, false);
  assert.equal(result.missingEnvironmentNames.includes('LEGAL_V1_PG_PASSWORD'), true);
  assert.equal(sourceFactoryCalls, 0);
});

test('returns a browsable allowlisted snapshot from the configured SQLite provider', async () => {
  const fixture = createSQLiteFixture();
  try {
    const admin = createDataSourceAdmin({
      projectRoot,
      env: { LEGAL_V1_RUNTIME: 'sqlite', LEGAL_V1_SQLITE_PATH: fixture.databasePath }
    });
    const result = await admin.validateProfile('local.legal_cases');
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.initialSchemaSnapshot, {
      contractRef: { id: 'schema-snapshot.allowlisted.v1', version: '1.0.0' },
      tables: [
        {
          name: 'labor_cases',
          columns: [
            { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 },
            { name: 'issue_type', type: 'TEXT', nullable: false, primaryKeyPosition: 0 },
            { name: 'outcome', type: 'TEXT', nullable: false, primaryKeyPosition: 0 },
            {
              name: 'compensation_amount',
              type: 'INTEGER',
              nullable: true,
              primaryKeyPosition: 0
            }
          ]
        }
      ]
    });
    assert.equal(JSON.stringify(result).includes(fixture.databasePath), false);
  } finally {
    fixture.cleanup();
  }
});

test('validates connection and whitelisted Schema while returning only safe receipts', async () => {
  let closed = 0;
  const admin = createDataSourceAdmin({
    projectRoot,
    env: configuredEnvironment(),
    sourceFactory: async () => ({
      async testConnection() {
        return { status: 'connected' };
      },
      async inspectSchema() {
        return {
          schemaFingerprint: 'a'.repeat(64),
          schema: {
            tableName: 'labor_cases',
            schemaName: 'private_schema_must_not_escape',
            dataSource: 'private_source_must_not_escape',
            columns: [
              {
                name: 'year',
                type: 'INTEGER',
                nullable: false,
                primaryKeyPosition: 1,
                providerComment: 'private_comment_must_not_escape'
              },
              { name: 'outcome', type: 'TEXT', nullable: true, primaryKeyPosition: 0 }
            ]
          }
        };
      },
      async close() {
        closed += 1;
      }
    })
  });
  const result = await admin.validateProfile('network.legal_cases.postgresql');
  assert.deepEqual(result, {
    status: 'verified',
    profileId: 'network.legal_cases.postgresql',
    engine: 'postgresql',
    connectionAttempted: true,
    connectionStatus: 'connected',
    schemaStatus: 'verified',
    schemaFingerprint: 'a'.repeat(64),
    initialSchemaSnapshot: {
      contractRef: { id: 'schema-snapshot.allowlisted.v1', version: '1.0.0' },
      tables: [
        {
          name: 'labor_cases',
          columns: [
            { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 1 },
            { name: 'outcome', type: 'TEXT', nullable: true, primaryKeyPosition: 0 }
          ]
        }
      ]
    },
    tableCount: 1,
    columnCount: 2,
    readOnly: true,
    credentialValuesExposed: false
  });
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot), true);
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot.contractRef), true);
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot.tables), true);
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot.tables[0]), true);
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot.tables[0].columns), true);
  assert.equal(Object.isFrozen(result.initialSchemaSnapshot.tables[0].columns[0]), true);
  assert.equal(JSON.stringify(result).includes('private_'), false);
  assert.equal(closed, 1);
});

test('fails closed when a Schema receipt contains unsafe or incomplete structural fields', async () => {
  const admin = createDataSourceAdmin({
    projectRoot,
    env: configuredEnvironment(),
    sourceFactory: async () => ({
      async testConnection() {
        return { status: 'connected' };
      },
      async inspectSchema() {
        return {
          schemaFingerprint: 'b'.repeat(64),
          schema: {
            tableName: 'labor_cases',
            columns: [
              {
                name: 'year',
                type: 'INTEGER\nTEST_ONLY_PG_PASSWORD_VALUE',
                nullable: false,
                primaryKeyPosition: 0
              }
            ]
          }
        };
      }
    })
  });

  const result = await admin.validateProfile('network.legal_cases.postgresql');
  assert.deepEqual(result, {
    status: 'failed',
    profileId: 'network.legal_cases.postgresql',
    engine: 'postgresql',
    connectionAttempted: true,
    connectionStatus: 'failed',
    errorCode: 'DATA_SOURCE_VALIDATION_FAILED',
    credentialValuesExposed: false
  });
  assert.equal(JSON.stringify(result).includes('TEST_ONLY_PG_PASSWORD_VALUE'), false);
});

test('redacts provider errors and rejects unknown profiles', async () => {
  const admin = createDataSourceAdmin({
    projectRoot,
    env: configuredEnvironment(),
    sourceFactory: async () => {
      throw new Error(`connection failed for ${SECRET_VALUES.join(' ')}`);
    }
  });
  const failed = await admin.validateProfile('network.legal_cases.mysql');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'DATA_SOURCE_VALIDATION_FAILED');
  const serialized = JSON.stringify(failed);
  for (const secret of SECRET_VALUES) assert.equal(serialized.includes(secret), false);

  await assert.rejects(
    admin.validateProfile('../private'),
    (error) =>
      error instanceof DataSourceAdminError && error.code === 'DATA_SOURCE_PROFILE_NOT_FOUND'
  );
});
