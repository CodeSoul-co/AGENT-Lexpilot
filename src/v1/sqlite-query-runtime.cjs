const { createHash } = require('node:crypto');
const { validateReadOnlySqlPlan } = require('./sql-policy-guard.cjs');

const SQLITE_QUERY_SQL = [
  'SELECT year, outcome, compensation_amount',
  'FROM labor_cases',
  'WHERE year BETWEEN :start_year AND :end_year AND issue_type = :issue_type',
  'ORDER BY year;'
].join('\n');
const SQLITE_QUERY_PARAMETERS = Object.freeze({
  start_year: 2023,
  end_year: 2025,
  issue_type: '未签劳动合同'
});
const WRITE_PATTERN = /\b(?:insert|update|delete|drop|alter|truncate|create|replace|grant|revoke)\b|新增|写入|修改|删除|清空|建表/i;
const TEMPLATE_SIGNALS = Object.freeze([/未签.{0,4}劳动合同/, /胜诉率|赔偿.{0,4}(?:中位数|金额)/]);

function safeTrace(type, data) {
  return { type, data };
}

function median(values) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? Math.round((ordered[middle - 1] + ordered[middle]) / 2)
    : ordered[middle];
}

function buildYearlyRows(sourceRows) {
  const grouped = new Map();
  for (const row of sourceRows) {
    const year = Number(row.year);
    if (!Number.isInteger(year)) continue;
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year).push(row);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, rows]) => {
      const wins = rows.filter((row) => row.outcome === 'employee_win');
      const compensations = wins
        .map((row) => Number(row.compensation_amount))
        .filter(Number.isFinite);
      return {
        year,
        case_count: rows.length,
        employee_win_rate: Number(((wins.length / rows.length) * 100).toFixed(1)),
        median_compensation: median(compensations)
      };
    });
}

function buildArtifact(runId, dataSource, sourceRowCount, rows) {
  const content = [
    '# 近三年未签劳动合同案例分析',
    '',
    `数据源：${dataSource}（本次只读查询匹配 ${sourceRowCount} 条记录）`,
    '',
    '| 年份 | 案例数 | 劳动者胜诉率 | 胜诉赔偿中位数 |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.year} | ${row.case_count} | ${row.employee_win_rate}% | ¥${row.median_compensation.toLocaleString('zh-CN')} |`
    ),
    '',
    '> 本结果是对已配置数据源的统计输出，不构成法律意见。'
  ].join('\n');
  return Object.freeze({
    artifactId: `artifact-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`,
    type: 'analysis-document',
    fileName: '案例统计分析.md',
    mimeType: 'text/markdown; charset=utf-8',
    content,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex')
  });
}

function reject(
  input,
  code,
  reason,
  traceType = 'v1.sql.query.rejected',
  runtime = 'sql-readonly'
) {
  return {
    status: 'rejected',
    runtime,
    runId: input.runId,
    executionAttempted: false,
    reason,
    errorCode: code,
    safety: {
      readOnly: true,
      writeAttempted: code === 'WRITE_OPERATION_BLOCKED',
      schemaVerified: false,
      confirmationRequired: true
    },
    trace: [safeTrace(traceType, { code })]
  };
}

function inputSupported(redactedText) {
  return TEMPLATE_SIGNALS.every((pattern) => pattern.test(redactedText));
}

