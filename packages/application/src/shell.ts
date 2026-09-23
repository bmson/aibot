import { getAgent, getOrCreatePrimaryConversation } from '@assistant/core/chat';
import { getMemoryHealth } from '@assistant/core/memory/health';
import type { Db } from '@assistant/db';
import {
  type ApplicationChatPersistence,
  isShellPresenceRepository,
  isShellStatusRepository,
  type ShellPresence,
  type ShellPresenceRepository,
  type ShellStatusProjection,
  type ShellStatusRepository,
} from '@assistant/persistence';
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

export async function getAssistantLocale(db: Db): Promise<string> {
  try {
    return (await getAgent(db)).locale || 'en';
  } catch {
    return 'en';
  }
}

export function getPrimaryConversationId(db: Db): Promise<string>;
export function getPrimaryConversationId(chat: ApplicationChatPersistence): Promise<string>;
export async function getPrimaryConversationId(
  source: Db | ApplicationChatPersistence,
): Promise<string> {
  if ('kind' in source && source.kind === 'application-chat-persistence') {
    const agent = await source.resolveAgent();
    return (await source.getOrCreatePrimaryConversation(agent.id)).id;
  }
  const agent = await getAgent(source as Db);
  return (await getOrCreatePrimaryConversation(source as Db, agent.id)).id;
}

export function getShellStatus(db: Db, agentId: string): Promise<ShellStatusProjection>;
export function getShellStatus(
  repository: ShellStatusRepository,
  agentId: string,
): Promise<ShellStatusProjection>;
export async function getShellStatus(
  source: Db | ShellStatusRepository,
  agentId: string,
): Promise<ShellStatusProjection> {
  if (isShellStatusRepository(source)) return source.load(agentId);
  const [dashboard, memoryHealth] = await Promise.all([
    getDashboardPresence(source as Db, agentId),
    getMemoryHealth(source as Db, agentId),
  ]);
  return { dashboard, memoryHealth };
}

export function getShellPresence(db: Db, agentId: string): Promise<ShellPresence>;
export function getShellPresence(
  repository: ShellPresenceRepository,
  agentId: string,
): Promise<ShellPresence>;
export async function getShellPresence(
  source: Db | ShellPresenceRepository,
  agentId: string,
): Promise<ShellPresence> {
  if (isShellPresenceRepository(source)) return source.load(agentId);
  return (await getDashboardPresence(source as Db, agentId)).presence;
}
