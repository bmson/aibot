import {
  type AssistantModule,
  assistantModuleNames,
  type Config,
  isModuleEnabled,
  loadConfig,
} from '@assistant/config';
import {
  assistantModuleMetas,
  type ModuleDiagnostic,
  moduleDiagnostics,
} from '@assistant/modules/meta';

export type CapabilityStatus = 'off' | 'ready' | 'setup_needed' | 'unavailable';

export interface CapabilityDiagnostics {
  diagnostics: ModuleDiagnostic[];
  statusAvailable: boolean;
}

function isModuleDiagnostic(value: unknown): value is ModuleDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.module === 'string' &&
    assistantModuleNames.includes(candidate.module as AssistantModule) &&
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.ready === 'boolean' &&
    typeof candidate.detail === 'string'
  );
}

function unavailableDiagnostics(config: Config): ModuleDiagnostic[] {
  return assistantModuleMetas.map((meta) => ({
    module: meta.name,
    enabled: isModuleEnabled(config, meta.name),
    ready: false,
    detail: 'agent readiness unavailable',
  }));
}

/**
 * Capability credentials live only on the agent service, where the tools run.
 * Cloud web processes therefore ask the agent's secret-safe readiness endpoint
 * instead of evaluating their own deliberately smaller environment.
 */
export async function resolveCapabilityDiagnostics(
  config: Config,
  fetcher: typeof fetch = fetch,
): Promise<CapabilityDiagnostics> {
  // Local web and agent processes share the repository .env, so the direct
  // predicate is both faster and authoritative in development.
  if (config.QUEUE_DRIVER !== 'cloudtasks') {
    return { diagnostics: moduleDiagnostics(config), statusAvailable: true };
  }

  const agentUrl = (config.AGENT_URL || config.PUBLIC_URL).replace(/\/$/, '');
  try {
    const response = await fetcher(`${agentUrl}/ready`, {
      cache: 'no-store',
      // Allow a scaled-to-zero Cloud Run agent to cold-start without turning
      // a healthy configuration into a transient "Status unavailable" card.
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`agent readiness returned ${response.status}`);
    const payload = (await response.json()) as { modules?: unknown };
    if (!Array.isArray(payload.modules) || !payload.modules.every(isModuleDiagnostic)) {
      throw new Error('agent readiness omitted module diagnostics');
    }

    const byModule = new Map(payload.modules.map((diagnostic) => [diagnostic.module, diagnostic]));
    const diagnostics = assistantModuleMetas.map((meta) => byModule.get(meta.name));
    if (diagnostics.some((diagnostic) => !diagnostic)) {
      throw new Error('agent readiness omitted an installed module');
    }
    return { diagnostics: diagnostics as ModuleDiagnostic[], statusAvailable: true };
  } catch (error) {
    console.error('capability readiness unavailable', error);
    return { diagnostics: unavailableDiagnostics(config), statusAvailable: false };
  }
}

export function getCapabilityDiagnostics(): Promise<CapabilityDiagnostics> {
  return resolveCapabilityDiagnostics(loadConfig());
}

export function capabilityStatus(
  diagnostic: Pick<ModuleDiagnostic, 'enabled' | 'ready'>,
  statusAvailable: boolean,
): CapabilityStatus {
  if (!diagnostic.enabled) return 'off';
  if (!statusAvailable) return 'unavailable';
  return diagnostic.ready ? 'ready' : 'setup_needed';
}

export function capabilityStatusTitle(status: CapabilityStatus): string {
  switch (status) {
    case 'off':
      return 'Off';
    case 'ready':
      return 'Ready';
    case 'setup_needed':
      return 'Setup needed';
    case 'unavailable':
      return 'Status unavailable';
  }
}
