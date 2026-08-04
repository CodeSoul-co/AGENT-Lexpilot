const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { loadHyphaCore, loadHyphaTools } = require('../../scripts/hypha-paths.cjs');
const { buildSandboxEnvironment, requireSandboxRequest } = require('./sandbox-execution-policy.cjs');

const TOOL_ID = 'lexpilot.docker.execute-script';
const TOOL_GOVERNANCE_TIMEOUT_MS = 45_000;
const REQUIRED_CAPABILITIES = Object.freeze([
  'processIsolation',
  'filesystemIsolation',
  'networkIsolation',
  'cpuLimits',
  'memoryLimits',
  'cancellation',
  'processTreeKill',
  'imageDigestPinning'
]);

function safeId(prefix, value) {
  return `${prefix}.${String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80)}`;
}

function requireId(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${fieldName} must be a non-empty string containing no NUL bytes.`);
  }
  return value;
}

function safeProviderReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return undefined;
  return {
    id: receipt.id,
    providerId: receipt.providerId,
    status: receipt.status,
    receiptHash: receipt.receiptHash,
    issuedAt: receipt.issuedAt,
    metadata: receipt.metadata
  };
}

function safeProviderFailure(error) {
  const normalized = error?.normalizedError;
  const cleanup = normalized?.details?.cleanup;
  if (!normalized || typeof normalized.code !== 'string' || !cleanup || typeof cleanup !== 'object') {
    return undefined;
  }
  const containerAbsent = cleanup.containerAbsent === true;
  return {
    status: 'failed',
    errorCode: normalized.code,
    generatedArtifactRefs: [],
    cleanupEvidence: {
      executionContainerAbsent: containerAbsent,
      processTreeTerminationVerified: cleanup.complete === true && containerAbsent
    },
    resourceEvidence: { accountingMode: 'unavailable' }
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safePlan(request, environment, invocationId) {
  const inputFiles = request.inputFiles.map((file) => ({
    path: file.path,
    sizeBytes: Buffer.from(file.contentBase64, 'base64').byteLength,
    contentSha256: file.contentSha256
  }));
  const plan = {
    invocationId,
    language: request.language,
    executable: request.language === 'python' ? 'python3' : '/bin/sh',
    scriptSha256: sha256(request.script),
    scriptBytes: Buffer.byteLength(request.script, 'utf8'),
    inputFiles,
    inputFileCount: inputFiles.length,
    inputBytes: inputFiles.reduce((total, file) => total + file.sizeBytes, 0),
    requiresConfirmation: true,
    policy: {
      cpuCores: environment.resources.cpuCores,
      memoryMb: environment.resources.memoryMb,
      timeoutMs: environment.defaultTimeoutMs,
      network: environment.network.mode,
      rootFilesystem: environment.filesystem.rootFilesystem,
      reuse: environment.lifecycle.reuse
    }
  };
  return Object.freeze({
    ...plan,
    planHash: sha256(JSON.stringify(plan))
  });
}

async function createSandboxExecutionRuntime(options = {}) {
  if (typeof options.providerFactory !== 'function') {
    throw new TypeError('providerFactory(workspacePath) is required.');
  }
  if (!options.artifactRepository || typeof options.artifactRepository.storeGeneratedFiles !== 'function') {
    throw new TypeError('artifactRepository.storeGeneratedFiles(input) is required.');
  }
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim().length === 0) {
    throw new TypeError('workspaceRoot is required.');
  }
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const { InMemoryEventStore, validateExecutionEnvironmentSpec } = loadHyphaCore();
  const environment = validateExecutionEnvironmentSpec(buildSandboxEnvironment(options));
  if (options.expectedExecutionEnvironment !== undefined) {
    const expectedEnvironment = validateExecutionEnvironmentSpec(
      options.expectedExecutionEnvironment
    );
    if (!isDeepStrictEqual(environment, expectedEnvironment)) {
      throw new Error('Versioned Execution Profile has drifted from the Sandbox runtime policy.');
    }
  }
  const { GovernedToolRunner, ToolRegistry } = loadHyphaTools();
  const events = options.eventStore ?? new InMemoryEventStore();
  const registry = new ToolRegistry();
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout;
  const clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout;

  async function executeApproved(input) {
    const request = requireSandboxRequest({
      language: input.language,
      script: input.script,
      inputFiles: input.inputFiles
    });
    requireId(input.runId, 'runId');
    requireId(input.sessionId, 'sessionId');
    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(workspaceRoot, 0o700);
    const workspacePath = fs.mkdtempSync(path.join(workspaceRoot, 'run-'));
    // The parent remains private to the application. The one-run bind mount is
    // writable by the container's fixed non-root UID and is deleted in finally.
    fs.chmodSync(workspacePath, 0o777);
    for (const file of request.inputFiles) {
      const inputPath = path.join(workspacePath, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(inputPath), { recursive: true, mode: 0o777 });
      fs.chmodSync(path.dirname(inputPath), 0o777);
      fs.writeFileSync(inputPath, Buffer.from(file.contentBase64, 'base64'), { mode: 0o444 });
    }
    const scriptName = request.language === 'python' ? 'task.py' : 'task.sh';
    const scriptPath = path.join(workspacePath, scriptName);
    fs.writeFileSync(scriptPath, request.script, { encoding: 'utf8', mode: 0o444 });
    let provider;
    const principal = {
      principalId: 'principal.lexpilot.sandbox',
      type: 'user',
      userId: 'user.lexpilot.sandbox',
      permissionScopes: ['execution.run']
    };
    let sandbox;
    let operationError;
    try {
      provider = await options.providerFactory(workspacePath);
      const health = await provider.health();
      if (health.status !== 'healthy') throw new Error('Docker Sandbox Provider is unavailable.');
      const capabilities = await provider.capabilities();
      if (REQUIRED_CAPABILITIES.some((name) => capabilities[name] !== true)) {
        throw new Error('Docker Sandbox Provider lacks required isolation capabilities.');
      }
      sandbox = await provider.create({
        operationId: safeId('operation.create', input.runId),
        principal,
        environment,
        environmentRevision: environment.revision,
        userId: principal.userId,
        workspaceId: safeId('workspace', input.runId),
        sessionId: input.sessionId,
        runId: input.runId
      });
      sandbox = await provider.start({
        operationId: safeId('operation.start', input.runId),
        sandboxId: sandbox.id,
        principal,
        expectedRevision: sandbox.revision
      });
      const executionId = safeId('execution.lexpilot', input.runId);
      let deadlineExceeded = false;
      let cancellation;
      const execution = provider.execute({
        executionId,
        operationId: safeId('operation.execute', input.runId),
        principal,
        userId: principal.userId,
        workspaceId: safeId('workspace', input.runId),
        sessionId: input.sessionId,
        runId: input.runId,
        sandboxId: sandbox.id,
        environmentRef: { id: environment.id, version: environment.version, revision: environment.revision },
        executable: request.language === 'python' ? 'python3' : '/bin/sh',
        args: [`/workspace/${scriptName}`],
        timeoutMs: environment.defaultTimeoutMs,
        captureArtifacts: true,
        captureFileMutations: true
      });
      const deadline = scheduleTimeout(() => {
        deadlineExceeded = true;
        cancellation = Promise.resolve(provider.cancel({
          operationId: safeId('operation.cancel', input.runId),
          executionId,
          principal,
          expectedRevision: sandbox.revision,
          reason: 'LexPilot Sandbox execution deadline exceeded.',
          gracePeriodMs: 0
        })).then(
          () => undefined,
          () => undefined
        );
      }, environment.defaultTimeoutMs);
      let result;
      try {
        result = await execution;
      } finally {
        clearScheduledTimeout(deadline);
        await cancellation;
      }
      if (result.metadata?.cleanup?.complete !== true || result.metadata.cleanup.containerAbsent !== true) {
        throw new Error('Docker execution container cleanup could not be verified.');
      }
      let generatedArtifactRefs;
      try {
        generatedArtifactRefs = await options.artifactRepository.storeGeneratedFiles({
          workspacePath,
          executionId,
          runId: input.runId,
          changedFiles: result.changedFiles ?? []
        });
      } catch {
        return {
          status: 'failed',
          exitCode: result.exitCode,
          errorCode: 'ARTIFACT_PERSISTENCE_FAILED',
          generatedArtifactRefs: result.generatedArtifactRefs ?? [],
          providerReceipt: safeProviderReceipt(result.externalReceipt),
          cleanupEvidence: {
            executionContainerAbsent: true,
            processTreeTerminationVerified: result.metadata?.processTreeTerminationVerified === true
          },
          resourceEvidence: result.metadata?.resourceSnapshot
            ? {
                cpuPercent: result.metadata.resourceSnapshot.cpuPercent,
                memoryUsageBytes: result.metadata.resourceSnapshot.memoryUsageBytes,
                memoryLimitBytes: result.metadata.resourceSnapshot.memoryLimitBytes,
                processCount: result.metadata.resourceSnapshot.processCount
              }
            : { accountingMode: result.metadata?.accountingMode ?? 'unavailable' }
        };
      }
      return {
        status: deadlineExceeded ? 'timed_out' : result.status,
        exitCode: deadlineExceeded ? null : result.exitCode,
        errorCode: deadlineExceeded ? 'EXECUTION_TIMEOUT' : result.error?.code,
        stdoutArtifactRef: result.stdoutArtifactRef,
        stderrArtifactRef: result.stderrArtifactRef,
        generatedArtifactRefs: [
          ...(result.generatedArtifactRefs ?? []),
          ...generatedArtifactRefs
        ],
        providerReceipt: safeProviderReceipt(result.externalReceipt),
        cleanupEvidence: {
          executionContainerAbsent: true,
          processTreeTerminationVerified: result.metadata?.processTreeTerminationVerified === true
        },
        resourceEvidence: result.metadata?.resourceSnapshot
          ? {
              cpuPercent: result.metadata.resourceSnapshot.cpuPercent,
              memoryUsageBytes: result.metadata.resourceSnapshot.memoryUsageBytes,
              memoryLimitBytes: result.metadata.resourceSnapshot.memoryLimitBytes,
              processCount: result.metadata.resourceSnapshot.processCount
            }
          : { accountingMode: result.metadata?.accountingMode ?? 'unavailable' }
      };
    } catch (error) {
      const providerFailure = safeProviderFailure(error);
      if (providerFailure) return providerFailure;
      operationError = error;
      throw error;
    } finally {
      let cleanupError;
      try {
        if (provider && sandbox) {
          const current = await provider.status({ sandboxId: sandbox.id, principal });
          if (current && !['terminated', 'cleaned'].includes(current.status)) {
            await provider.terminate({
              operationId: safeId('operation.terminate', input.runId),
              sandboxId: current.id,
              principal,
              expectedRevision: current.revision,
              reason: 'LexPilot execution completed.'
            });
          }
          const terminated = await provider.status({ sandboxId: sandbox.id, principal });
          if (terminated && terminated.status !== 'cleaned') {
            await provider.cleanup({
              operationId: safeId('operation.cleanup', input.runId),
              sandboxId: terminated.id,
              principal,
              expectedRevision: terminated.revision
            });
          }
        }
      } catch (error) {
        cleanupError = error;
      }
      try {
        await provider?.close?.();
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        throw new Error(
          operationError
            ? 'Sandbox execution failed and lifecycle cleanup was incomplete.'
            : 'Sandbox lifecycle cleanup was incomplete.',
          { cause: cleanupError }
        );
      }
    }
  }

  registry.register(
    {
      id: TOOL_ID,
      version: '1.0.0',
      description: 'Execute an approved Python or Shell script in an isolated Docker Sandbox.',
      inputSchema: { type: 'object' },
      sideEffectLevel: 'write',
      timeoutPolicy: { timeoutMs: TOOL_GOVERNANCE_TIMEOUT_MS, onTimeout: 'fail' },
      retryPolicy: { maxAttempts: 1 },
      auditPolicy: { enabled: true, includeInput: false, includeOutput: false },
      humanApprovalPolicy: { required: true, reason: 'Sandbox script execution requires confirmation.' }
    },
    executeApproved
  );
  const runner = new GovernedToolRunner(registry, events);
  const pending = new Map();

  return Object.freeze({
    describe() {
      return {
        runtime: 'docker-sandbox-governed',
        policy: {
          cpuCores: environment.resources.cpuCores,
          memoryMb: environment.resources.memoryMb,
          timeoutMs: environment.defaultTimeoutMs,
          network: environment.network.mode,
          rootFilesystem: environment.filesystem.rootFilesystem,
          reuse: environment.lifecycle.reuse
        },
        hyphaSourceModified: false
      };
    },
    async plan(input) {
      const request = requireSandboxRequest({
        language: input?.language,
        script: input?.script,
        inputFiles: input?.inputFiles
      });
      const runId = requireId(input?.runId ?? randomUUID(), 'runId');
      const sessionId = requireId(input?.sessionId ?? safeId('session', runId), 'sessionId');
      const invocationId = safeId('lexpilot-sandbox', runId);
      const result = await runner.run({
        toolId: TOOL_ID,
        input: { ...request, runId, sessionId },
        context: { runId, sessionId, stepId: 'sandbox-execution', invocationId }
      });
      if (result.status !== 'human_review_required') {
        throw new Error('Unable to create Sandbox Human Review.');
      }
      pending.set(invocationId, runId);
      return {
        status: 'awaiting_confirmation',
        invocationId,
        executionAttempted: false,
        plan: safePlan(request, environment, invocationId)
      };
    },
    async approve({ invocationId, runId, approvedAt }) {
      if (pending.get(invocationId) !== runId) throw new Error('Sandbox plan mismatch.');
      const result = await runner.approveAndResume(invocationId, 'lexpilot-session-owner', { approvedAt });
      pending.delete(invocationId);
      const trace = await events.list({ runId });
      return {
        status: result.status === 'completed' ? result.output.status : 'failed',
        executionAttempted: true,
        result: result.status === 'completed'
          ? result.output
          : { status: 'failed', errorCode: result.error?.code ?? 'SANDBOX_EXECUTION_FAILED' },
        governanceReceipt: { eventCount: trace.length, eventTypes: [...new Set(trace.map((event) => event.type))] }
      };
    },
    async reject({ invocationId, runId }) {
      if (pending.get(invocationId) !== runId) throw new Error('Sandbox plan mismatch.');
      await runner.rejectInvocation(invocationId);
      pending.delete(invocationId);
      const trace = await events.list({ runId });
      return {
        status: 'rejected',
        executionAttempted: false,
        governanceReceipt: { eventCount: trace.length, eventTypes: [...new Set(trace.map((event) => event.type))] }
      };
    }
  });
}

module.exports = {
  REQUIRED_CAPABILITIES,
  TOOL_GOVERNANCE_TIMEOUT_MS,
  TOOL_ID,
  createSandboxExecutionRuntime
};
