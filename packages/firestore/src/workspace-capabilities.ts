import type {
  AgentReadinessSource,
  WorkspaceCapabilityDiagnostic,
  WorkspaceCapabilityReadiness,
  WorkspaceCapabilityRepository,
} from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

const unavailable = (): WorkspaceCapabilityReadiness => ({
  statusAvailable: false,
  diagnostics: [],
});

function diagnosticsFromAgent(
  payload: unknown,
  expectedModules: readonly string[],
): WorkspaceCapabilityDiagnostic[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as Record<string, unknown>;
  if (
    response.ready !== true ||
    response.database !== 'firestore' ||
    !Array.isArray(response.modules) ||
    response.modules.length !== expectedModules.length
  )
    return null;
  const expected = new Set(expectedModules);
  const found = new Set<string>();
  const diagnostics: WorkspaceCapabilityDiagnostic[] = [];
  for (const entry of response.modules) {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.module !== 'string' ||
      !expected.has(row.module) ||
      found.has(row.module) ||
      typeof row.enabled !== 'boolean' ||
      typeof row.ready !== 'boolean' ||
      typeof row.detail !== 'string' ||
      (row.ready && !row.enabled)
    )
      return null;
    found.add(row.module);
    diagnostics.push({
      module: row.module,
      enabled: row.enabled,
      ready: row.ready,
      detail: row.detail,
    });
  }
  return diagnostics;
}

/** Checks the configured installation owner around one live agent readiness read. */
export class FirestoreWorkspaceCapabilityRepository implements WorkspaceCapabilityRepository {
  readonly kind = 'workspace-capability-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    readonly source: AgentReadinessSource,
  ) {
    if (!configuredAgentId) throw new Error('configured agent is required');
  }

  private async assertOwner(agentId: string): Promise<void> {
    const owner = await this.store.doc('agents', this.configuredAgentId).get();
    if (!owner.exists || owner.get('id') !== agentId || owner.id !== documentKey(agentId))
      throw new Error('Capability owner is outside the configured installation');
  }

  async load(
    agentId: string,
    expectedModules: readonly string[],
  ): Promise<WorkspaceCapabilityReadiness> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Capability owner is outside the configured installation');
    if (
      expectedModules.length === 0 ||
      expectedModules.some((module) => !module) ||
      new Set(expectedModules).size !== expectedModules.length
    )
      throw new Error('Capability module catalog is invalid');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    await this.assertOwner(agentId);

    let result = unavailable();
    try {
      const payload = await this.source.read(agentId);
      const diagnostics = diagnosticsFromAgent(payload, expectedModules);
      if (diagnostics) result = { statusAvailable: true, diagnostics };
    } catch {
      // An unreachable or unhealthy agent must never appear ready.
    }

    await this.assertOwner(agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
