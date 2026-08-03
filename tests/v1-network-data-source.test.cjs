const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  createConfiguredNetworkDataSource,
  readNetworkDataSourceManifest
} = require('../src/v1/network-data-source-config.cjs');
const {
  NetworkSQLDataSourceError,
  createNetworkSQLDataSource
} = require('../src/v1/network-sql-data-source.cjs');
const { compileNamedParameters } = require('../src/v1/network-sql-clients.cjs');
const { createV1SQLQueryRuntime } = require('../src/v1/sqlite-query-runtime.cjs');
const { auditSQLProvider } = require('../scripts/audit-sql-provider.cjs');

const projectRoot = path.resolve(__dirname, '..');
const COLUMNS = Object.freeze([
  { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 },
  { name: 'issue_type', type: 'TEXT', nullable: false, primaryKeyPosition: 0 },
  { name: 'outcome', type: 'TEXT', nullable: false, primaryKeyPosition: 0 },
  { name: 'compensation_amount', type: 'INTEGER', nullable: true, primaryKeyPosition: 0 }
]);
const SQL = [
  'SELECT year, outcome, compensation_amount',
  'FROM labor_cases',
  'WHERE year BETWEEN :start_year AND :end_year AND issue_type = :issue_type',
  'ORDER BY year;'
].join('\n');
const PARAMETERS = Object.freeze({
  start_year: 2023,
  end_year: 2025,
  issue_type: '未签劳动合同'
});

function fakeClient(overrides = {}) {
  return {
    async testConnection() {
      return true;
    },
    async inspectTable() {
      return COLUMNS.map((column) => ({ ...column }));
    },
    async executeReadOnly() {
      return [
        { year: 2024, outcome: 'employee_win', compensation_amount: 20000 },
        { year: 2025, outcome: 'employer_win', compensation_amount: 0 }
      ];
    },
    async close() {},
    ...overrides
  };
}

function createSource(engine, client = fakeClient(), overrides = {}) {
  return createNetworkSQLDataSource({
    id: `network.legal_cases.${engine}`,
    engine,
    schemaName: engine === 'postgresql' ? 'public' : undefined,
    host: '127.0.0.1',
    port: engine === 'postgresql' ? 5432 : 3306,
    database: 'lexpilot_acceptance',
    user: 'lexpilot_reader',
    password: 'local-test-secret',
    tlsMode: 'disable',
    allowedTables: ['labor_cases'],
    allowedColumns: COLUMNS.map((column) => column.name),
    clientFactory: () => client,
    ...overrides
  });
}

for (const engine of ['postgresql', 'mysql']) {
  test(`${engine} profile exposes policy but never connection credentials`, async () => {
    const source = createSource(engine);
    const descriptor = source.describe();
    assert.equal(descriptor.engine, engine);
    assert.equal(descriptor.mode, 'read-only');
    assert.equal(descriptor.credentialsRequired, true);
    assert.deepEqual(descriptor.allowedTables, ['labor_cases']);
    assert.equal(JSON.stringify(descriptor).includes('local-test-secret'), false);
    assert.equal(JSON.stringify(descriptor).includes('lexpilot_reader'), false);
    assert.equal(JSON.stringify(descriptor).includes('127.0.0.1'), false);
    assert.equal((await source.testConnection()).status, 'connected');
    await source.close();
  });

  test(`${engine} profile verifies live Schema before a parameterized read-only query`, async () => {
    let executionInput;
    const source = createSource(
      engine,
      fakeClient({
        async executeReadOnly(sql, parameters, maxRows) {
          executionInput = { sql, parameters, maxRows };
          return [{ year: 2025, outcome: 'employee_win', compensation_amount: 24000 }];
        }
      })
    );
    const snapshot = await source.inspectSchema();
    assert.equal(snapshot.schema.engine, engine);
    assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/);
    const result = await source.executeReadOnly({
      sql: SQL,
      parameters: PARAMETERS,
      expectedSchemaFingerprint: snapshot.schemaFingerprint
    });
    assert.equal(result.readOnly, true);
    assert.equal(result.rowCount, 1);
    assert.equal(result.engine, engine);
    assert.equal(executionInput.sql, SQL);
    assert.deepEqual(executionInput.parameters, PARAMETERS);
    assert.equal(executionInput.maxRows, 500);
  });
}

