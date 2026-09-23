/** Secret-safe module readiness returned by the agent's live /ready source. */
export interface WorkspaceCapabilityDiagnostic {
  module: string;
  enabled: boolean;
  ready: boolean;
  detail: string;
}

export interface WorkspaceCapabilityReadiness {
  statusAvailable: boolean;
  diagnostics: WorkspaceCapabilityDiagnostic[];
}

/** The caller supplies a suitably authenticated transport to the configured agent. */
export interface AgentReadinessSource {
  read(agentId: string): Promise<unknown>;
}

export interface WorkspaceCapabilityRepository {
  readonly kind: 'workspace-capability-repository';
  load(agentId: string, expectedModules: readonly string[]): Promise<WorkspaceCapabilityReadiness>;
}