async function createV1SQLiteQueryRuntime(options = {}) {
  const dataSource = options.dataSource;
  if (
    !dataSource ||
    typeof dataSource.describe !== 'function' ||
    typeof dataSource.inspectSchema !== 'function' ||
    typeof dataSource.executeReadOnly !== 'function'
  ) {
    throw new TypeError('dataSource must expose describe, inspectSchema, and executeReadOnly.');
  }
  const connection = await dataSource.testConnection();
  if (connection.status !== 'connected') {
    throw new Error('The configured SQLite data source is unavailable.');
  }
  const snapshot = await dataSource.inspectSchema();
  const policy = validateReadOnlySqlPlan({
    sql: SQLITE_QUERY_SQL,
    parameters: SQLITE_QUERY_PARAMETERS,
    schema: snapshot.schema
  });
  if (!policy.ok) {
    throw new Error(`SQLite query template is incompatible with the configured Schema: ${policy.code}`);
  }
  const descriptor = dataSource.describe();
  const runtimeName = `${descriptor.engine}-readonly`;
  const providerName =
    descriptor.engine === 'sqlite'
      ? 'hypha-adapters-local.loadSqlite'
      : `${descriptor.engine}.official-node-driver`;

  function buildPlan() {
    return Object.freeze({
      status: 'verified',
      sql: SQLITE_QUERY_SQL,
      parameters: SQLITE_QUERY_PARAMETERS,
      explanation: '按年份读取未签劳动合同案例，再计算案例数、劳动者胜诉率和胜诉赔偿中位数。',
      operationType: policy.operationType,
      readOnly: true,
      schemaVerified: true,
      policyVersion: policy.policyVersion,
      schemaFingerprint: snapshot.schemaFingerprint,
      planHash: policy.planHash,
      requiresConfirmation: true
    });
  }

  return Object.freeze({
    describe() {
      return Object.freeze({
        runtime: runtimeName,
        dataSource: descriptor.id,
        schema: snapshot.schema,
        schemaMode: 'live-whitelisted-table',
        executionProvider: providerName,
        hyphaSourceModified: false,
        limits: {
          timeoutMs: descriptor.timeoutMs,
          maxRows: descriptor.maxRows,
          maxOutputBytes: descriptor.maxOutputBytes
        }
      });
    },

    plan(input) {
      if (WRITE_PATTERN.test(input.redactedText)) {
        return reject(
          input,
          'WRITE_OPERATION_BLOCKED',
          `${descriptor.engine} 模式当前只允许只读查询，写操作不会执行。`,
          'v1.sql.query.rejected',
          runtimeName
        );
      }
      if (!inputSupported(input.redactedText)) {
        return reject(
          input,
          'QUERY_TEMPLATE_NOT_SUPPORTED',
          `当前 ${descriptor.engine} 模式仅支持“近三年未签劳动合同胜诉率与赔偿中位数”查询模板。`,
          'v1.sql.query.rejected',
          runtimeName
        );
      }
      const plan = buildPlan();
      return {
        status: 'awaiting_confirmation',
        runtime: runtimeName,
        runId: input.runId,
        executionAttempted: false,
        executionMode: 'worker-readonly-sqlite',
        sqlExecutionProvider: providerName,
        schema: snapshot.schema,
        plan,
        safety: {
          readOnly: true,
          writeAttempted: false,
          schemaVerified: true,
          schemaFingerprint: snapshot.schemaFingerprint,
          planHash: policy.planHash,
          confirmationRequired: true,
          dataClassification: 'configured-business-data'
        },
        trace: [
          safeTrace('v1.sql.schema.loaded', {
            dataSource: descriptor.id,
            schemaFingerprint: snapshot.schemaFingerprint
          }),
          safeTrace('v1.sql.query.plan.verified', {
            readOnly: true,
            planHash: policy.planHash
          }),
          safeTrace('v1.sql.query.plan.awaiting_confirmation', { requiresConfirmation: true })
        ]
      };
    },

    async execute(input) {
      const planned = this.plan(input);
      if (planned.status === 'rejected') return planned;
      if (
        input.expectedPlanHash !== policy.planHash ||
        input.expectedSchemaFingerprint !== snapshot.schemaFingerprint
      ) {
        return reject(
          input,
          'PLAN_DRIFT',
          '确认时查询计划或 Schema 指纹与已展示内容不一致，请重新生成计划。',
          'v1.sql.query.plan-drift.rejected',
          runtimeName
        );
      }
      let queryResult;
      try {
        queryResult = await dataSource.executeReadOnly({
          sql: SQLITE_QUERY_SQL,
          parameters: SQLITE_QUERY_PARAMETERS,
          expectedSchemaFingerprint: snapshot.schemaFingerprint
        });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'SQLITE_EXECUTION_FAILED';
        return reject(
          input,
          code,
          code === 'SCHEMA_DRIFT'
            ? '确认后数据源 Schema 已变化，本次查询已停止，请重新生成计划。'
            : `${descriptor.engine} 只读查询未完成，结果不会发布。`,
          'v1.sql.query.execution.failed',
          runtimeName
        );
      }

      const rows = buildYearlyRows(queryResult.rows);
      const artifact = buildArtifact(input.runId, descriptor.id, queryResult.rowCount, rows);
      return {
        status: 'completed',
        runtime: runtimeName,
        runId: input.runId,
        executionAttempted: true,
        executionMode: 'worker-readonly-sqlite',
        sqlExecutionProvider: providerName,
        schema: snapshot.schema,
        plan: buildPlan(),
        result: {
          columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
          rows,
          rowCount: rows.length,
          sourceRowCount: queryResult.rowCount,
          resultGroupCount: rows.length
        },
        chart: {
          type: 'bar',
          title: '近三年劳动者胜诉率（已配置数据源）',
          labels: rows.map((row) => String(row.year)),
          series: [{ name: '胜诉率 %', values: rows.map((row) => row.employee_win_rate) }]
        },
        artifact,
        safety: {
          readOnly: true,
          writeAttempted: false,
          schemaVerified: true,
          schemaFingerprint: snapshot.schemaFingerprint,
          planHash: policy.planHash,
          dataClassification: 'configured-business-data'
        },
        providerReceipt: {
          provider: providerName,
          dataSource: descriptor.id,
          readOnly: true,
          sourceRowCount: queryResult.rowCount,
          outputBytes: queryResult.outputBytes,
          durationMs: queryResult.durationMs
        },
        trace: [
          safeTrace('v1.sql.query.confirmation.recorded', { confirmed: true }),
          safeTrace('v1.sql.query.executed', {
            rowCount: queryResult.rowCount,
            provider: providerName
          }),
          safeTrace('v1.sql.artifact.created', { artifactType: artifact.type })
        ]
      };
    }
  });
}

module.exports = {
  SQLITE_QUERY_PARAMETERS,
  SQLITE_QUERY_SQL,
  createV1SQLQueryRuntime: createV1SQLiteQueryRuntime,
  createV1SQLiteQueryRuntime
};
