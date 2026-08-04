const path = require('node:path');
const { loadHyphaDomain } = require('./hypha-paths.cjs');
const {
  agentCapabilityPatchRef,
  capabilitySnapshotRef,
  createAgentCapabilityPatch,
  createCapabilityReferenceSnapshot
} = require('../src/v1/capability-reference-snapshot.cjs');
const { loadDataSourceSchemaProfile } = require('../src/v1/data-source-schema-profile.cjs');
const {
  artifactOutputBindingRef,
  loadArtifactOutputCapabilityBinding
} = require('../src/v1/artifact-output-capability-binding.cjs');
const { loadWorkflowStateCapabilityMap } = require('../src/v1/workflow-state-capability-map.cjs');
const { loadWorkspaceExecutionProfile } = require('../src/v1/workspace-execution-profile.cjs');

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
  const workspaceExecution = loadWorkspaceExecutionProfile({ projectRoot }).receipt;
  const dataSourceSchemaProfile = loadDataSourceSchemaProfile({ projectRoot });
  const dataSourceSchema = dataSourceSchemaProfile.receipt;
  const workflowStateMap = loadWorkflowStateCapabilityMap({ projectRoot });
  const artifactOutput = loadArtifactOutputCapabilityBinding({ projectRoot }).receipt;
  const workflowStateBinding = workflowStateMap.bindApplication({
    workspaceExecutionBinding: workspaceExecution,
    dataSourceSchemaBinding: dataSourceSchemaProfile.resolveRuntime({ runtime: 'demo' }).receipt,
    sandboxEnabled: false
  });
  const capabilitySnapshot = createCapabilityReferenceSnapshot(workflowStateBinding);
  const capabilityPatch = createAgentCapabilityPatch(capabilitySnapshot);

  console.log(
    JSON.stringify(
      {
        domainPack: `${domainPack.id}@${domainPack.version}`,
        workflow: `${compiled.bindings.workflow.id}@${compiled.bindings.workflow.version}`,
        initialState: compiled.fsmProcess.initialState,
        terminalStates: compiled.fsmProcess.terminalStates,
        harnessedSystem: `${compiled.harnessedSystem.id}@${compiled.harnessedSystem.version}`,
        workspaceProfile: `${workspaceExecution.workspaceProfileRef.id}@${workspaceExecution.workspaceProfileRef.version}`,
        executionProfile: `${workspaceExecution.executionProfileRef.id}@${workspaceExecution.executionProfileRef.version}`,
        executionProfileValidated: workspaceExecution.hyphaExecutionEnvironmentValidated,
        dataSourceSchemaBinding: `${dataSourceSchema.bindingId}@${dataSourceSchema.bindingVersion}`,
        dataSourceProfileCount: dataSourceSchema.profiles.length,
        schemaSnapshotContract: `${dataSourceSchema.schemaSnapshotContractRef.id}@${dataSourceSchema.schemaSnapshotContractRef.version}`,
        workflowStateCapabilityBinding: `${workflowStateBinding.bindingId}@${workflowStateBinding.bindingVersion}`,
        professionalWorkflow: `${workflowStateBinding.runtimeWorkflowRef.id}@${workflowStateBinding.runtimeWorkflowRef.version}`,
        domainStateBindingCount: workflowStateBinding.domainStateBindingCount,
        runtimeStateBindingCount: workflowStateBinding.runtimeStateBindingCount,
        compiledStateFsmSha256: workflowStateBinding.compiledFsmSha256,
        stateCapabilityReferencesRetained: workflowStateBinding.referencesRetained,
        artifactOutputBinding: artifactOutputBindingRef(artifactOutput),
        artifactProfile: `${artifactOutput.artifactProfileRef.id}@${artifactOutput.artifactProfileRef.version}`,
        professionalOutputContract: `${artifactOutput.outputContractRef.id}@${artifactOutput.outputContractRef.version}`,
        artifactStoreCount: Object.keys(artifactOutput.storeRefs).length,
        sessionAgentCapabilitySnapshot: capabilitySnapshotRef(capabilitySnapshot),
        agentCapabilityPatch: agentCapabilityPatchRef(capabilityPatch, capabilitySnapshot)
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
