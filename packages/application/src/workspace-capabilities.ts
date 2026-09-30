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

/** Present installed capabilities without duplicating Workspace's Calendar access. */
export function visibleWorkspaceCapabilityModules<T extends WorkspaceCapabilityMeta>(
  modules: readonly T[],
  diagnostics: readonly Pick<WorkspaceCapabilityDiagnostic, 'module' | 'enabled'>[],
): T[] {
  const enabled = new Map(diagnostics.map((item) => [item.module, item.enabled]));
  return modules.filter((module) => module.name !== 'calendar' || !enabled.get('google'));
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
  const visibleModules = visibleWorkspaceCapabilityModules(
    modules,
    modules.map((module) => ({
      module: module.name,
      enabled: diagnostics?.get(module.name)?.enabled ?? enabledWhenUnavailable.has(module.name),
    })),
  );
  return visibleModules.map((module) => {
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
