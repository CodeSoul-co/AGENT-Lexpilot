const { createHash } = require('node:crypto');
const { createSchemaFingerprint, validateReadOnlySqlPlan } = require('./sql-policy-guard.cjs');
const { createSchemaDrift } = require('./schema-drift.cjs');
const { createGovernedSQLiteWriteRuntime } = require('./governed-sqlite-write-runtime.cjs');
const {
  DEFAULT_QUERY_PARAMETERS: SQLITE_QUERY_PARAMETERS,
  DEFAULT_QUERY_SQL: SQLITE_QUERY_SQL,
  DEFAULT_QUERY_TEXT,
  planConstrainedText2Sql
} = require('./constrained-text2sql-planner.cjs');

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

function buildYearlyRows(sourceRows, metrics) {
  const includeMedianCompensation = metrics.includes('median_compensation');
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
      const compensations = includeMedianCompensation
        ? wins
            .map((row) => Number(row.compensation_amount))
            .filter(Number.isFinite)
        : [];
      const yearlyRow = {
        year,
        case_count: rows.length,
        employee_win_rate: Number(((wins.length / rows.length) * 100).toFixed(1))
      };
      if (includeMedianCompensation) {
        yearlyRow.median_compensation = median(compensations);
      }
      return yearlyRow;
    });
}

