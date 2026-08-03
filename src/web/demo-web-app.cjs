const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PRIVACY_POLICY_VERSION, V0_DOMAIN_PACK_VERSION } = require('../v0/contracts.cjs');

const MAX_JSON_BODY_BYTES = 16 * 1024;
const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
});

function securityHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, securityHeaders('application/json; charset=utf-8'));
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, { status: 'failed', error: { code, message } });
}

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      const error = new Error('请求内容过大。');
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求必须是有效 JSON。');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function parseHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const bracketMatch = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) return bracketMatch[1].toLowerCase();
  const hostname = value.replace(/:\d+$/, '');
  return hostname.toLowerCase();
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function parseSessionRoute(pathname) {
  const answerMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]{1,100})\/answers$/);
  if (answerMatch) return { type: 'answer', sessionId: answerMatch[1] };
  const confirmationMatch = pathname.match(
    /^\/api\/sessions\/([A-Za-z0-9-]{1,100})\/execution-confirmation$/
  );
  if (confirmationMatch) return { type: 'execution-confirmation', sessionId: confirmationMatch[1] };
  const replanMatch = pathname.match(
    /^\/api\/sessions\/([A-Za-z0-9-]{1,100})\/schema-replan$/
  );
  if (replanMatch) return { type: 'schema-replan', sessionId: replanMatch[1] };
  const detailMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9-]{1,100})$/);
  if (detailMatch) return { type: 'detail', sessionId: detailMatch[1] };
  return null;
}

