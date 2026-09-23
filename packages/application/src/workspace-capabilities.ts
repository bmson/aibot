import type {
  WorkspaceCapabilityDiagnostic,
  WorkspaceCapabilityRepository,
} from '@assistant/persistence';

export interface WorkspaceCapabilityMeta {
  name: string;
  title: string;
  summary: string;
}

/** Matches the capability item in the existing mobile workspace response. */
export interface MobileWorkspaceCapability {
  id: string;
  title: string;
  summary: string;
  enabled: boolean;
  ready: boolean;
  status: 'off' | 'ready' | 'setup_needed' | 'unavailable';
  detail: string;
}

function completeDiagnostics(
  diagnostics: WorkspaceCapabilityDiagnostic[],
  modules: readonly WorkspaceCapabilityMeta[],
): Map<string, WorkspaceCapabilityDiagnostic> | null {
  if (diagnostics.length !== modules.length) return null;
  const byModule = new Map(diagnostics.map((diagnostic) => [diagnostic.module, diagnostic]));
  if (byModule.size !== modules.length || modules.some((module) => !byModule.has(module.name)))
    return null;
  return byModule;
}

/** Module metadata and the enabled set are installation config, never credential values. */
export async function listMobileWorkspaceCapabilities(
  repository: WorkspaceCapabilityRepository,
  agentId: string,
  modules: readonly WorkspaceCapabilityMeta[],
  configuredEnabledModules: readonly string[],
): Promise<MobileWorkspaceCapability[]> {
  const readiness = await repository.load(
    agentId,
    modules.map((module) => module.name),
  );
  const diagnostics = readiness.statusAvailable
    ? completeDiagnostics(readiness.diagnostics, modules)
    : null;
  const enabledWhenUnavailable = new Set(configuredEnabledModules);
  return modules.map((module) => {
    const diagnostic = diagnostics?.get(module.name);
    const enabled = diagnostic?.enabled ?? enabledWhenUnavailable.has(module.name);
    const ready = diagnostic?.ready ?? false;
    const status = !enabled
      ? 'off'
      : !diagnostics
        ? 'unavailable'
        : ready
          ? 'ready'
          : 'setup_needed';
    return {
      id: module.name,
      title: module.title,
      summary: module.summary,
      enabled,
      ready,
      status,
      detail: diagnostic?.detail ?? 'agent readiness unavailable',
    };
  });
}
