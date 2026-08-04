const { createHash } = require('node:crypto');
const { validateReadOnlySqlPlan } = require('./sql-policy-guard.cjs');
const { buildExecutionEvidence } = require('./analysis-artifact-content.cjs');

const DEMO_SCHEMA = Object.freeze({
  dataSource: 'demo.labor_cases',
  tableName: 'labor_cases',
  displayName: '匿名劳动争议案例库',
  description: '仅用于本地产品演示的匿名合成劳动争议案例统计表',
  columns: Object.freeze([
    { name: 'case_id', type: 'TEXT', description: '匿名案例编号' },
    { name: 'year', type: 'INTEGER', description: '结案年份' },
    { name: 'city', type: 'TEXT', description: '案例所在城市' },
    { name: 'issue_type', type: 'TEXT', description: '争议类型' },
    { name: 'outcome', type: 'TEXT', description: 'employee_win 或 employer_win' },
    { name: 'compensation_amount', type: 'INTEGER', description: '演示赔偿金额（元）' }
  ])
});

const DEMO_CITIES = Object.freeze(['北京', '上海', '广州', '深圳', '杭州', '成都']);
const DEMO_YEAR_CONFIG = Object.freeze([
  Object.freeze({ year: 2023, matchedCount: 168, employeeWinCount: 104, otherCount: 16, compensationBase: 18000 }),
  Object.freeze({ year: 2024, matchedCount: 224, employeeWinCount: 148, otherCount: 16, compensationBase: 22000 }),
  Object.freeze({ year: 2025, matchedCount: 280, employeeWinCount: 194, otherCount: 16, compensationBase: 26000 })
]);

function createDemoCases() {
  const cases = [];
  for (const config of DEMO_YEAR_CONFIG) {
    for (let index = 0; index < config.matchedCount; index += 1) {
      const employeeWon = index < config.employeeWinCount;
      cases.push(
        Object.freeze({
          case_id: `LC-${config.year}-${String(index + 1).padStart(4, '0')}`,
          year: config.year,
          city: DEMO_CITIES[index % DEMO_CITIES.length],
          issue_type: '未签劳动合同',
          outcome: employeeWon ? 'employee_win' : 'employer_win',
          compensation_amount: employeeWon
            ? config.compensationBase + ((index * 7) % 29) * 1000
            : 0
        })
      );
    }
    for (let index = 0; index < config.otherCount; index += 1) {
      cases.push(
        Object.freeze({
          case_id: `OT-${config.year}-${String(index + 1).padStart(3, '0')}`,
          year: config.year,
          city: DEMO_CITIES[(index + 2) % DEMO_CITIES.length],
          issue_type: '解除劳动合同',
          outcome: index % 2 === 0 ? 'employee_win' : 'employer_win',
          compensation_amount: index % 2 === 0 ? 30000 + index * 1500 : 0
        })
      );
    }
  }
  return Object.freeze(cases);
}

const DEMO_CASES = createDemoCases();

const WRITE_PATTERN = /\b(?:insert|update|delete|drop|alter|truncate|create|replace|grant|revoke)\b|新增|写入|修改|删除|清空|建表/i;

function median(values) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? Math.round((ordered[middle - 1] + ordered[middle]) / 2)
    : ordered[middle];
}

function safeTrace(type, data) {
  return { type, data };
}

function buildYearlyRows() {
  return [2023, 2024, 2025].map((year) => {
    const cases = DEMO_CASES.filter(
      (item) => item.year === year && item.issue_type === '未签劳动合同'
    );
    const wins = cases.filter((item) => item.outcome === 'employee_win');
    return {
      year,
      case_count: cases.length,
      employee_win_rate: Number(((wins.length / cases.length) * 100).toFixed(1)),
      median_compensation: median(wins.map((item) => item.compensation_amount))
    };
  });
}

function buildArtifact(runId, rows, executionTimeMs) {
  const matchedCaseCount = rows.reduce((total, row) => total + row.case_count, 0);
  const content = [
    '# 近三年未签劳动合同案例演示分析',
    '',
    `数据源：${DEMO_SCHEMA.displayName}（${DEMO_CASES.length} 条匿名合成演示案例）`,
    `本次查询匹配：${matchedCaseCount} 条，按 ${rows.length} 个年度汇总。`,
    '',
    ...buildExecutionEvidence({ sql: DEMO_QUERY_SQL, executionTimeMs, rows }),
    '',
    '## 查询结果',
    '',
    '| 年份 | 案例数 | 劳动者胜诉率 | 胜诉赔偿中位数 |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.year} | ${row.case_count} | ${row.employee_win_rate}% | ¥${row.median_compensation.toLocaleString('zh-CN')} |`
    ),
    '',
    '> 本结果仅用于产品功能演示，不代表真实案例库统计或法律意见。'
  ].join('\n');
  return {
    artifactId: `artifact-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`,
    type: 'analysis-document',
    fileName: '案例统计分析.md',
    mimeType: 'text/markdown; charset=utf-8',
    executionTimeMs,
    content,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex')
  };
}

