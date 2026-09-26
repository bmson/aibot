import type { SmsChannelRepository } from '@assistant/persistence';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  approvals,
  channelBindings,
  conversations,
  costEvents,
  rateLimits,
  toolCalls,
} from './schema.js';

/** The SMS channel's PostgreSQL state, with the same queries the channel has always run. */
export function createPostgresSmsChannelRepository(db: Db): SmsChannelRepository {
  return {
    kind: 'sms-channel-repository',
    async underChannelLimit() {
      const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, 'channel:sms'));
      if (!limit) return true;
      const countSince = async (interval: string) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)` })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.source, 'twilio_sms'),
              gte(costEvents.createdAt, sql`now() - ${interval}::interval`),
            ),
          );
        return Number(row?.n ?? 0);
      };
      if (limit.maxPerHour !== null && (await countSince('1 hour')) >= limit.maxPerHour)
        return false;
      if (limit.maxPerDay !== null && (await countSince('1 day')) >= limit.maxPerDay) return false;
      return true;
    },
    async conversationForPeer(agentId, peer, trust) {
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(and(eq(channelBindings.channel, 'sms'), eq(channelBindings.externalId, peer)));
      if (binding) return binding.conversationId;
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId, channel: 'sms', trust, title: `SMS ${peer}` })
        .returning();
      if (!conversation) throw new Error('failed to create sms conversation');
      await db
        .insert(channelBindings)
        .values({ conversationId: conversation.id, channel: 'sms', externalId: peer })
        .onConflictDoNothing();
      return conversation.id;
    },
    async finalDestination(conversationId) {
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!conversation) return null;
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.conversationId, conversationId),
            eq(channelBindings.channel, 'sms'),
          ),
        );
      return {
        channel: conversation.channel,
        trust: conversation.trust,
        externalId: binding?.externalId ?? null,
      };
    },
    async pendingApprovalTool(shortCode) {
      const [pending] = await db
        .select({ toolName: toolCalls.toolName })
        .from(approvals)
        .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
        .where(and(eq(approvals.shortCode, shortCode), eq(approvals.status, 'pending')))
        .limit(1);
      return pending?.toolName ?? null;
    },
  };
}