function requireExactKeys(body, requiredKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const actual = Object.keys(body).sort();
  const expected = [...requiredKeys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateService(service) {
  const methods = ['start', 'answer', 'listHistory', 'getHistory', 'deleteSession'];
  if (!service || methods.some((method) => typeof service[method] !== 'function')) {
    throw new TypeError('service 必须实现完整的本地法律会话接口。');
  }
}

function createDemoWebHandler(options = {}) {
  const { service } = options;
  validateService(service);
  const agentDescriptor = options.agentDescriptor ?? null;
  const v1Descriptor = options.v1Descriptor ?? null;
  const staticDirectory = path.resolve(
    options.staticDirectory ?? path.join(__dirname, '..', '..', 'web')
  );

  return async function demoWebHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = parseSessionRoute(url.pathname);

      const hostname = parseHostHeader(request.headers.host);
      if (!LOCAL_HOSTNAMES.has(hostname)) {
        sendError(response, 403, 'FORBIDDEN_HOST', '仅允许通过本机回环地址访问本地 Demo 服务。');
        return;
      }

      if (
        url.pathname.startsWith('/api/') &&
        (request.method === 'POST' || request.method === 'DELETE') &&
        !isJsonContentType(request.headers['content-type'])
      ) {
        sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', '接口写入请求必须使用 application/json 内容类型。');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, {
          status: 'ok',
          demoMode: true,
          product: '法律合规审查智能助手',
          productScope: 'V0 + V1',
          domainPackVersion: V0_DOMAIN_PACK_VERSION,
          agent: agentDescriptor,
          v1: v1Descriptor
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/config') {
        sendJson(response, 200, {
          privacyPolicyVersion: PRIVACY_POLICY_VERSION,
          maxInputLength: 5000,
          maxClarificationRounds: 5,
          maxQuestionsPerRound: 2,
          supportedTaskTypes: ['legal_self_check', 'professional_data_query'],
          v1DemoDataSource: v1Descriptor?.dataSource ?? null,
          v1DemoSchema: v1Descriptor?.schema ?? null
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(response, 200, { status: 'ok', sessions: service.listHistory() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJsonBody(request);
        if (!requireExactKeys(body, ['userText', 'privacyConsent', 'privacyPolicyVersion'])) {
          sendError(response, 400, 'INVALID_REQUEST', '开始会话请求字段无效。');
          return;
        }
        sendJson(response, 200, await service.start(body));
        return;
      }

      if (route?.type === 'answer' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!requireExactKeys(body, ['userText']) || typeof body.userText !== 'string') {
          sendError(response, 400, 'INVALID_REQUEST', '补充回答请求字段无效。');
          return;
        }
        sendJson(response, 200, await service.answer(route.sessionId, body.userText));
        return;
      }

      if (route?.type === 'execution-confirmation' && request.method === 'POST') {
        if (typeof service.confirmV1Execution !== 'function') {
          sendError(response, 501, 'V1_CONFIRMATION_UNAVAILABLE', '当前服务未接入执行确认能力。');
          return;
        }
        const body = await readJsonBody(request);
        if (!requireExactKeys(body, ['confirmed']) || typeof body.confirmed !== 'boolean') {
          sendError(response, 400, 'INVALID_REQUEST', '执行确认请求字段无效。');
          return;
        }
        sendJson(
          response,
          200,
          await service.confirmV1Execution(route.sessionId, { confirmed: body.confirmed })
        );
        return;
      }

      if (route?.type === 'schema-replan' && request.method === 'POST') {
        if (typeof service.replanV1Execution !== 'function') {
          sendError(response, 501, 'V1_REPLAN_UNAVAILABLE', '当前服务未接入 Schema 重新规划能力。');
          return;
        }
        const body = await readJsonBody(request);
        if (!requireExactKeys(body, ['requested']) || body.requested !== true) {
          sendError(response, 400, 'INVALID_REQUEST', 'Schema 重新规划请求字段无效。');
          return;
        }
        sendJson(response, 200, await service.replanV1Execution(route.sessionId));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/logs') {
        if (typeof service.listV1ExecutionLogs !== 'function') {
          sendError(response, 501, 'V1_EXECUTION_LOG_UNAVAILABLE', '当前服务未接入执行日志能力。');
          return;
        }
        const statusParam = url.searchParams.get('status');
        const limitParam = url.searchParams.get('limit');
        let limit;
        if (limitParam !== null) {
          limit = Number(limitParam);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            sendError(response, 400, 'INVALID_REQUEST', '执行日志查询 limit 必须是 1 到 500 的整数。');
            return;
          }
        }
        const logs = await service.listV1ExecutionLogs({
          status: statusParam ?? undefined,
          limit
        });
        const integrity =
          typeof service.getV1ExecutionLogIntegrity === 'function'
            ? await service.getV1ExecutionLogIntegrity()
            : { status: 'unavailable' };
        sendJson(response, 200, { status: 'ok', integrity, logs });
        return;
      }

      if (route?.type === 'detail' && request.method === 'GET') {
        const history = service.getHistory(route.sessionId);
        if (!history) {
          sendError(response, 404, 'SESSION_NOT_FOUND', '没有找到对应会话。');
          return;
        }
        sendJson(response, 200, { status: 'ok', session: history });
        return;
      }

      if (route?.type === 'detail' && request.method === 'DELETE') {
        const body = await readJsonBody(request);
        if (!requireExactKeys(body, ['confirmed']) || body.confirmed !== true) {
          sendError(response, 400, 'CONFIRMATION_REQUIRED', '删除前必须明确确认。');
          return;
        }
        const result = service.deleteSession(route.sessionId, { confirmed: true });
        sendJson(response, result.deleted ? 200 : 404, result);
        return;
      }

      const staticFile = request.method === 'GET' ? STATIC_FILES[url.pathname] : undefined;
      if (staticFile) {
        const [fileName, contentType] = staticFile;
        const body = fs.readFileSync(path.join(staticDirectory, fileName));
        response.writeHead(200, securityHeaders(contentType));
        response.end(body);
        return;
      }

      sendError(response, 404, 'NOT_FOUND', '请求的本地 Demo 资源不存在。');
    } catch (error) {
      if (error?.code === 'REQUEST_BODY_TOO_LARGE') {
        sendError(response, 413, error.code, error.message);
        return;
      }
      if (error?.code === 'INVALID_JSON') {
        sendError(response, 400, error.code, error.message);
        return;
      }
      if (error?.name === 'V0ContractError' && typeof error.code === 'string') {
        sendError(response, 400, error.code, error.message);
        return;
      }
      sendError(response, 500, 'WEB_DEMO_FAILED', '本地 Demo 请求处理失败。');
    }
  };
}

function createDemoWebServer(options = {}) {
  return http.createServer(createDemoWebHandler(options));
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  createDemoWebHandler,
  createDemoWebServer
};
