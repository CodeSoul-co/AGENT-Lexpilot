const { createSchemaFingerprint } = require('./sql-policy-guard.cjs');

const COLUMN_PROPERTIES = Object.freeze(['type', 'nullable', 'primaryKeyPosition']);

function normalizeColumns(schema) {
  if (!Array.isArray(schema?.columns)) return new Map();
  return new Map(
    schema.columns
      .filter((column) => column && typeof column.name === 'string')
      .map((column) => [column.name, column])
  );
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function createSchemaDrift(previousSchema, currentSchema) {
  if (!previousSchema || typeof previousSchema !== 'object') {
    throw new TypeError('previousSchema must be an object.');
  }
  if (!currentSchema || typeof currentSchema !== 'object') {
    throw new TypeError('currentSchema must be an object.');
  }

  const previousFingerprint = createSchemaFingerprint(previousSchema);
  const currentFingerprint = createSchemaFingerprint(currentSchema);
  const tableName = String(previousSchema.tableName ?? currentSchema.tableName ?? 'unknown_table');
  const previousTableAvailable = previousSchema.tableAvailable !== false;
  const currentTableAvailable = currentSchema.tableAvailable !== false;
  const previousColumns = normalizeColumns(previousSchema);
  const currentColumns = normalizeColumns(currentSchema);
  const addedColumns = sorted(
    [...currentColumns.keys()].filter((name) => !previousColumns.has(name))
  );
  const removedColumns = sorted(
    [...previousColumns.keys()].filter((name) => !currentColumns.has(name))
  );
  const changedColumns = sorted(
    [...previousColumns.keys()].filter((name) => currentColumns.has(name))
  )
    .map((name) => {
      const before = previousColumns.get(name);
      const after = currentColumns.get(name);
      const changes = {};
      for (const property of COLUMN_PROPERTIES) {
        if (before[property] !== after[property]) {
          changes[property] = { before: before[property], after: after[property] };
        }
      }
      return Object.keys(changes).length === 0 ? null : { name, changes };
    })
    .filter(Boolean);

  const tableStatus = !previousTableAvailable && currentTableAvailable
    ? 'added'
    : previousTableAvailable && !currentTableAvailable
      ? 'removed'
      : addedColumns.length > 0 || removedColumns.length > 0 || changedColumns.length > 0
        ? 'changed'
        : 'unchanged';
  const affectedFields = sorted(
    new Set([
      ...addedColumns.map((name) => `${tableName}.${name}`),
      ...removedColumns.map((name) => `${tableName}.${name}`),
      ...changedColumns.map((column) => `${tableName}.${column.name}`)
    ])
  );
  const changed = previousFingerprint !== currentFingerprint;

  return Object.freeze({
    detected: changed,
    code: changed ? 'SCHEMA_DRIFT' : null,
    previousFingerprint,
    currentFingerprint,
    summary: Object.freeze({
      addedTables: tableStatus === 'added' ? 1 : 0,
      removedTables: tableStatus === 'removed' ? 1 : 0,
      changedTables: tableStatus === 'changed' ? 1 : 0,
      addedColumns: addedColumns.length,
      removedColumns: removedColumns.length,
      changedColumns: changedColumns.length
    }),
    tables: Object.freeze([
      Object.freeze({
        name: tableName,
        status: tableStatus,
        addedColumns: Object.freeze(addedColumns),
        removedColumns: Object.freeze(removedColumns),
        changedColumns: Object.freeze(
          changedColumns.map((column) => Object.freeze({
            name: column.name,
            changes: Object.freeze(column.changes)
          }))
        )
      })
    ]),
    affectedTables: Object.freeze(tableStatus === 'unchanged' ? [] : [tableName]),
    affectedFields: Object.freeze(affectedFields),
    replanRequired: changed,
    notification: changed
      ? `检测到数据源 Schema 已变化，旧查询计划已停止。受影响：${tableName}${affectedFields.length > 0 ? `（${affectedFields.join('、')}）` : ''}。请重新生成并确认计划。`
      : '数据源 Schema 与计划快照一致。'
  });
}

module.exports = { createSchemaDrift };
