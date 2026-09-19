import type { WatchCreateInput, WatchRepository } from '@assistant/persistence';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, watches, watchFires } from './schema.js';

export function createPostgresWatchRepository(db: Db): WatchRepository {
  return {
    kind: 'watch-repository',
    async create(input: WatchCreateInput) {
      return db.transaction(async (tx) => {
        let conversationId = input.conversationId ?? null;
        if (conversationId) {
          const [conversation] = await tx
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          if (!conversation || conversation.agentId !== input.agentId)
            throw new Error('watch chat does not belong to this agent');
        } else {
          const [conversation] = await tx
            .insert(conversations)
            .values({
              agentId: input.agentId,
              channel: 'chat',
              trust: 'owner',
              title: `Watch: ${input.name}`.slice(0, 80),
            })
            .returning({ id: conversations.id });
          if (!conversation) throw new Error('failed to create watch chat');
          conversationId = conversation.id;
        }
        const [row] = await tx
          .insert(watches)
          .values({ ...input, conversationId, state: input.state ?? {} })
          .returning();
        if (!row) throw new Error('failed to create watch');
        return row;
      });
    },
    list: (agentId, status, limit = 100) =>
      db
        .select()
        .from(watches)
        .where(
          status
            ? and(eq(watches.agentId, agentId), eq(watches.status, status))
            : eq(watches.agentId, agentId),
        )
        .orderBy(desc(watches.createdAt))
        .limit(limit),
    async cancel(agentId, watchId, now) {
      const [cancelled] = await db
        .update(watches)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(eq(watches.id, watchId), eq(watches.agentId, agentId), eq(watches.status, 'active')),
        )
        .returning({ status: watches.status });
      if (cancelled) return { status: cancelled.status, cancelled: true };
      const [current] = await db
        .select({ status: watches.status })
        .from(watches)
        .where(and(eq(watches.id, watchId), eq(watches.agentId, agentId)))
        .limit(1);
      return current ? { status: current.status, cancelled: false } : null;
    },
    async expire(agentId, now) {
      const rows = await db
        .update(watches)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            agentId ? eq(watches.agentId, agentId) : undefined,
            eq(watches.status, 'active'),
            lte(watches.expiresAt, now),
          ),
        )
        .returning({ id: watches.id });
      return rows.length;
    },
    emailCandidates: (agentId, now) =>
      db
        .select()
        .from(watches)
        .where(
          and(
            eq(watches.agentId, agentId),
            eq(watches.status, 'active'),
            eq(watches.kind, 'email'),
            gt(watches.expiresAt, now),
          ),
        ),
    async claimDueWeb(now, batch, defaultIntervalSeconds) {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: watches.id })
          .from(watches)
          .where(
            and(
              eq(watches.status, 'active'),
              eq(watches.kind, 'web'),
              gt(watches.expiresAt, now),
              lte(watches.nextPollAt, now),
            ),
          )
          .orderBy(asc(watches.nextPollAt))
          .limit(batch)
          .for('update', { skipLocked: true });
        if (!due.length) return [];
        return tx
          .update(watches)
          .set({
            nextPollAt: sql`${now.toISOString()}::timestamptz + make_interval(secs => coalesce(${watches.pollIntervalSeconds}, ${defaultIntervalSeconds}))`,
            updatedAt: now,
          })
          .where(
            inArray(
              watches.id,
              due.map((row) => row.id),
            ),
          )
          .returning();
      });
    },
    async updateWeb(input) {
      const [row] = await db
        .update(watches)
        .set({
          state: input.state,
          status: input.expire ? 'expired' : undefined,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(watches.id, input.watchId),
            eq(watches.status, 'active'),
            eq(watches.nextPollAt, input.expectedNextPollAt),
          ),
        )
        .returning({ id: watches.id });
      return Boolean(row);
    },
    async recordFire(input) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.watchId}))`);
        const [watch] = await tx
          .select()
          .from(watches)
          .where(and(eq(watches.id, input.watchId), eq(watches.agentId, input.agentId)))
          .limit(1);
        if (!watch) return { recorded: false, watch: null };
        if (
          watch.status !== 'active' ||
          watch.expiresAt <= input.now ||
          (input.expectedNextPollAt &&
            watch.nextPollAt?.getTime() !== input.expectedNextPollAt.getTime()) ||
          (watch.maxFires != null && watch.fireCount >= watch.maxFires)
        )
          return { recorded: false, watch };
        const [fire] = await tx
          .insert(watchFires)
          .values({
            watchId: watch.id,
            agentId: input.agentId,
            triggerRef: input.triggerRef,
            summary: input.summary,
            excerpt: input.excerpt.slice(0, 2048),
          })
          .onConflictDoNothing({ target: [watchFires.watchId, watchFires.triggerRef] })
          .returning({ id: watchFires.id });
        if (!fire) {
          if (input.state !== undefined)
            await tx
              .update(watches)
              .set({ state: input.state, updatedAt: input.now })
              .where(eq(watches.id, watch.id));
          return { recorded: false, watch };
        }
        const fireCount = watch.fireCount + 1;
        const [updated] = await tx
          .update(watches)
          .set({
            fireCount,
            lastFiredAt: input.now,
            updatedAt: input.now,
            state: input.state,
            status: watch.maxFires != null && fireCount >= watch.maxFires ? 'fired' : 'active',
          })
          .where(eq(watches.id, watch.id))
          .returning();
        return { recorded: true, watch: updated ?? watch };
      });
    },
  };
}
