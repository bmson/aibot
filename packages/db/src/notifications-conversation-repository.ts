import type { NotificationsConversationRepository } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations } from './schema.js';

/**
 * Nothing in the schema makes the Notifications conversation unique, so first
 * uses serialize on a per-owner advisory lock. The key is the one the watch
 * suggestion commit takes before it creates the same conversation.
 */
export function createPostgresNotificationsConversationRepository(
  db: Db,
): NotificationsConversationRepository {
  return {
    kind: 'notifications-conversation-repository',
    getOrCreate: (agentId) =>
      db.transaction(async (tx) => {
        const lock = `watch-notifications:${agentId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
        const [existing] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')))
          .limit(1);
        if (existing) return existing.id;
        const [created] = await tx
          .insert(conversations)
          .values({
            agentId,
            channel: 'chat',
            trust: 'assistant',
            title: 'Notifications',
          })
          .returning({ id: conversations.id });
        if (!created) throw new Error('failed to create Notifications conversation');
        return created.id;
      }),
  };
}
