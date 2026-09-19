import {
  type HistoryRecallRepository,
  historyLimit,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversationSegments, conversations, messages } from './schema.js';

const messageFields = {
  id: messages.id,
  conversationId: messages.conversationId,
  role: messages.role,
  text: messages.text,
  createdAt: messages.createdAt,
};

export function createPostgresHistoryRecallRepository(db: Db): HistoryRecallRepository {
  const trusted = (agentId: string) =>
    and(eq(conversations.agentId, agentId), inArray(conversations.trust, ['owner', 'assistant']));
  return {
    kind: 'history-recall-repository',
    async segments({ agentId, embedding, exclude, limit }) {
      validateSkillEmbedding(embedding);
      const vector = JSON.stringify(embedding);
      const rows = await db
        .select({
          conversationId: conversationSegments.conversationId,
          summary: conversationSegments.summary,
          startMessageId: conversationSegments.startMessageId,
          startedAt: conversationSegments.startedAt,
          endedAt: conversationSegments.endedAt,
          similarity: sql<number>`1 - (${conversationSegments.embedding} <=> ${vector}::vector)`,
        })
        .from(conversationSegments)
        .innerJoin(conversations, eq(conversations.id, conversationSegments.conversationId))
        .where(
          and(
            trusted(agentId),
            eq(conversationSegments.agentId, agentId),
            isNotNull(conversationSegments.embedding),
            sql`length(${conversationSegments.summary}) > 0`,
            or(
              ne(conversationSegments.conversationId, exclude.conversationId),
              lt(conversationSegments.endedAt, exclude.sinceCreatedAt),
            ),
          ),
        )
        .orderBy(
          sql`${conversationSegments.embedding} <=> ${vector}::vector`,
          asc(conversationSegments.id),
        )
        .limit(historyLimit(limit));
      if (rows.length === 0) return [];
      const keys = await db
        .select(messageFields)
        .from(messages)
        .where(
          inArray(
            messages.id,
            rows.map((row) => row.startMessageId),
          ),
        );
      return rows.map((row) => ({
        ...row,
        keyMessage: keys.find(
          (key) => key.id === row.startMessageId && key.conversationId === row.conversationId,
        ),
      }));
    },
    async messages({ agentId, embedding, exclude, limit }) {
      validateSkillEmbedding(embedding);
      const vector = JSON.stringify(embedding);
      return db
        .select({
          ...messageFields,
          similarity: sql<number>`1 - (${messages.embedding} <=> ${vector}::vector)`,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            trusted(agentId),
            isNotNull(messages.embedding),
            inArray(messages.role, ['user', 'assistant']),
            sql`length(${messages.text}) > 0`,
            or(
              ne(messages.conversationId, exclude.conversationId),
              lt(messages.createdAt, exclude.sinceCreatedAt),
            ),
          ),
        )
        .orderBy(sql`${messages.embedding} <=> ${vector}::vector`, asc(messages.id))
        .limit(historyLimit(limit));
    },
    async neighborhood({ agentId, anchor, radius, exclude }) {
      if (!Number.isInteger(radius) || radius < 0 || radius > 20)
        throw new Error('Invalid history neighborhood radius');
      const eligible = and(
        trusted(agentId),
        eq(messages.conversationId, anchor.conversationId),
        inArray(messages.role, ['user', 'assistant']),
        anchor.conversationId === exclude.conversationId
          ? lt(messages.createdAt, exclude.sinceCreatedAt)
          : undefined,
      );
      const [current] = await db
        .select(messageFields)
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(and(eligible, eq(messages.id, anchor.id)))
        .limit(1);
      if (!current) return [];
      if (radius === 0) return [current];
      const [before, after] = await Promise.all([
        db
          .select(messageFields)
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(and(eligible, lt(messages.createdAt, current.createdAt)))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(radius),
        db
          .select(messageFields)
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(and(eligible, gt(messages.createdAt, current.createdAt)))
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(radius),
      ]);
      return [...before.reverse(), current, ...after];
    },
    async recentWindowStart({ agentId, conversationId, size }) {
      const rows = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            trusted(agentId),
            eq(messages.conversationId, conversationId),
            inArray(messages.role, ['user', 'assistant']),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(historyLimit(size));
      return rows.at(-1)?.createdAt ?? null;
    },
  };
}
