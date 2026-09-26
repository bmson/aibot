import type { EmailSyncRepository } from '@assistant/persistence';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  channelBindings,
  contacts,
  conversations,
  emailIngest,
  gmailSyncState,
  messages,
  tasks,
} from './schema.js';

/** Gmail sync's PostgreSQL state, with the queries the sync loop has always run. */
export function createPostgresEmailSyncRepository(db: Db): EmailSyncRepository {
  return {
    kind: 'email-sync-repository',
    async mailbox() {
      const [agent] = await db.select({ id: agents.id, email: agents.email }).from(agents).limit(1);
      if (!agent) throw new Error('no agent row');
      return { agentId: agent.id, email: agent.email };
    },
    async contactTrust() {
      const rows = await db
        .select({ emails: contacts.emails, trust: contacts.trust })
        .from(contacts);
      return rows.flatMap((contact) =>
        contact.trust === 'owner' || contact.trust === 'known'
          ? contact.emails.map((email) => ({
              email: email.toLowerCase(),
              trust: contact.trust as 'owner' | 'known',
            }))
          : [],
      );
    },
    async syncState(mailbox) {
      const [state] = await db
        .select()
        .from(gmailSyncState)
        .where(eq(gmailSyncState.mailbox, mailbox));
      return state ? { lastHistoryId: state.lastHistoryId, cursor: state.cursor } : null;
    },
    async raiseBaseline(mailbox, historyId) {
      await db
        .insert(gmailSyncState)
        .values({ mailbox, lastHistoryId: historyId })
        .onConflictDoUpdate({
          target: gmailSyncState.mailbox,
          set: {
            lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${historyId})`,
            updatedAt: new Date(),
          },
        });
    },
    async saveCursor(mailbox, cursor) {
      await db
        .update(gmailSyncState)
        .set({ cursor, updatedAt: new Date() })
        .where(eq(gmailSyncState.mailbox, mailbox));
    },
    async completeDrain(mailbox, targetHistoryId) {
      await db
        .update(gmailSyncState)
        .set({
          lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${targetHistoryId})`,
          cursor: {},
          updatedAt: new Date(),
        })
        .where(eq(gmailSyncState.mailbox, mailbox));
    },
    async setWatchExpiration(mailbox, expiration) {
      await db
        .insert(gmailSyncState)
        .values({ mailbox, watchExpiration: expiration })
        .onConflictDoUpdate({
          target: gmailSyncState.mailbox,
          set: { watchExpiration: expiration, updatedAt: new Date() },
        });
    },
    async withLock(run) {
      // A session advisory lock on one reserved connection: two scaled
      // instances never both pay to classify the same unpersisted message.
      const connection = await db.$client.reserve();
      let acquired = false;
      try {
        const [row] = await connection<[{ acquired: boolean }]>`
          select pg_try_advisory_lock(hashtext('assistant:gmail-sync')) as acquired
        `;
        acquired = row?.acquired === true;
        if (!acquired) return null;
        return { value: await run() };
      } finally {
        if (acquired) {
          await connection`select pg_advisory_unlock(hashtext('assistant:gmail-sync'))`.catch(
            (error) => console.error('email-sync: failed to release advisory lock', error),
          );
        }
        connection.release();
      }
    },
    async inboundMessage(channelMessageId) {
      const [existing] = await db
        .select({ conversationId: messages.conversationId, origin: messages.origin })
        .from(messages)
        .where(eq(messages.channelMessageId, channelMessageId))
        .limit(1);
      return existing ?? null;
    },
    async hasTaskForEvent(externalEventId) {
      const [existing] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, externalEventId))
        .limit(1);
      return Boolean(existing);
    },
    async conversationForThread(agentId, threadId, trust, subject) {
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(and(eq(channelBindings.channel, 'email'), eq(channelBindings.externalId, threadId)));
      if (binding) return binding.conversationId;
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId, channel: 'email', trust, title: subject.slice(0, 80) || '(no subject)' })
        .returning();
      if (!conversation) throw new Error('failed to create email conversation');
      await db
        .insert(channelBindings)
        .values({ conversationId: conversation.id, channel: 'email', externalId: threadId })
        .onConflictDoNothing();
      return conversation.id;
    },
    async ingestRecord(channelMessageId) {
      const [recorded] = await db
        .select({
          id: emailIngest.id,
          conversationId: emailIngest.conversationId,
          importance: emailIngest.importance,
          category: emailIngest.category,
          contentTrust: emailIngest.contentTrust,
          triaged: emailIngest.triaged,
        })
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId))
        .limit(1);
      return recorded ?? null;
    },
    async recordIngest(row) {
      const [ingested] = await db
        .insert(emailIngest)
        .values(row)
        .onConflictDoNothing({ target: emailIngest.channelMessageId })
        .returning({ id: emailIngest.id });
      return ingested?.id ?? null;
    },
    async triagedSince(since) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(emailIngest)
        .where(and(eq(emailIngest.triaged, true), gte(emailIngest.createdAt, since)));
      return Number(row?.n ?? 0);
    },
    async markTriaged(ingestId, now) {
      await db
        .update(emailIngest)
        .set({ triaged: true, updatedAt: now })
        .where(eq(emailIngest.id, ingestId));
    },
  };
}
