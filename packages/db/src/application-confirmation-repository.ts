import type {
  ApplicationConfirmationRecord,
  ApplicationConfirmationRepository,
} from '@assistant/persistence';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { applicationConfirmations, conversations, toolCalls } from './schema.js';

/** Application confirmation watches with the queries the tools and email match always ran. */
export function createPostgresApplicationConfirmationRepository(
  db: Db,
): ApplicationConfirmationRepository {
  const byId = async (id: string) => {
    const [record] = await db
      .select()
      .from(applicationConfirmations)
      .where(eq(applicationConfirmations.id, id));
    return (record as ApplicationConfirmationRecord | undefined) ?? null;
  };
  return {
    kind: 'application-confirmation-repository',
    async createWatch(input) {
      const [existing] = await db
        .select({ id: applicationConfirmations.id })
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, input.agentId),
            eq(applicationConfirmations.confirmationTokenHash, input.confirmationTokenHash),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
          ),
        )
        .limit(1);
      if (existing) throw new Error('an active confirmation watch already uses this token');
      let conversationId = input.conversationId;
      if (!conversationId) {
        const [conversation] = await db
          .insert(conversations)
          .values({
            agentId: input.agentId,
            channel: 'chat',
            trust: 'owner',
            title: input.newConversationTitle,
          })
          .returning({ id: conversations.id });
        if (!conversation) throw new Error('failed to create application follow-up chat');
        conversationId = conversation.id;
      }
      const [record] = await db
        .insert(applicationConfirmations)
        .values({
          agentId: input.agentId,
          sourceTaskId: input.sourceTaskId,
          conversationId,
          company: input.company,
          role: input.role,
          expectedSenderEmails: input.expectedSenderEmails,
          confirmationTokenHash: input.confirmationTokenHash,
          confirmationTokenHint: input.confirmationTokenHint,
          trackerUpdate: input.trackerUpdate,
          documentUpdate: input.documentUpdate,
          actionState: input.actionState,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!record) throw new Error('failed to create application confirmation watch');
      return record as ApplicationConfirmationRecord;
    },
    async list(agentId, status) {
      const rows = await db
        .select()
        .from(applicationConfirmations)
        .where(
          status
            ? and(
                eq(applicationConfirmations.agentId, agentId),
                eq(applicationConfirmations.status, status),
              )
            : eq(applicationConfirmations.agentId, agentId),
        )
        .orderBy(desc(applicationConfirmations.createdAt))
        .limit(100);
      return rows as ApplicationConfirmationRecord[];
    },
    async cancel(agentId, id, now) {
      const [cancelled] = await db
        .update(applicationConfirmations)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(applicationConfirmations.id, id),
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
          ),
        )
        .returning({ id: applicationConfirmations.id });
      if (cancelled) return { id: cancelled.id, status: 'cancelled', cancelled: true };
      const [current] = await db
        .select({ id: applicationConfirmations.id, status: applicationConfirmations.status })
        .from(applicationConfirmations)
        .where(
          and(eq(applicationConfirmations.id, id), eq(applicationConfirmations.agentId, agentId)),
        );
      return current ? { id: current.id, status: current.status, cancelled: false } : null;
    },
    get: byId,
    async updateActionState(id, input) {
      const [updated] = await db
        .update(applicationConfirmations)
        .set({
          actionState: input.actionState,
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
          ...(input.status ? { status: input.status } : {}),
          updatedAt: input.now,
        })
        .where(
          input.requireStatus
            ? and(
                eq(applicationConfirmations.id, id),
                eq(applicationConfirmations.status, input.requireStatus),
              )
            : eq(applicationConfirmations.id, id),
        )
        .returning();
      return (updated as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async expireDue(now, agentId) {
      const expired = await db
        .update(applicationConfirmations)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            ...(agentId ? [eq(applicationConfirmations.agentId, agentId)] : []),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            lte(applicationConfirmations.expiresAt, now),
          ),
        )
        .returning();
      return expired as ApplicationConfirmationRecord[];
    },
    async byConfirmationMessage(agentId, confirmationMessageId) {
      const [record] = await db
        .select()
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.confirmationMessageId, confirmationMessageId),
          ),
        );
      return (record as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async awaitingFrom(agentId, from, now) {
      const rows = await db
        .select()
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            gt(applicationConfirmations.expiresAt, now),
            sql`${from} = ANY(${applicationConfirmations.expectedSenderEmails})`,
          ),
        );
      return rows as ApplicationConfirmationRecord[];
    },
    async claim(id, input) {
      const [claimed] = await db
        .update(applicationConfirmations)
        .set({
          status: 'confirmation_received',
          confirmationMessageId: input.confirmationMessageId,
          confirmationFrom: input.confirmationFrom,
          confirmedAt: input.now,
          lastError: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(applicationConfirmations.id, id),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            gt(applicationConfirmations.expiresAt, input.now),
          ),
        )
        .returning();
      return (claimed as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async toolCallStatus(idempotencyKey) {
      const [prior] = await db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, idempotencyKey));
      return prior?.status ?? null;
    },
    async settleExecutingToolCall(taskId, toolName, result, now) {
      await db
        .update(toolCalls)
        .set({ status: 'succeeded', result, finishedAt: now })
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            eq(toolCalls.toolName, toolName),
            eq(toolCalls.status, 'executing'),
          ),
        );
    },
  };
}
