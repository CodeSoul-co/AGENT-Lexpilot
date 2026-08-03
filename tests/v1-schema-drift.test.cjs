const assert = require('node:assert/strict');
const test = require('node:test');
const { createSchemaDrift } = require('../src/v1/schema-drift.cjs');

function schema(columns, overrides = {}) {
  return {
    dataSource: 'source-1',
    engine: 'sqlite',
    tableName: 'labor_cases',
    columns,
    ...overrides
  };
}

test('builds a deterministic allowlisted Schema difference and affected-field notice', () => {
  const before = schema([
    { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 },
    { name: 'outcome', type: 'TEXT', nullable: false, primaryKeyPosition: 0 },
    { name: 'amount', type: 'INTEGER', nullable: true, primaryKeyPosition: 0 }
  ]);
  const after = schema([
    { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 },
    { name: 'amount', type: 'TEXT', nullable: true, primaryKeyPosition: 0 },
    { name: 'court', type: 'TEXT', nullable: true, primaryKeyPosition: 0 }
  ]);

  const drift = createSchemaDrift(before, after);
  assert.equal(drift.detected, true);
  assert.equal(drift.replanRequired, true);
  assert.deepEqual(drift.summary, {
    addedTables: 0,
    removedTables: 0,
    changedTables: 1,
    addedColumns: 1,
    removedColumns: 1,
    changedColumns: 1
  });
  assert.deepEqual(drift.tables[0].addedColumns, ['court']);
  assert.deepEqual(drift.tables[0].removedColumns, ['outcome']);
  assert.deepEqual(drift.tables[0].changedColumns, [
    { name: 'amount', changes: { type: { before: 'INTEGER', after: 'TEXT' } } }
  ]);
  assert.deepEqual(drift.affectedFields, [
    'labor_cases.amount',
    'labor_cases.court',
    'labor_cases.outcome'
  ]);
  assert.match(drift.notification, /旧查询计划已停止/);
});

test('reports an unavailable allowlisted table without exposing unrelated Schema', () => {
  const before = schema([
    { name: 'year', type: 'INTEGER', nullable: false, primaryKeyPosition: 0 }
  ]);
  const after = schema([], { tableAvailable: false });
  const drift = createSchemaDrift(before, after);
  assert.equal(drift.tables[0].status, 'removed');
  assert.deepEqual(drift.affectedTables, ['labor_cases']);
  assert.deepEqual(drift.affectedFields, ['labor_cases.year']);
  assert.equal(JSON.stringify(drift).includes('password'), false);
});
