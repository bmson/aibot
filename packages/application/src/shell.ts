import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core/chat';
import { getMemoryHealth } from '@assistant/core/memory/health';
import { contacts, type Db } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { getDashboardPresence } from './dashboard.js';

export async function getAssistantIdentity(db: Db) {
  try {
    const agent = await getAgent(db);
    return { id: agent.id, name: agent.name || 'Assistant', avatarUrl: agent.avatarUrl ?? null };
  } catch {
    return { id: '', name: 'Assistant', avatarUrl: null };
  }
}

export async function getAssistantTimezone(db: Db): Promise<string> {
  try {
    return (await getAgent(db)).timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function getOwnerGivenName(db: Db): Promise<string | null> {
  try {
    const [owner] = await db
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.trust, 'owner'))
      .limit(1);
    return owner?.name.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export async function getPrimaryConversationId(db: Db): Promise<string> {
  const agent = await getAgent(db);
  return (await getOrCreatePrimaryConversation(db, agent.id)).id;
}

export async function getShellStatus(db: Db, agentId: string) {
  const [dashboard, memoryHealth] = await Promise.all([
    getDashboardPresence(db, agentId),
    getMemoryHealth(db, agentId),
  ]);
  return { dashboard, memoryHealth };
}