function buildArtifact(runId, dataSource, sourceRowCount, rows, generated) {
  const includeMedianCompensation = generated.semanticQuery.metrics.includes(
    'median_compensation'
  );
  const title = includeMedianCompensation
    ? `${generated.parameters.start_year}-${generated.parameters.end_year} 年未签劳动合同案例分析`
    : `${generated.parameters.start_year}-${generated.parameters.end_year} 年未签劳动合同案件数量与胜诉率分析`;
  const tableHeader = includeMedianCompensation
    ? '| 年份 | 案例数 | 劳动者胜诉率 | 胜诉赔偿中位数 |'
    : '| 年份 | 案例数 | 劳动者胜诉率 |';
  const tableAlignment = includeMedianCompensation
    ? '| --- | ---: | ---: | ---: |'
    : '| --- | ---: | ---: |';
  const content = [
    `# ${title}`,
    '',
    `数据源：${dataSource}（本次只读查询匹配 ${sourceRowCount} 条记录）`,
    '',
    tableHeader,
    tableAlignment,
    ...rows.map(
      (row) => {
        const base = `| ${row.year} | ${row.case_count} | ${row.employee_win_rate}%`;
        return includeMedianCompensation
          ? `${base} | ¥${row.median_compensation.toLocaleString('zh-CN')} |`
          : `${base} |`;
      }
    ),
    '',
    '> 本结果是对已配置数据源的统计输出，不构成法律意见。'
  ].join('\n');
  return Object.freeze({
    artifactId: `artifact-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`,
    type: 'analysis-document',
    fileName: generated.expectedOutput.artifactFileName,
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
  runtime = 'sql-readonly',
  details = {}
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
    trace: [safeTrace(traceType, { code })],
    ...details
  };
}

async function createV1SQLiteQueryRuntime(options = {}) {
  const dataSource = options.dataSource;
  if (dataSource?.describe?.().mode === 'read-write') {
    return createGovernedSQLiteWriteRuntime(options);
  }
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
  let snapshot = await dataSource.inspectSchema();
  const initialGeneratedPlan = planConstrainedText2Sql({
    piiRedacted: true,
    redactedText: DEFAULT_QUERY_TEXT,
    schema: snapshot.schema
  });
  if (!initialGeneratedPlan.ok) {
    throw new Error(
      `SQLite query template is incompatible with the configured Schema: ${initialGeneratedPlan.code}`
    );
  }
  const initialPolicy = validateReadOnlySqlPlan({
    sql: initialGeneratedPlan.sql,
    parameters: initialGeneratedPlan.parameters,
    schema: snapshot.schema
  });
  if (!initialPolicy.ok) {
    throw new Error(`SQLite query template is incompatible with the configured Schema: ${initialPolicy.code}`);
  }
  const descriptor = dataSource.describe();
  const runtimeName = `${descriptor.engine}-readonly`;
  const providerName =
    descriptor.engine === 'sqlite'
      ? 'hypha-adapters-local.loadSqlite'
      : `${descriptor.engine}.official-node-driver`;
  const executionMode =
    descriptor.engine === 'sqlite' ? 'worker-readonly-sqlite' : 'network-readonly-sql';

  function generatePlan(input, currentSnapshot) {
    const generated = planConstrainedText2Sql({
      piiRedacted: input.piiRedacted,
      redactedText: input.redactedText,
      schema: currentSnapshot.schema
    });
    if (!generated.ok) return { generated };
    const currentPolicy = validateReadOnlySqlPlan({
      sql: generated.sql,
      parameters: generated.parameters,
      schema: currentSnapshot.schema
    });
    return { generated, currentPolicy };
  }

  function buildPlan(currentSnapshot, generated, currentPolicy) {
    return Object.freeze({
      status: 'verified',
      templateId: generated.templateId,
      sql: generated.sql,
      parameters: generated.parameters,
      explanation: generated.explanation,
      executionSteps: generated.executionSteps,
      expectedOutput: generated.expectedOutput,
      semanticQuery: generated.semanticQuery,
      operationType: currentPolicy.operationType,
      readOnly: true,
      schemaVerified: true,
      policyVersion: currentPolicy.policyVersion,
      schemaFingerprint: currentSnapshot.schemaFingerprint,
      schemaSnapshot: currentSnapshot.schema,
      planHash: currentPolicy.planHash,
      requiresConfirmation: true
    });
  }

  function buildPlannedResult(input, currentSnapshot, generated, currentPolicy) {
    const plan = buildPlan(currentSnapshot, generated, currentPolicy);
    return {
      status: 'awaiting_confirmation',
      runtime: runtimeName,
      runId: input.runId,
      executionAttempted: false,
      executionMode,
      sqlExecutionProvider: providerName,
      schema: currentSnapshot.schema,
      plan,
      safety: {
        readOnly: true,
        writeAttempted: false,
        schemaVerified: true,
        schemaFingerprint: currentSnapshot.schemaFingerprint,
        planHash: currentPolicy.planHash,
        confirmationRequired: true,
        dataClassification: 'configured-business-data'
      },
      trace: [
        safeTrace('v1.sql.schema.loaded', {
          dataSource: descriptor.id,
          schemaFingerprint: currentSnapshot.schemaFingerprint
        }),
        safeTrace('v1.sql.query.plan.verified', {
          readOnly: true,
          planHash: currentPolicy.planHash
        }),
        safeTrace('v1.sql.query.plan.awaiting_confirmation', { requiresConfirmation: true })
      ]
    };
  }

  async function inspectCurrentSchema() {
    return dataSource.inspectSchema({ allowMissing: true });
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
      const { generated, currentPolicy } = generatePlan(input, snapshot);
      if (!generated.ok) {
        return reject(
          input,
          generated.code,
          generated.message,
          'v1.sql.query.rejected',
          runtimeName
        );
      }
      if (!currentPolicy.ok) {
        return reject(
          input,
          currentPolicy.code,
          '生成的查询未通过只读 SQL 策略。',
          'v1.sql.query.rejected',
          runtimeName
        );
      }
      return buildPlannedResult(input, snapshot, generated, currentPolicy);
    },

    async replan(input) {
      let currentSnapshot;
      try {
        currentSnapshot = await dataSource.inspectSchema();
      } catch (error) {
        const partialSnapshot = await inspectCurrentSchema();
        const drift = createSchemaDrift(
          input.expectedSchemaSnapshot ?? snapshot.schema,
          partialSnapshot.schema
        );
        return reject(
          input,
          'SCHEMA_MISMATCH',
          '当前 Schema 已不满足查询模板，无法生成新计划。请由管理员修复数据源字段配置。',
          'v1.sql.query.replan.rejected',
          runtimeName,
          { schemaDrift: drift, replanRequired: true }
        );
      }
      const { generated, currentPolicy } = generatePlan(input, currentSnapshot);
      if (!generated.ok || !currentPolicy?.ok) {
        const code = generated.ok ? currentPolicy.code : generated.code;
        return reject(
          input,
          code,
          '当前 Schema 无法生成安全的只读查询计划。',
          'v1.sql.query.replan.rejected',
          runtimeName,
          { replanRequired: true }
        );
      }
      snapshot = currentSnapshot;
      const replanned = buildPlannedResult(input, currentSnapshot, generated, currentPolicy);
      return {
        ...replanned,
        replanned: true,
        trace: [
          safeTrace('v1.sql.query.replan.completed', {
            schemaFingerprint: currentSnapshot.schemaFingerprint,
            requiresConfirmation: true
          }),
          ...replanned.trace
        ]
      };
    },

    async execute(input) {
      const initialPlanning = generatePlan(input, snapshot);
      if (!initialPlanning.generated.ok || !initialPlanning.currentPolicy?.ok) return this.plan(input);
      const expectedSchema = input.expectedSchemaSnapshot ?? snapshot.schema;
      if (
        input.expectedSchemaFingerprint !== undefined &&
        input.expectedSchemaFingerprint !== createSchemaFingerprint(expectedSchema)
      ) {
        return reject(
          input,
          'PLAN_DRIFT',
          '确认时查询计划或 Schema 指纹与已展示内容不一致，请重新生成计划。',
          'v1.sql.query.plan-drift.rejected',
          runtimeName
        );
      }
      let currentSnapshot;
      try {
        currentSnapshot = await inspectCurrentSchema();
      } catch {
        return reject(
          input,
          'SCHEMA_READ_FAILED',
          '无法重新读取当前 Schema，本次查询已停止。',
          'v1.sql.schema.read.failed',
          runtimeName,
          { replanRequired: true }
        );
      }
      const schemaDrift = createSchemaDrift(expectedSchema, currentSnapshot.schema);
      if (schemaDrift.detected) {
        return reject(
          input,
          'SCHEMA_DRIFT',
          schemaDrift.notification,
          'v1.sql.schema-drift.detected',
          runtimeName,
          { schemaDrift, replanRequired: true }
        );
      }
      const { generated, currentPolicy } = generatePlan(input, currentSnapshot);
      if (!generated.ok || !currentPolicy?.ok || input.expectedPlanHash !== currentPolicy.planHash) {
        return reject(
          input,
          'PLAN_DRIFT',
          '确认时查询计划与已展示内容不一致，请重新生成计划。',
          'v1.sql.query.plan-drift.rejected',
          runtimeName
        );
      }
      let queryResult;
      try {
        queryResult = await dataSource.executeReadOnly({
          sql: generated.sql,
          parameters: generated.parameters,
          expectedSchemaFingerprint: currentSnapshot.schemaFingerprint
        });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'SQLITE_EXECUTION_FAILED';
        if (code === 'SCHEMA_DRIFT') {
          const latestSnapshot = await inspectCurrentSchema();
          const latestDrift = createSchemaDrift(expectedSchema, latestSnapshot.schema);
          return reject(
            input,
            code,
            latestDrift.notification,
            'v1.sql.schema-drift.detected',
            runtimeName,
            { schemaDrift: latestDrift, replanRequired: true }
          );
        }
        return reject(
          input,
          code,
          `${descriptor.engine} 只读查询未完成，结果不会发布。`,
          'v1.sql.query.execution.failed',
          runtimeName
        );
      }

      const rows = buildYearlyRows(queryResult.rows, generated.semanticQuery.metrics);
      const artifact = buildArtifact(
        input.runId,
        descriptor.id,
        queryResult.rowCount,
        rows,
        generated
      );
      return {
        status: 'completed',
        runtime: runtimeName,
        runId: input.runId,
        executionAttempted: true,
        executionMode,
        sqlExecutionProvider: providerName,
        schema: currentSnapshot.schema,
        plan: buildPlan(currentSnapshot, generated, currentPolicy),
        result: {
          columns: generated.expectedOutput.columns,
          rows,
          rowCount: rows.length,
          sourceRowCount: queryResult.rowCount,
          resultGroupCount: rows.length
        },
        chart: {
          type: 'bar',
          title: `${generated.parameters.start_year}-${generated.parameters.end_year} 年劳动者胜诉率（已配置数据源）`,
          labels: rows.map((row) => String(row.year)),
          series: [{ name: '胜诉率 %', values: rows.map((row) => row.employee_win_rate) }]
        },
        artifact,
        safety: {
          readOnly: true,
          writeAttempted: false,
          schemaVerified: true,
          schemaFingerprint: currentSnapshot.schemaFingerprint,
          planHash: currentPolicy.planHash,
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
