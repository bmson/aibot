import { getAgent } from '@assistant/core/chat';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import { type Db, mcpConnections } from '@assistant/db';
import { and, asc, eq, sql } from 'drizzle-orm';

export type McpConnectionStatus =
  | 'ready'
  | 'checking'
  | 'authorization_required'
  | 'error'
  | 'disabled';

export interface McpConnectionInput {
  name: string;
  endpoint: string;
  bearerToken?: string;
}

export interface McpConnectionDiscovery {
  status: Extract<McpConnectionStatus, 'ready' | 'authorization_required' | 'error'>;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  error?: string;
}

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function cleanEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Owner-facing MCP connection summaries; credentials never enter this model. */
export async function listMcpConnections(db: Db) {
  const agent = await getAgent(db);
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.agentId, agent.id))
    .orderBy(asc(mcpConnections.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    status: row.enabled ? (row.status as McpConnectionStatus) : ('disabled' as const),
    enabled: row.enabled,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    instructions: row.instructions,
    tools: row.tools as McpConnectionDiscovery['tools'],
    hasBearerToken: Boolean(row.bearerTokenEncrypted),
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
  }));
}

/** Create a pending record first so a failed discovery is visible and retryable. */
export async function createMcpConnection(
  db: Db,
  input: McpConnectionInput,
): Promise<{ connection?: typeof mcpConnections.$inferSelect; error?: string }> {
  const name = cleanName(input.name);
  const endpoint = cleanEndpoint(input.endpoint);
  if (!name) return { error: 'Give this MCP connection a name.' };
  if (!endpoint)
    return { error: 'Enter an HTTP or HTTPS MCP endpoint without embedded credentials.' };
  const bearerToken = input.bearerToken?.trim();
  if (bearerToken && bearerToken.length > 8_192) return { error: 'Bearer token is too long.' };
  let bearerTokenEncrypted: string | null = null;
  try {
    bearerTokenEncrypted = bearerToken ? encryptMcpBearerToken(bearerToken) : null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unable to protect bearer token.' };
  }
  const agent = await getAgent(db);
  try {
    const [connection] = await db
      .insert(mcpConnections)
      .values({ agentId: agent.id, name, endpoint, bearerTokenEncrypted, status: 'checking' })
      .returning();
    return { connection };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (detail.includes('mcp_connections_agent_name_idx')) {
      return { error: 'A connection with that name already exists.' };
    }
    throw error;
  }
}

export async function saveMcpDiscovery(
  db: Db,
  connectionId: string,
  discovery: McpConnectionDiscovery,
): Promise<void> {
  await db
    .update(mcpConnections)
    .set({
      status: discovery.status,
      serverName: discovery.serverName ?? null,
      serverVersion: discovery.serverVersion ?? null,
      instructions: discovery.instructions ?? null,
      tools: discovery.tools,
      lastCheckedAt: sql`now()`,
      lastError: discovery.error ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(mcpConnections.id, connectionId));
}

export async function getMcpConnection(db: Db, connectionId: string) {
  const agent = await getAgent(db);
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.agentId, agent.id)));
  return connection ?? null;
}

export async function setMcpConnectionEnabled(
  db: Db,
  connectionId: string,
  enabled: boolean,
): Promise<boolean> {
  const agent = await getAgent(db);
  const rows = await db
    .update(mcpConnections)
    .set({
      enabled,
      status: enabled ? 'checking' : 'disabled',
      updatedAt: sql`now()`,
    })
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.agentId, agent.id)))
    .returning({ id: mcpConnections.id });
  return rows.length === 1;
}

export async function deleteMcpConnection(db: Db, connectionId: string): Promise<boolean> {
  const agent = await getAgent(db);
  const rows = await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.agentId, agent.id)))
    .returning({ id: mcpConnections.id });
  return rows.length === 1;
}
