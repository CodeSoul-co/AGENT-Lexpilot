const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadHyphaDomain } = require('../scripts/hypha-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const domainPackPath = path.join(
  projectRoot,
  'configs',
  'domain-packs',
  'legal-compliance.domain.json'
);

test('Legal DomainPack loads and compiles through Hypha', async () => {
  const { loadDomainPackFile, compileDomainPackToHarnessedSystem } = loadHyphaDomain(projectRoot);
  const domainPack = await loadDomainPackFile(domainPackPath);
  const compiled = compileDomainPackToHarnessedSystem(domainPack, {
    agentRef: { id: 'agent.legal-compliance', version: '0.16.0' },
    taskSchemaId: 'task.legal-self-check'
  });

  assert.equal(domainPack.id, 'domain.legal-compliance.v0-v1');
  assert.equal(domainPack.version, '0.16.0');
  assert.equal(
    domainPack.tools.find((tool) => tool.id === 'tool.pii-redactor').version,
    '0.3.0'
  );
  assert.equal(
    domainPack.tools.find((tool) => tool.id === 'tool.clarification-planner').version,
    '0.4.0'
  );
  assert.deepEqual(domainPack.taskSchemas[0].inputSchema.required, [
    'userText',
    'privacyConsent',
    'privacyPolicyVersion'
  ]);
  assert.equal(
    domainPack.taskSchemas[0].inputSchema.properties.privacyPolicyVersion.const,
    'legal-compliance-privacy-v0.1'
  );
  assert.equal(
    domainPack.sessionProfiles[0].defaultMetadata.privacyConsentHumanReviewRequired,
    true
  );
  assert.equal(compiled.fsmProcess.initialState, 'Intake');
  assert.deepEqual(compiled.fsmProcess.terminalStates, ['Completed', 'Failed']);
  assert.equal(compiled.bindings.workflow.id, 'workflow.legal-self-check');
  assert.equal(compiled.bindings.taskSchema.id, 'task.legal-self-check');
  assert.equal(compiled.harnessedSystem.agentRef.id, 'agent.legal-compliance');
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.pii-redactor'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.task-type-classifier'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.legal-domain-classifier'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.clarification-planner'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.session-history-store'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.session-retention-cleaner'));
  assert.ok(compiled.bindings.tools.some((tool) => tool.id === 'tool.verified-law-retriever'));
  assert.ok(compiled.bindings.policies.some((policy) => policy.id === 'policy.pii-before-inference'));
  assert.ok(compiled.bindings.policies.some((policy) => policy.id === 'policy.user-owned-session-write'));
  assert.ok(
    compiled.bindings.policies.some((policy) => policy.id === 'policy.automatic-session-retention')
  );
  assert.ok(domainPack.workflows[0].states.some((state) => state.id === 'RetrieveLaw'));
  assert.ok(domainPack.workflows[0].states.some((state) => state.id === 'AnalyzeLaw'));
  assert.ok(domainPack.workflows[0].states.some((state) => state.id === 'BuildResult'));
  assert.ok(domainPack.workflows[0].states.some((state) => state.id === 'ClassifyTask'));
  assert.deepEqual(compiled.sessionInitialization.sessionProfileRef, {
    id: 'session.legal-single-user',
    version: '0.16.0'
  });
});
