const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createLocalLegalAgent } = require('../src/v0/app-bootstrap.cjs');
const { PRIVACY_POLICY_VERSION } = require('../src/v0/contracts.cjs');

function printJson(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  stdout.write(
    [
      '法律合规审查智能助手 V0 本地 Demo',
      '',
      '用法：',
      `  npm run demo:v0 -- start --policy-version ${PRIVACY_POLICY_VERSION} --consent`,
      '  npm run demo:v0 -- answer <sessionId>',
      '  npm run demo:v0 -- history',
      '  npm run demo:v0 -- show <sessionId>',
      '  npm run demo:v0 -- delete <sessionId> --confirm',
      '  npm run demo:v0 -- cleanup',
      '',
      'start 和 answer 的法律描述从标准输入读取，不接受命令行文本参数。'
    ].join('\n') + '\n'
  );
}

async function readUserText(prompt) {
  if (stdin.isTTY) {
    const interfaceInstance = readline.createInterface({ input: stdin, output: stdout });
    try {
      return await interfaceInstance.question(prompt);
    } finally {
      interfaceInstance.close();
    }
  }
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim();
}

function requireArguments(args, expectedLength, usage) {
  if (args.length !== expectedLength) {
    throw new Error(`Invalid arguments. Expected: ${usage}`);
  }
}

function validateCommand(command, args) {
  switch (command) {
    case 'start':
      if (
        (args.length !== 2 && args.length !== 3) ||
        args[0] !== '--policy-version' ||
        args[1] !== PRIVACY_POLICY_VERSION ||
        (args.length === 3 && args[2] !== '--consent')
      ) {
        throw new Error(
          `start requires --policy-version ${PRIVACY_POLICY_VERSION} and optionally --consent; provide legal text through stdin.`
        );
      }
      return;
    case 'answer':
      requireArguments(args, 1, 'answer <sessionId>');
      return;
    case 'history':
      requireArguments(args, 0, 'history');
      return;
    case 'show':
      requireArguments(args, 1, 'show <sessionId>');
      return;
    case 'delete':
      requireArguments(args, 2, 'delete <sessionId> --confirm');
      if (args[1] !== '--confirm') {
        throw new Error('delete requires explicit user confirmation through --confirm.');
      }
      return;
    case 'cleanup':
      requireArguments(args, 0, 'cleanup');
      return;
    default:
      throw new Error(`Unknown demo command: ${command}`);
  }
}

async function run(command, args) {
  if (!command || command === 'help' || command === '--help') {
    printUsage();
    return;
  }
  validateCommand(command, args);
  const { service } = createLocalLegalAgent();
  switch (command) {
    case 'start': {
      const consent = args.includes('--consent');
      const userText = await readUserText('请描述需要自查的情况：');
      printJson(
        service.start({
          userText,
          privacyConsent: consent,
          privacyPolicyVersion: args[1]
        })
      );
      return;
    }
    case 'answer': {
      const userText = await readUserText('请补充回答：');
      printJson(service.answer(args[0], userText));
      return;
    }
    case 'history':
      printJson(service.listHistory());
      return;
    case 'show': {
      const history = service.getHistory(args[0]);
      printJson(history ?? { status: 'not_found', sessionId: args[0] });
      return;
    }
    case 'delete': {
      printJson(service.deleteSession(args[0], { confirmed: true }));
      return;
    }
    case 'cleanup':
      printJson(await service.cleanupInactiveSessionsWithArtifacts());
      return;
  }
}

const [command, ...args] = process.argv.slice(2);
run(command, args).catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      status: 'failed',
      error: { code: 'LOCAL_DEMO_FAILED', message: error.message }
    })}\n`
  );
  process.exitCode = 1;
});