const DEMO_QUERY_SQL = [
  'SELECT year, COUNT(*) AS case_count,',
  "  ROUND(100.0 * SUM(CASE WHEN outcome = 'employee_win' THEN 1 ELSE 0 END) / COUNT(*), 1) AS employee_win_rate,",
  "  MEDIAN(CASE WHEN outcome = 'employee_win' THEN compensation_amount END) AS median_compensation",
  'FROM labor_cases',
  'WHERE year BETWEEN :start_year AND :end_year AND issue_type = :issue_type',
  'GROUP BY year ORDER BY year;'
].join('\n');

const DEMO_QUERY_PARAMETERS = Object.freeze({
  start_year: 2023,
  end_year: 2025,
  issue_type: '未签劳动合同'
});

function rejectWriteOperation(input) {
  if (!WRITE_PATTERN.test(input.redactedText)) {
    return null;
  }
  return {
    status: 'rejected',
    runtime: 'business-demo-readonly',
    runId: input.runId,
    executionAttempted: false,
    reason: '专业数据分析只开放固定 Schema 的只读查询，写操作不会执行。',
    safety: { readOnly: true, writeAttempted: true, confirmationRequired: true },
    trace: [safeTrace('v1.query.rejected', { reason: 'write_operation' })]
  };
}

function buildDemoQueryPlan(requiresConfirmation, policy) {
  return {
    status: 'verified',
    sql: DEMO_QUERY_SQL,
    parameters: DEMO_QUERY_PARAMETERS,
    explanation: '按年份聚合未签劳动合同案例，计算案例数、劳动者胜诉率和胜诉赔偿中位数。',
    operationType: policy.operationType,
    readOnly: true,
    schemaVerified: true,
    policyVersion: policy.policyVersion,
    schemaFingerprint: policy.schemaFingerprint,
    planHash: policy.planHash,
    requiresConfirmation
  };
}

function buildCompletedResult(
  input,
  { requiresConfirmation, confirmationTrace, schema, policy, executionTimeMs }
) {
  const rows = buildYearlyRows();
  const matchedCaseCount = rows.reduce((total, row) => total + row.case_count, 0);

  return {
    status: 'completed',
    runtime: 'business-demo-readonly',
    runId: input.runId,
    executionAttempted: true,
    executionMode: 'fixed-schema-controlled-evaluator',
    sqlExecutionProvider: 'not_available_in_current_hypha',
    schema,
    plan: buildDemoQueryPlan(requiresConfirmation, policy),
    result: {
      columns: ['year', 'case_count', 'employee_win_rate', 'median_compensation'],
      rows,
      rowCount: rows.length,
      sourceCaseCount: DEMO_CASES.length,
      matchedCaseCount,
      resultGroupCount: rows.length
    },
    chart: {
      type: 'bar',
      title: '近三年劳动者胜诉率（演示数据）',
      labels: rows.map((row) => String(row.year)),
      series: [{ name: '胜诉率 %', values: rows.map((row) => row.employee_win_rate) }]
    },
    artifact: buildArtifact(input.runId, rows, executionTimeMs),
    safety: {
      readOnly: true,
      writeAttempted: false,
      schemaVerified: true,
      schemaFingerprint: policy.schemaFingerprint,
      planHash: policy.planHash,
      dataClassification: 'anonymous-synthetic-demo-data'
    },
    trace: [
      safeTrace('v1.schema.loaded', {
        dataSource: schema.dataSource,
        schemaFingerprint: policy.schemaFingerprint
      }),
      safeTrace('v1.query.plan.verified', {
        readOnly: true,
        schemaVerified: true,
        planHash: policy.planHash
      }),
      ...confirmationTrace,
      safeTrace('v1.query.executed', {
        rowCount: rows.length,
        matchedCaseCount,
        mode: 'controlled_demo'
      }),
      safeTrace('v1.artifact.created', { artifactType: 'analysis-document' })
    ]
  };
}