test('network profiles reject writes and stop on allowed-column Schema drift', async () => {
  const stable = createSource('postgresql');
  const stableSnapshot = await stable.inspectSchema();
  await assert.rejects(
    stable.executeReadOnly({
      sql: 'DELETE FROM labor_cases WHERE year = :year;',
      parameters: { year: 2025 },
      expectedSchemaFingerprint: stableSnapshot.schemaFingerprint
    }),
    (error) =>
      error instanceof NetworkSQLDataSourceError && error.code === 'SQL_NOT_SINGLE_SELECT'
  );

  let schemaCalls = 0;
  const source = createSource(
    'postgresql',
    fakeClient({
      async inspectTable() {
        schemaCalls += 1;
        return schemaCalls === 1
          ? COLUMNS.map((column) => ({ ...column }))
          : COLUMNS.map((column) =>
              column.name === 'year' ? { ...column, type: 'TEXT' } : { ...column }
            );
      }
    })
  );
  const snapshot = await source.inspectSchema();
  await assert.rejects(
    source.executeReadOnly({
      sql: SQL,
      parameters: PARAMETERS,
      expectedSchemaFingerprint: snapshot.schemaFingerprint
    }),
    (error) => error instanceof NetworkSQLDataSourceError && error.code === 'SCHEMA_DRIFT'
  );
});

test('network profiles fail closed on row limits, deadlines, and provider errors', async () => {
  const rowLimited = createSource(
    'mysql',
    fakeClient({
      async executeReadOnly() {
        return [{ year: 2023 }, { year: 2024 }];
      }
    }),
    { maxRows: 1 }
  );
  const snapshot = await rowLimited.inspectSchema();
  await assert.rejects(
    rowLimited.executeReadOnly({
      sql: SQL,
      parameters: PARAMETERS,
      expectedSchemaFingerprint: snapshot.schemaFingerprint
    }),
    (error) => error instanceof NetworkSQLDataSourceError && error.code === 'ROW_LIMIT_EXCEEDED'
  );

  const timedOut = createSource(
    'mysql',
    fakeClient({ testConnection: () => new Promise(() => {}) }),
    { timeoutMs: 1 }
  );
  await assert.rejects(
    timedOut.testConnection(),
    (error) => error instanceof NetworkSQLDataSourceError && error.code === 'QUERY_TIMEOUT'
  );

  const failed = createSource(
    'postgresql',
    fakeClient({
      async testConnection() {
        throw new Error('password=local-test-secret host=private.example');
      }
    })
  );
  await assert.rejects(failed.testConnection(), (error) => {
    assert.equal(error.code, 'CONNECTION_FAILED');
    assert.equal(error.message.includes('local-test-secret'), false);
    assert.equal(error.message.includes('private.example'), false);
    return true;
  });
});

for (const engine of ['postgresql', 'mysql']) {
  test(`${engine} public manifest stores environment references only`, () => {
    const manifestPath = path.join(
      projectRoot,
      'configs',
      'data-sources',
      `legal-cases.${engine}.json`
    );
    const manifest = readNetworkDataSourceManifest(manifestPath);
    assert.equal(manifest.engine, engine);
    assert.equal(manifest.accessMode, 'read-only');
    assert.match(manifest.connectionEnv.password, /^LEGAL_/);
    assert.equal(Object.hasOwn(manifest, 'password'), false);
    assert.equal(Object.hasOwn(manifest, 'host'), false);
  });
}

