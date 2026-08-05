const assert = require('node:assert/strict');
const test = require('node:test');
const { PRIVACY_POLICY_VERSION, V0_ERROR_CODES } = require('../src/v0/contracts.cjs');
const {
  OWNER_HISTORY_ERASURE_PHRASE,
  LegalSelfCheckConversationService
} = require('../src/v0/conversation-service.cjs');
const { InMemoryLegalSessionStore } = require('../src/v0/session-store.cjs');

function createService() {
  let sequence = 0;
  return new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => `session-${++sequence}`,
    clock: () => '2026-07-20T00:00:00.000Z'
  });
}

test('starts a session with sanitized history and bounded questions', () => {
  const service = createService();
  const result = service.start({
    userText: '姓名：张三，手机号 13800138000，老板让我明天不用来了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const stored = service.getSession(result.sessionId);
  const serialized = JSON.stringify(stored);

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.authorizationStatus, 'granted');
  assert.equal(result.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
  assert.equal(result.authorizationRecordedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(result.taskType, 'legal_self_check');
  assert.equal(result.taskTypeRecognition.status, 'classified');
  assert.equal(result.clarificationRound, 0);
  assert.equal(result.questions.length, 2);
  assert.equal(stored.messages.length, 1);
  assert.deepEqual(stored.privacyAuthorization, {
    status: 'granted',
    policyVersion: PRIVACY_POLICY_VERSION,
    recordedAt: '2026-07-20T00:00:00.000Z',
    subjectId: 'local-user'
  });
  assert.equal(serialized.includes('张三'), false);
  assert.equal(serialized.includes('13800138000'), false);
  assert.equal(serialized.includes('[NAME_1]'), true);
  assert.equal(serialized.includes('[PHONE_1]'), true);
});

test('routes a professional data query to the V1 handoff without running V0 analysis', () => {
  const service = createService();
  const result = service.start({
    userText:
      '姓名：张三，请统计近三年北京法院未签劳动合同案件的胜诉率和赔偿金额中位数，手机13800138000。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const stored = service.getSession(result.sessionId);
  const history = service.getHistory(result.sessionId);
  const serialized = JSON.stringify({ result, stored, history });
  const trace = JSON.stringify(result.trace);

  assert.equal(result.status, 'professional_query_identified');
  assert.equal(result.taskType, 'professional_data_query');
  assert.equal(result.taskTypeRecognition.status, 'classified');
  assert.equal(result.legalDomain, undefined);
  assert.equal(result.lawRetrievalStatus, 'not_run');
  assert.deepEqual(result.lawReferences, []);
  assert.equal(result.disclaimer, undefined);
  assert.equal(history.taskType, 'professional_data_query');
  assert.equal(serialized.includes('张三'), false);
  assert.equal(serialized.includes('13800138000'), false);
  assert.equal(serialized.includes('[NAME_1]'), true);
  assert.equal(serialized.includes('[PHONE_1]'), true);
  assert.equal(trace.includes('胜诉率和赔偿金额中位数'), false);

  const lateAnswer = service.answer(result.sessionId, '继续执行查询。');
  assert.equal(lateAnswer.error.code, V0_ERROR_CODES.SESSION_NOT_ACCEPTING_INPUT);
});

test('fails closed when task classification output contains undeclared content', () => {
  const store = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store,
    taskClassifier() {
      return {
        status: 'classified',
        taskType: 'professional_data_query',
        taskTypeLabel: 'V1 专业结构化数据查询',
        confidence: 'high',
        matchedSignals: ['explicit_sql'],
        classificationMethod: 'deterministic_v0_v1_signals_v0',
        trace: [{ type: 'unsafe', data: { secret: 'private classifier trace' } }],
        sql: 'DROP TABLE users'
      };
    }
  });
  const result = service.start({
    userText: '请执行 SELECT 查询。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, V0_ERROR_CODES.TASK_TYPE_CLASSIFICATION_FAILED);
  assert.equal(store.count(), 0);
  assert.equal(serialized.includes('private classifier trace'), false);
  assert.equal(serialized.includes('DROP TABLE'), false);
});

test('merges sanitized answers and completes when minimum facts are available', () => {
  const service = createService();
  const started = service.start({
    userText: '老板让我明天不用来了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const answered = service.answer(
    started.sessionId,
    '我工作了3年，没有签合同，联系电话 13800138000。'
  );
  const stored = service.getSession(started.sessionId);

  assert.equal(answered.status, 'completed');
  assert.equal(answered.clarificationRound, 1);
  assert.deepEqual(answered.missingFields, []);
  assert.deepEqual(answered.questions, []);
  assert.equal(answered.knownFacts.employmentDuration, 'mentioned');
  assert.equal(answered.knownFacts.writtenContractStatus, 'not_signed');
  assert.equal(JSON.stringify(stored).includes('13800138000'), false);
  assert.equal(stored.messages.length, 2);
});

test('advances past base labor questions for separate Chinese short answers', () => {
  const service = createService();
  const started = service.start({
    userText: '老板让我明天不用来了。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const durationAnswer = service.answer(started.sessionId, '一年。');
  const contractAnswer = service.answer(started.sessionId, '签过。');

  assert.equal(durationAnswer.status, 'needs_clarification');
  assert.deepEqual(durationAnswer.missingFields, ['writtenContractStatus']);
  assert.deepEqual(durationAnswer.questions, ['双方有没有签过书面合同？']);
  assert.equal(contractAnswer.status, 'needs_clarification');
  assert.equal(contractAnswer.knownFacts.employmentDuration, 'mentioned');
  assert.equal(contractAnswer.knownFacts.writtenContractStatus, 'signed');
  assert.deepEqual(contractAnswer.missingFields, ['dismissalGround', 'noticeOrPayStatus']);
  assert.equal(contractAnswer.questions.includes('您大约工作了多久？'), false);
  assert.equal(contractAnswer.questions.includes('双方有没有签过书面合同？'), false);
});

test('preserves known facts across more than one clarification answer', () => {
  const service = createService();
  const started = service.start({
    userText: '朋友借钱不还。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const firstAnswer = service.answer(started.sessionId, '我有转账记录。');
  const secondAnswer = service.answer(started.sessionId, '说好去年年底还款。');

  assert.equal(firstAnswer.status, 'needs_clarification');
  assert.equal(secondAnswer.status, 'completed');
  assert.equal(secondAnswer.clarificationRound, 2);
  assert.equal(secondAnswer.knownFacts.evidenceStatus, 'available');
  assert.equal(secondAnswer.knownFacts.repaymentTermStatus, 'agreed');
  assert.equal(secondAnswer.knownFacts.repaymentStatus, 'unpaid');
});

test('does not retrieve overdue-interest Article 676 without an agreed repayment term', () => {
  const service = createService();
  const result = service.start({
    userText: '朋友借钱没还，我有转账记录，但双方没有约定还款日期。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.lawReferences.map((reference) => reference.id), [
    'cn.civil-code.article-675'
  ]);
  assert.deepEqual(result.resultCards.map((card) => card.lawReferenceId), [
    'cn.civil-code.article-675'
  ]);
  assert.equal(result.legalConclusionGenerated, false);
});

test('stops an incomplete conversation after five clarification answers', () => {
  const service = createService();
  const started = service.start({
    userText: '有人借钱不还。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  let result = started;
  for (let round = 1; round <= 5; round += 1) {
    result = service.answer(started.sessionId, '我暂时不清楚。');
  }

  assert.equal(result.status, 'clarification_limit_reached');
  assert.equal(result.clarificationRound, 5);
  assert.deepEqual(result.questions, []);
  assert.equal(result.error.code, V0_ERROR_CODES.INSUFFICIENT_INFORMATION);
});

test('does not create a session without privacy consent', () => {
  const store = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store,
    idFactory: () => 'should-not-exist'
  });
  const result = service.start({
    userText: '老板辞退我。',
    privacyConsent: false,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.authorizationStatus, 'refused');
  assert.equal(result.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
  assert.equal(result.sessionId, undefined);
  assert.equal(store.count(), 0);
});

test('keeps a legacy unversioned session readable but rejects further answers', () => {
  const store = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'owner-a',
    idFactory: () => 'legacy-session'
  });
  service.start({
    userText: '老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const legacySession = store.get('legacy-session', 'owner-a');
  delete legacySession.privacyAuthorization;
  legacySession.privacyConsent = true;
  store.save(legacySession, 'owner-a');

  const history = service.getHistory('legacy-session');
  const answer = service.answer('legacy-session', '我工作了三年。');

  assert.equal(history.authorizationStatus, 'not_recorded');
  assert.equal(answer.error.code, V0_ERROR_CODES.PRIVACY_POLICY_VERSION_UNSUPPORTED);
  assert.equal(store.get('legacy-session', 'owner-a').messages.length, 1);
});

test('returns structured errors for missing and completed sessions', () => {
  const service = createService();
  const missing = service.answer('missing-session', '补充内容');
  assert.equal(missing.error.code, V0_ERROR_CODES.SESSION_NOT_FOUND);

  const completed = service.start({
    userText: '我在公司工作3年，没签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  assert.equal(completed.status, 'completed');

  const lateAnswer = service.answer(completed.sessionId, '再补充一些内容。');
  assert.equal(lateAnswer.error.code, V0_ERROR_CODES.SESSION_NOT_ACCEPTING_INPUT);
  assert.equal(service.getSession(completed.sessionId).messages.length, 1);
});

test('session service requires confirmation before physical deletion', () => {
  const service = createService();
  const started = service.start({
    userText: '老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const firstRead = service.getSession(started.sessionId);
  firstRead.messages.push({ role: 'user', redactedText: 'tampered' });

  assert.equal(service.getSession(started.sessionId).messages.length, 1);
  const unconfirmed = service.deleteSession(started.sessionId);
  assert.equal(unconfirmed.status, 'confirmation_required');
  assert.equal(unconfirmed.success, false);
  assert.equal(unconfirmed.deleted, false);
  assert.equal(
    unconfirmed.error.code,
    V0_ERROR_CODES.SESSION_DELETE_CONFIRMATION_REQUIRED
  );
  assert.equal(service.getSession(started.sessionId).messages.length, 1);

  const confirmed = service.deleteSession(started.sessionId, { confirmed: true });
  assert.equal(confirmed.status, 'deleted');
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.deleted, true);
  assert.equal(service.getSession(started.sessionId), null);
});

test('isolates sessions and history by owner', () => {
  const store = new InMemoryLegalSessionStore();
  const ownerA = new LegalSelfCheckConversationService({
    store,
    ownerId: 'owner-a',
    idFactory: () => 'private-session',
    clock: () => '2026-07-20T00:00:00.000Z'
  });
  const ownerB = new LegalSelfCheckConversationService({ store, ownerId: 'owner-b' });
  ownerA.start({
    userText: '老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(ownerB.getSession('private-session'), null);
  assert.equal(ownerB.getHistory('private-session'), null);
  assert.deepEqual(ownerB.listHistory(), []);
  assert.equal(
    ownerB.deleteSession('private-session', { confirmed: true }).status,
    'not_found'
  );
  assert.equal(ownerA.getSession('private-session').messages.length, 1);
});

test('erases only the current owner sessions after verifying and deleting associated Artifacts', async () => {
  const store = new InMemoryLegalSessionStore();
  const auditEntries = [];
  const artifactCalls = [];
  const artifactReceipt = {
    storeId: 'lexpilot.execution-artifacts.local',
    objectKey: `analysis/${'a'.repeat(64)}.md`,
    etag: 'etag-1',
    contentSha256: 'b'.repeat(64),
    sizeBytes: 12,
    backend: 'hypha.LocalFilesystemExecutionArtifactStore'
  };
  const common = {
    store,
    autoCleanup: false,
    deletionAuditIdFactory: () => 'lexpilot-deletion.00000000-0000-4000-8000-000000000001',
    executionLog: {
      append(entry) {
        auditEntries.push(structuredClone(entry));
        return {
          ...entry,
          schemaVersion: 1,
          sequence: auditEntries.length,
          entryId: `log-${auditEntries.length}`,
          entryHash: 'd'.repeat(64)
        };
      },
      list() { return [...auditEntries]; },
      verifyIntegrity() { return { status: 'verified' }; }
    },
    artifactRepository: {
      describe() { return {}; },
      async storeAnalysisArtifact() {},
      async readAnalysisArtifact(receipt) { artifactCalls.push(['read', receipt.objectKey]); return { content: 'verified' }; },
      async deleteAnalysisArtifact(receipt) { artifactCalls.push(['delete', receipt.objectKey]); return { status: 'deleted' }; }
    }
  };
  const ownerA = new LegalSelfCheckConversationService({ ...common, ownerId: 'owner-a', idFactory: () => 'owner-a-session' });
  const ownerB = new LegalSelfCheckConversationService({ ...common, ownerId: 'owner-b', idFactory: () => 'owner-b-session' });
  ownerA.start({ userText: '老板辞退我。', privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
  ownerB.start({ userText: '公司欠薪。', privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
  const owned = store.get('owner-a-session', 'owner-a');
  owned.v1 = { artifact: { storage: artifactReceipt } };
  store.save(owned, 'owner-a');

  const unconfirmed = await ownerA.eraseOwnerHistory({ confirmed: true, confirmationPhrase: 'wrong' });
  assert.equal(unconfirmed.status, 'confirmation_required');
  assert.equal(store.count('owner-a'), 1);

  const result = await ownerA.eraseOwnerHistory({
    confirmed: true,
    confirmationPhrase: OWNER_HISTORY_ERASURE_PHRASE
  });
  assert.deepEqual(result, {
    status: 'completed',
    success: true,
    erasedSessionCount: 1,
    erasedArtifactCount: 1,
    auditRecordsRetained: true,
    erasureReceiptRecorded: true,
    deletionAudit: {
      contractVersion: 'lexpilot.data-deletion-audit.v1',
      operationId: 'lexpilot-deletion.00000000-0000-4000-8000-000000000001',
      scope: 'owner_history',
      phase: 'completed',
      status: 'completed',
      recorded: true,
      recoveryQueued: false,
      logEntryRef: {
        schemaVersion: 1,
        entryId: 'log-2',
        sequence: 2,
        entryHash: `sha256:${'d'.repeat(64)}`
      }
    }
  });
  assert.deepEqual(artifactCalls.map(([operation]) => operation), ['read', 'delete']);
  assert.equal(store.count('owner-a'), 0);
  assert.equal(store.count('owner-b'), 1);
  assert.deepEqual(auditEntries.map((entry) => entry.operationType), [
    'owner_history_erasure_requested',
    'owner_history_erasure_completed'
  ]);
  assert.equal(JSON.stringify(auditEntries).includes('owner-a-session'), false);
  assert.equal(JSON.stringify(auditEntries).includes('owner-a'), false);
  assert.equal(auditEntries[1].auditRecordsRetained, true);
});

test('keeps sessions when Artifact preflight verification fails', async () => {
  const store = new InMemoryLegalSessionStore();
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'preflight-owner',
    idFactory: () => 'preflight-session',
    autoCleanup: false,
    artifactRepository: {
      describe() { return {}; },
      async storeAnalysisArtifact() {},
      async readAnalysisArtifact() { throw new Error('verification failed'); },
      async deleteAnalysisArtifact() { throw new Error('must not delete'); }
    }
  });
  service.start({ userText: '老板辞退我。', privacyConsent: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
  const session = store.get('preflight-session', 'preflight-owner');
  session.v1 = { artifact: { storage: {
    storeId: 'store', objectKey: 'analysis/object.md', contentSha256: 'hash'
  } } };
  store.save(session, 'preflight-owner');
  await assert.rejects(
    service.eraseOwnerHistory({ confirmed: true, confirmationPhrase: OWNER_HISTORY_ERASURE_PHRASE }),
    (error) => error?.code === 'OWNER_HISTORY_ERASURE_FAILED'
  );
  assert.equal(store.count('preflight-owner'), 1);
});

test('single-session Artifact failure preserves the Session for retry', async () => {
  const store = new InMemoryLegalSessionStore();
  let deleteCalls = 0;
  const service = new LegalSelfCheckConversationService({
    store,
    ownerId: 'single-delete-owner',
    idFactory: () => 'single-delete-session',
    autoCleanup: false,
    artifactRepository: {
      async storeAnalysisArtifact() {},
      async readAnalysisArtifact() { throw new Error('read failed'); },
      async deleteAnalysisArtifact() { deleteCalls += 1; }
    }
  });
  service.start({
    userText: '老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const session = store.get('single-delete-session', 'single-delete-owner');
  session.v1 = {
    artifact: {
      contentSha256: 'a'.repeat(64),
      storage: { storeId: 'store', objectKey: 'analysis/object.md', sizeBytes: 1 }
    }
  };
  store.save(session, 'single-delete-owner');
  await assert.rejects(
    service.deleteSessionWithArtifacts('single-delete-session', { confirmed: true }),
    (error) => error?.code === 'SESSION_DELETE_ARTIFACT_FAILED'
  );
  assert.equal(deleteCalls, 0);
  assert.notEqual(store.get('single-delete-session', 'single-delete-owner'), null);
});

test('returns history summaries without message text and sanitized history details', () => {
  const service = createService();
  const started = service.start({
    userText: '姓名：张三，老板辞退我，手机号 13800138000。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const list = service.listHistory();
  const detail = service.getHistory(started.sessionId);

  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, started.sessionId);
  assert.equal(list[0].messageCount, 1);
  assert.equal(Object.hasOwn(list[0], 'messages'), false);
  assert.equal(detail.messages[0].redactedText.includes('[NAME_1]'), true);
  assert.equal(detail.messages[0].redactedText.includes('[PHONE_1]'), true);
  assert.equal(JSON.stringify(detail).includes('张三'), false);
  assert.equal(JSON.stringify(detail).includes('13800138000'), false);
  assert.equal(Object.hasOwn(detail, 'ownerId'), false);
});

test('adds a candidate labor law reference without generating a legal conclusion', () => {
  const service = createService();
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.lawRetrievalStatus, 'matched');
  assert.equal(result.lawReferences.length, 1);
  assert.equal(result.lawReferences[0].id, 'cn.labor-contract-law.article-82');
  assert.equal(result.lawReferences[0].legalDomain, result.legalDomain);
  assert.equal(result.lawComparisonStatus, 'completed');
  assert.equal(result.lawComparisons.length, 1);
  assert.equal(result.lawComparisons[0].lawReferenceId, result.lawReferences[0].id);
  assert.equal(result.lawComparisons[0].comparisonStatus, 'potential_match');
  assert.ok(result.lawComparisons[0].unresolvedElements.length > 0);
  assert.equal(result.resultCardStatus, 'completed');
  assert.equal(result.resultCards.length, 1);
  assert.equal(result.resultCards[0].userExcerpt, result.lawComparisons[0].sanitizedFactExcerpt);
  assert.equal(result.resultCards[0].lawName, result.lawReferences[0].lawName);
  assert.equal(result.resultCards[0].articleNumber, result.lawReferences[0].articleNumber);
  assert.equal(result.resultCards[0].articleText, result.lawReferences[0].articleText);
  assert.equal(result.resultCards[0].lawVersionDate, result.lawReferences[0].effectiveDate);
  assert.equal(result.resultCards[0].legalConclusionGenerated, false);
  assert.match(result.disclaimer, /不构成违法认定/);
  assert.equal(JSON.stringify(result.resultCards).includes('你应该'), false);
  assert.equal(JSON.stringify(result.resultCards).includes('建议你'), false);
  assert.equal(JSON.stringify(result.resultCards).includes('可以起诉'), false);
  assert.equal(result.legalConclusionGenerated, false);
  assert.match(result.lawReferenceDisclaimer, /候选法规来源/);
});

test('collects signed-contract dismissal facts across two sanitized turns', () => {
  const service = createService();
  const started = service.start({
    userText: '我在公司工作3年，签了书面合同，公司说我不能胜任工作，要辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(started.status, 'needs_clarification');
  assert.deepEqual(started.missingFields, [
    'noticeOrPayStatus',
    'performanceRemediationOutcome'
  ]);
  assert.equal(started.questions.length, 2);

  const answered = service.answer(
    started.sessionId,
    '公司没有培训或调岗，也没有提前三十天书面通知，也没有多给一个月工资。'
  );

  assert.equal(answered.status, 'completed');
  assert.equal(answered.knownFacts.dismissalGround, 'performance');
  assert.equal(answered.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(answered.knownFacts.performanceRemediationOutcome, 'no_training_or_adjustment');
  assert.equal(answered.lawRetrievalStatus, 'matched');
  assert.deepEqual(
    answered.lawReferences.map((reference) => reference.id),
    ['cn.labor-contract-law.article-40']
  );
  assert.equal(answered.lawComparisonStatus, 'completed');
  assert.equal(answered.lawComparisons[0].comparisonStatus, 'potential_match');
  assert.equal(answered.resultCardStatus, 'completed');
  assert.equal(answered.resultCards.length, 1);
  assert.equal(answered.resultCards[0].lawReferenceId, 'cn.labor-contract-law.article-40');
  assert.equal(answered.legalConclusionGenerated, false);
});

test('routes an oral-notice dismissal to Article 40 without claiming written notice', () => {
  const service = createService();
  const started = service.start({
    userText: '我在公司工作3年，签了书面合同，公司说我不能胜任工作，提前三十天口头通知辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(started.status, 'needs_clarification');
  assert.equal(Object.hasOwn(started.knownFacts, 'noticeOrPayStatus'), false);

  const answered = service.answer(
    started.sessionId,
    '公司没有培训或调岗，也没有多给一个月工资。'
  );

  assert.equal(answered.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(answered.lawRetrievalStatus, 'matched');
  assert.deepEqual(
    answered.lawReferences.map((reference) => reference.id),
    ['cn.labor-contract-law.article-40']
  );
  assert.equal(answered.lawComparisons[0].comparisonStatus, 'potential_match');
  assert.equal(answered.resultCardStatus, 'completed');
  assert.equal(answered.legalConclusionGenerated, false);
});

test('recognizes terse answers to medical dismissal questions and refines the next prompt', () => {
  const service = createService();
  const started = service.start({
    userText: '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  assert.deepEqual(started.questions, [
    '公司有没有提前三十天书面告诉您，或者另外多给一个月工资？',
    '公司规定的看病休养时间是否已经结束？'
  ]);

  const answered = service.answer(started.sessionId, '没有多给，已结束');

  assert.equal(answered.knownFacts.medicalPeriodStatus, 'ended');
  assert.equal(Object.hasOwn(answered.knownFacts, 'noticeOrPayStatus'), false);
  assert.deepEqual(answered.questions, [
    '公司有没有提前三十天书面告诉您？',
    '休养时间结束后，您是否既做不了原来的工作，也做不了公司另外安排的工作？'
  ]);
  assert.equal(
    answered.questions.includes('公司规定的看病休养时间是否已经结束？'),
    false
  );
});

test('completes the screenshot clarification flow without repeating an answered question', () => {
  const service = createService();
  const started = service.start({
    userText:
      '我在公司工作3年，签了书面合同，公司因为我生病休养后辞退我，没有多给一个月工资。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  assert.deepEqual(started.questions, [
    '公司有没有提前三十天书面告诉您？',
    '公司规定的看病休养时间是否已经结束？'
  ]);

  const firstAnswer = service.answer(started.sessionId, '没有告诉我，已经结束了');
  assert.equal(firstAnswer.knownFacts.noticeOrPayStatus, 'neither');
  assert.equal(firstAnswer.knownFacts.medicalPeriodStatus, 'ended');
  assert.deepEqual(firstAnswer.questions, [
    '休养时间结束后，您是否既做不了原来的工作，也做不了公司另外安排的工作？'
  ]);

  const secondAnswer = service.answer(started.sessionId, '没有');
  assert.equal(secondAnswer.clarificationRound, 2);
  assert.equal(secondAnswer.knownFacts.workArrangementOutcome, 'can_original_or_alternative');
  assert.equal(secondAnswer.questions.length, 0);
  assert.notEqual(secondAnswer.status, 'clarification_limit_reached');
});

test('retrieves the verified marriage-family reference for covered facts', () => {
  const service = createService();
  const result = service.start({
    userText: '我已婚，丈夫长期对我实施家庭暴力。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.lawRetrievalStatus, 'matched');
  assert.equal(result.lawReferences.length, 1);
  assert.equal(result.lawReferences[0].id, 'cn.civil-code.article-1042');
  assert.equal(result.lawReferences[0].legalDomain, 'marriage_family');
  assert.equal(result.lawReferences[0].topics.includes('domestic_violence'), true);
  assert.equal(result.legalConclusionGenerated, false);
});

test('returns safe no_match instead of a broad cross-domain reference', () => {
  const service = createService();
  const result = service.start({
    userText: '我已婚，想离婚，主要争议是房产。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.status, 'information_ready');
  assert.equal(result.legalDomain, 'marriage_family');
  assert.equal(result.lawRetrievalStatus, 'no_match');
  assert.deepEqual(result.lawReferences, []);
  assert.equal(result.lawComparisonStatus, 'no_reference');
  assert.deepEqual(result.lawComparisons, []);
  assert.equal(result.resultCardStatus, 'no_match');
  assert.deepEqual(result.resultCards, []);
  assert.equal(result.legalConclusionGenerated, false);
});

test('persists candidate references in history while keeping summaries compact', () => {
  const service = createService();
  const result = service.start({
    userText: '朋友借钱不还，我有转账记录，说好去年年底还款。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const summary = service.listHistory()[0];
  const detail = service.getHistory(result.sessionId);

  assert.deepEqual(
    result.lawReferences.map((reference) => reference.id),
    ['cn.civil-code.article-675', 'cn.civil-code.article-676']
  );
  assert.equal(summary.lawReferenceCount, 2);
  assert.equal(summary.lawComparisonCount, 2);
  assert.equal(summary.resultCardCount, 2);
  assert.equal(Object.hasOwn(summary, 'lawReferences'), false);
  assert.deepEqual(
    detail.lawReferences.map((reference) => reference.id),
    ['cn.civil-code.article-675', 'cn.civil-code.article-676']
  );
  assert.deepEqual(
    detail.lawComparisons.map((comparison) => comparison.lawReferenceId),
    ['cn.civil-code.article-675', 'cn.civil-code.article-676']
  );
  assert.deepEqual(
    detail.resultCards.map((card) => card.lawReferenceId),
    ['cn.civil-code.article-675', 'cn.civil-code.article-676']
  );
  assert.equal(detail.resultCards.every((card) => card.legalConclusionGenerated === false), true);
  assert.equal(detail.legalConclusionGenerated, false);
});

test('fails closed when law retrieval is unavailable and does not expose the cause', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'retrieval-failure',
    clock: () => '2026-07-20T00:00:00.000Z',
    lawRetriever: {
      search() {
        throw new Error('provider secret and raw user text');
      }
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'information_ready');
  assert.equal(result.lawRetrievalStatus, 'failed');
  assert.deepEqual(result.lawReferences, []);
  assert.equal(result.lawRetrievalError.code, V0_ERROR_CODES.LAW_RETRIEVAL_FAILED);
  assert.equal(serialized.includes('provider secret'), false);
  assert.equal(serialized.includes('raw user text'), false);
});

test('rejects a cross-domain result returned by an injected retriever', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'cross-domain-result',
    lawRetriever: {
      search() {
        return {
          status: 'matched',
          results: [{ id: 'unsafe', legalDomain: 'taxation' }],
          trace: []
        };
      }
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });

  assert.equal(result.lawRetrievalStatus, 'failed');
  assert.deepEqual(result.lawReferences, []);
  assert.equal(result.lawRetrievalError.code, V0_ERROR_CODES.LAW_RETRIEVAL_FAILED);
});

test('fails closed when law comparison is unavailable and does not expose the cause', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'comparison-failure',
    lawComparator() {
      throw new Error('private comparison prompt and user evidence');
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.lawRetrievalStatus, 'matched');
  assert.equal(result.lawComparisonStatus, 'failed');
  assert.deepEqual(result.lawComparisons, []);
  assert.equal(result.lawComparisonError.code, V0_ERROR_CODES.LAW_COMPARISON_FAILED);
  assert.equal(serialized.includes('private comparison prompt'), false);
  assert.equal(serialized.includes('user evidence'), false);
});

test('rejects undeclared advice fields and provider trace content from a comparator', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'unsafe-comparison-output',
    lawComparator({ legalDomain, lawReferences }) {
      return {
        status: 'completed',
        comparisons: [
          {
            comparisonId: `${lawReferences[0].id}:comparison`,
            lawReferenceId: lawReferences[0].id,
            legalDomain,
            comparisonStatus: 'potential_match',
            sanitizedFactExcerpt: '脱敏事实',
            matchedFacts: [],
            unresolvedElements: ['exact_employment_start_and_duration'],
            comparisonMethod: 'deterministic_legal_elements_v0',
            legalConclusionGenerated: false,
            advice: '你应该立即起诉'
          }
        ],
        trace: [{ type: 'unsafe', data: { raw: 'provider private trace' } }]
      };
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.lawComparisonStatus, 'failed');
  assert.deepEqual(result.lawComparisons, []);
  assert.equal(serialized.includes('你应该立即起诉'), false);
  assert.equal(serialized.includes('provider private trace'), false);
});

test('fails closed when result-card construction is unavailable', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'result-card-failure',
    resultCardBuilder() {
      throw new Error('private prompt and suggested action');
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'information_ready');
  assert.equal(result.resultCardStatus, 'failed');
  assert.deepEqual(result.resultCards, []);
  assert.equal(result.resultCardError.code, V0_ERROR_CODES.RESULT_CARD_BUILD_FAILED);
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('suggested action'), false);
});

test('rejects undeclared advice fields returned by an injected result-card builder', () => {
  const service = new LegalSelfCheckConversationService({
    store: new InMemoryLegalSessionStore(),
    idFactory: () => 'unsafe-result-card',
    resultCardBuilder({ lawReferences, lawComparisons }) {
      const reference = lawReferences[0];
      const comparison = lawComparisons[0];
      return {
        status: 'completed',
        disclaimer:
          '本结果仅基于用户提供的脱敏事实与已核验法规进行信息匹配，不构成违法认定、案件结论或法律意见，也不提供行动建议。',
        resultCards: [
          {
            cardId: `${comparison.comparisonId}:result-card`,
            findingStatus: 'potential_match',
            findingLabel: '可能存在不合规风险',
            userExcerpt: comparison.sanitizedFactExcerpt,
            lawReferenceId: reference.id,
            lawName: reference.lawName,
            articleNumber: reference.articleNumber,
            articleText: reference.articleText,
            articleTextSha256: reference.articleTextSha256,
            lawVersionDate: reference.effectiveDate,
            officialSource: {
              authority: reference.source.textAuthority,
              url: reference.source.textUrl
            },
            unresolvedElements: comparison.unresolvedElements,
            legalConclusionGenerated: false,
            advice: '你应该立即起诉'
          }
        ],
        trace: [{ type: 'unsafe', data: { secret: 'provider trace' } }]
      };
    }
  });
  const result = service.start({
    userText: '我在公司工作3年，没有签劳动合同，老板辞退我。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'information_ready');
  assert.equal(result.resultCardStatus, 'failed');
  assert.equal(serialized.includes('你应该立即起诉'), false);
  assert.equal(serialized.includes('provider trace'), false);
});

test('law retrieval trace contains metadata only, never article text or PII', () => {
  const service = createService();
  const result = service.start({
    userText: '姓名：张三，我在公司工作3年，没有签劳动合同，老板辞退我，手机13800138000。',
    privacyConsent: true,
    privacyPolicyVersion: PRIVACY_POLICY_VERSION
  });
  const trace = JSON.stringify(result.trace);

  assert.equal(trace.includes('张三'), false);
  assert.equal(trace.includes('13800138000'), false);
  assert.equal(trace.includes(result.lawReferences[0].articleText), false);
  assert.equal(trace.includes(result.lawComparisons[0].sanitizedFactExcerpt), false);
  assert.equal(trace.includes(result.resultCards[0].userExcerpt), false);
});