function createV1DemoQueryRuntime(options = {}) {
  const schemaProvider = options.schemaProvider ?? (() => DEMO_SCHEMA);
  const executionTimeMs = options.executionTimeMs ?? 0;
  if (typeof schemaProvider !== 'function') {
    throw new TypeError('schemaProvider must be a function.');
  }
  if (!Number.isSafeInteger(executionTimeMs) || executionTimeMs < 0) {
    throw new TypeError('executionTimeMs must be a non-negative safe integer.');
  }

  function currentPlan(requiresConfirmation) {
    const schema = schemaProvider();
    const policy = validateReadOnlySqlPlan({
      sql: DEMO_QUERY_SQL,
      parameters: DEMO_QUERY_PARAMETERS,
      schema
    });
    if (!policy.ok) {
      return { schema, policy };
    }
    return { schema, policy, plan: buildDemoQueryPlan(requiresConfirmation, policy) };
  }

  function rejectPolicy(input, policy) {
    return {
      status: 'rejected',
      runtime: 'business-demo-readonly',
      runId: input.runId,
      executionAttempted: false,
      reason: policy.message,
      safety: { readOnly: true, writeAttempted: false, schemaVerified: false },
      trace: [safeTrace('v1.query.policy.rejected', { code: policy.code })]
    };
  }

  function rejectDrift(input, policy) {
    return {
      status: 'rejected',
      runtime: 'business-demo-readonly',
      runId: input.runId,
      executionAttempted: false,
      reason: '确认时查询计划或数据源 Schema 已发生变化，请重新生成并确认执行计划。',
      safety: {
        readOnly: true,
        writeAttempted: false,
        schemaVerified: true,
        confirmationRequired: true
      },
      trace: [safeTrace('v1.query.plan-drift.rejected', { reason: 'plan_or_schema_mismatch' })]
    };
  }

  return Object.freeze({
    describe() {
      const schema = schemaProvider();
      return {
        runtime: 'business-demo-readonly',
        dataSource: schema.dataSource,
        schema,
        schemaMode: 'fixed-demo-schema',
        executionProvider: 'local-controlled-evaluator',
        hyphaSqlExecutionAvailable: false
      };
    },

    plan(input) {
      const rejected = rejectWriteOperation(input);
      if (rejected) {
        return rejected;
      }
      const { schema, policy, plan } = currentPlan(true);
      if (!policy.ok) {
        return rejectPolicy(input, policy);
      }
      return {
        status: 'awaiting_confirmation',
        runtime: 'business-demo-readonly',
        runId: input.runId,
        executionAttempted: false,
        executionMode: 'fixed-schema-controlled-evaluator',
        sqlExecutionProvider: 'not_available_in_current_hypha',
        schema,
        plan,
        safety: {
          readOnly: true,
          writeAttempted: false,
          schemaVerified: true,
          schemaFingerprint: policy.schemaFingerprint,
          planHash: policy.planHash,
          confirmationRequired: true,
          dataClassification: 'anonymous-synthetic-demo-data'
        },
        trace: [
          safeTrace('v1.schema.loaded', {
            dataSource: schema.dataSource,
            schemaFingerprint: policy.schemaFingerprint
          }),
          safeTrace('v1.query.plan.verified', {
            readOnly: true,
            schemaVerified: true,
            planHash: policy.planHash
          }),
          safeTrace('v1.query.plan.awaiting_confirmation', { requiresConfirmation: true })
        ]
      };
    },

    execute(input) {
      const rejected = rejectWriteOperation(input);
      if (rejected) {
        return rejected;
      }
      const { schema, policy } = currentPlan(true);
      if (!policy.ok) {
        return rejectPolicy(input, policy);
      }
      if (
        input.expectedPlanHash !== policy.planHash ||
        input.expectedSchemaFingerprint !== policy.schemaFingerprint
      ) {
        return rejectDrift(input, policy);
      }
      return buildCompletedResult(input, {
        requiresConfirmation: true,
        confirmationTrace: [safeTrace('v1.query.confirmation.recorded', { confirmed: true })],
        schema,
        policy,
        executionTimeMs
      });
    },

    async run(input) {
      const rejected = rejectWriteOperation(input);
      if (rejected) {
        return rejected;
      }
      const { schema, policy } = currentPlan(false);
      if (!policy.ok) {
        return rejectPolicy(input, policy);
      }
      return buildCompletedResult(input, {
        requiresConfirmation: false,
        confirmationTrace: [],
        schema,
        policy,
        executionTimeMs
      });
    }
  });
}

module.exports = { DEMO_CASES, DEMO_SCHEMA, createV1DemoQueryRuntime };