test('configured network profile resolves secrets from the environment without exposing them', () => {
  const manifestPath = path.join(
    projectRoot,
    'configs',
    'data-sources',
    'legal-cases.mysql.json'
  );
  let receivedProfile;
  const source = createConfiguredNetworkDataSource({
    manifestPath,
    env: {
      LEGAL_V1_MYSQL_HOST: '127.0.0.1',
      LEGAL_V1_MYSQL_PORT: '3306',
      LEGAL_V1_MYSQL_DATABASE: 'lexpilot_acceptance',
      LEGAL_V1_MYSQL_USER: 'lexpilot_reader',
      LEGAL_V1_MYSQL_PASSWORD: 'runtime-secret',
      LEGAL_V1_MYSQL_TLS_MODE: 'disable'
    },
    clientFactory(profile) {
      receivedProfile = profile;
      return fakeClient();
    }
  });
  assert.equal(receivedProfile.password, 'runtime-secret');
  assert.equal(JSON.stringify(source.describe()).includes('runtime-secret'), false);
  assert.equal(JSON.stringify(source.describe()).includes('lexpilot_acceptance'), false);
});

test('named parameters compile to driver placeholders without interpolating values', () => {
  const postgres = compileNamedParameters(
    'SELECT * FROM labor_cases WHERE year >= :year AND year <= :year;',
    { year: 2025 },
    'postgresql'
  );
  assert.equal(postgres.text.includes('2025'), false);
  assert.equal(postgres.text.match(/\$1/g).length, 2);
  assert.deepEqual(postgres.values, [2025]);

  const mysql = compileNamedParameters(
    'SELECT * FROM labor_cases WHERE year >= :start AND year <= :end;',
    { start: 2023, end: 2025 },
    'mysql'
  );
  assert.equal(mysql.text.includes('2023'), false);
  assert.equal(mysql.text.includes('2025'), false);
  assert.deepEqual(mysql.values, [2023, 2025]);
});

test('network data source uses the same governed plan-confirm-execute runtime contract', async () => {
  const source = createSource('mysql');
  const runtime = await createV1SQLQueryRuntime({ dataSource: source });
  const input = {
    runId: 'network-runtime-run',
    sessionId: 'network-runtime-session',
    ownerId: 'network-runtime-owner',
    piiRedacted: true,
    redactedText: '统计近三年未签劳动合同案件的胜诉率和赔偿中位数。',
    clarificationRound: 0,
    knownFacts: {}
  };
  const planned = runtime.plan(input);
  assert.equal(planned.status, 'awaiting_confirmation');
  assert.equal(planned.runtime, 'mysql-readonly');
  assert.equal(planned.sqlExecutionProvider, 'mysql.official-node-driver');
  const executed = await runtime.execute({
    ...input,
    expectedPlanHash: planned.plan.planHash,
    expectedSchemaFingerprint: planned.plan.schemaFingerprint
  });
  assert.equal(executed.status, 'completed');
  assert.equal(executed.runtime, 'mysql-readonly');
  assert.equal(executed.providerReceipt.provider, 'mysql.official-node-driver');
  assert.equal(executed.providerReceipt.readOnly, true);
});

for (const engine of ['postgresql', 'mysql']) {
  test(`${engine} acceptance command returns only reproducible non-secret evidence`, async () => {
    const prefix = engine === 'postgresql' ? 'LEGAL_V1_PG' : 'LEGAL_V1_MYSQL';
    const result = await auditSQLProvider(engine, {
      projectRoot,
      env: {
        [`${prefix}_HOST`]: '127.0.0.1',
        [`${prefix}_PORT`]: engine === 'postgresql' ? '5432' : '3306',
        [`${prefix}_DATABASE`]: 'lexpilot_acceptance',
        [`${prefix}_USER`]: 'lexpilot_reader',
        [`${prefix}_PASSWORD`]: 'acceptance-secret',
        [`${prefix}_TLS_MODE`]: 'disable'
      },
      clientFactory: () => fakeClient()
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.engine, engine);
    assert.equal(result.readOnly, true);
    assert.match(result.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result).includes('acceptance-secret'), false);
    assert.equal(JSON.stringify(result).includes('lexpilot_reader'), false);
  });
}
