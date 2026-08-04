const { loadLocalEnv } = require('./load-env.cjs');
const { createLocalLegalAgentApplication } = require('../src/v0/app-bootstrap.cjs');

loadLocalEnv();
const { createDemoWebServer } = require('../src/web/demo-web-app.cjs');

const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('LEGAL_DEMO_PORT 必须是 1024 到 65535 的整数。');
  }
  return port;
}

async function main() {
  const port = parsePort(process.env.LEGAL_DEMO_PORT);
  const {
    service,
    dataDirectory,
    agentDescriptor,
    v1Descriptor,
    sandboxCoordinator,
    sandboxDescriptor,
    dataSourceAdmin,
    accessControl,
    executionLogFilePath,
    artifactDirectory,
    close
  } = await createLocalLegalAgentApplication();
  const server = createDemoWebServer({
    service,
    agentDescriptor,
    v1Descriptor,
    sandboxCoordinator,
    sandboxDescriptor,
    dataSourceAdmin,
    accessControl
  });
  server.on('error', (error) => {
    process.stderr.write(`本地网页 Demo 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    process.stdout.write(
      [
        '法律合规审查智能助手本地网页 Demo 已启动。',
        `访问地址：http://${HOST}:${port}`,
        `加密会话目录：${dataDirectory}`,
        `V1 执行日志：${executionLogFilePath}`,
        `统一 Agent：${agentDescriptor.agentId}（${agentDescriptor.inference.mode}）`,
        `功能范围：V0 法律自检 + V1 ${v1Descriptor.runtime} 只读分析`,
        `本地角色：${accessControl.describe().role}（客户端不可切换）`,
        '按 Ctrl+C 停止。'
      ].join('\n') + '\n'
    );
  });
  process.stdout.write(`Artifact Store: ${artifactDirectory}\n`);
  const shutdown = () => {
    server.close(() => {
      Promise.resolve(close()).finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`本地网页 Demo 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_PORT, HOST, parsePort };
