const path = require('node:path');
const { loadHyphaDomain } = require('./hypha-paths.cjs');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const domainPackPath = path.join(
    projectRoot,
    'configs',
    'domain-packs',
    'legal-compliance.domain.json'
  );
  const { loadDomainPackFile, compileDomainPackToHarnessedSystem } = loadHyphaDomain(projectRoot);
  const domainPack = await loadDomainPackFile(domainPackPath);
  const compiled = compileDomainPackToHarnessedSystem(domainPack, {
    agentRef: { id: 'agent.legal-compliance', version: '0.16.0' },
    taskSchemaId: 'task.legal-self-check'
  });

  console.log(
    JSON.stringify(
      {
        domainPack: `${domainPack.id}@${domainPack.version}`,
        workflow: `${compiled.bindings.workflow.id}@${compiled.bindings.workflow.version}`,
        initialState: compiled.fsmProcess.initialState,
        terminalStates: compiled.fsmProcess.terminalStates,
        harnessedSystem: `${compiled.harnessedSystem.id}@${compiled.harnessedSystem.version}`
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
