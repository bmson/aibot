import type { Records } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export interface McpConnectionSummary {
  id: string;
  name: string;
  endpoint: string;
  status: string;
  enabled: boolean;
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: unknown;
  hasBearerToken: boolean;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

/** Owner-facing connection summaries. Encrypted credentials are never returned. */
export class FirestoreMcpConnectionReadRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async assertConfiguredOwner(): Promise<void> {
    const agents = await this.store.collection('agents').limit(2).get();
    const owner = agents.docs[0];
    if (
      !this.configuredAgentId ||
      agents.size !== 1 ||
      !owner ||
      owner.id !== documentKey(this.configuredAgentId) ||
      owner.get('id') !== this.configuredAgentId
    )
      throw new Error('MCP connection reads require exactly one configured agent');
  }

  async list(agentId: string): Promise<McpConnectionSummary[]> {
    if (agentId !== this.configuredAgentId)
      throw new Error('MCP connection read is outside the configured installation');
    await this.assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const page = await this.store
      .collection('mcpConnections')
      .where('agentId', '==', agentId)
      .orderBy('name', 'asc')
      .get();
    const rows = page.docs.flatMap((doc) => {
      const row = decodeRecord<Records['mcpConnections']>(doc.data());
      if (
        row.agentId !== agentId ||
        documentKey(row.id) !== doc.id ||
        typeof row.name !== 'string' ||
        typeof row.endpoint !== 'string' ||
        typeof row.enabled !== 'boolean'
      )
        return [];
      return [
        {
          id: row.id,
          name: row.name,
          endpoint: row.endpoint,
          status: row.enabled ? row.status : 'disabled',
          enabled: row.enabled,
          serverName: row.serverName,
          serverVersion: row.serverVersion,
          instructions: row.instructions,
          tools: row.tools,
          hasBearerToken: row.bearerTokenEncrypted != null,
          lastCheckedAt: row.lastCheckedAt,
          lastError: row.lastError,
        },
      ];
    });
    await this.assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return rows;
  }
}
