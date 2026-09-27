import { timingSafeEqual } from 'node:crypto';
import {
  ACTIVE_CALL_STATUSES,
  type CallCheckin,
  type CallSessionRepository,
} from '@assistant/persistence';
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { callSessions } from './schema.js';

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPostgresCallSessionRepository(db: Db): CallSessionRepository {
  const get = async (id: string) => {
    const [row] = await db.select().from(callSessions).where(eq(callSessions.id, id));
    return row ?? null;
  };
  return {
    kind: 'call-session-repository',
    async create(input) {
      const [row] = await db.insert(callSessions).values(input).returning();
      if (!row) throw new Error('Call session was not created');
      return row;
    },
    get,
    async getByCallSid(callSid) {
      const [row] = await db
        .select()
        .from(callSessions)
        .where(eq(callSessions.twilioCallSid, callSid));
      return row ?? null;
    },
    list: (agentId, limit) =>
      db
        .select()
        .from(callSessions)
        .where(eq(callSessions.agentId, agentId))
        .orderBy(desc(callSessions.createdAt))
        .limit(Math.max(1, Math.min(200, limit))),
    async countSince(agentId, since) {
      const [row] = await db
        .select({ n: count() })
        .from(callSessions)
        .where(and(eq(callSessions.agentId, agentId), gte(callSessions.createdAt, since)));
      return Number(row?.n ?? 0);
    },
    async activeCount(agentId) {
      const [row] = await db
        .select({ n: count() })
        .from(callSessions)
        .where(
          and(
            eq(callSessions.agentId, agentId),
            inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
          ),
        );
      return Number(row?.n ?? 0);
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return;
      await db
        .update(callSessions)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(callSessions.id, id));
    },
    async claimStream(id, tokenHash, now) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(
            and(
              eq(callSessions.id, id),
              isNotNull(callSessions.streamTokenHash),
              inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
            ),
          )
          .for('update');
        if (!row?.streamTokenHash || !hashesMatch(row.streamTokenHash, tokenHash)) return null;
        const [claimed] = await tx
          .update(callSessions)
          .set({
            streamTokenHash: null,
            status: 'in_progress',
            startedAt: now,
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id))
          .returning();
        return claimed ?? null;
      });
    },
    async finish(id, patch) {
      const [row] = await db
        .update(callSessions)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(eq(callSessions.id, id), inArray(callSessions.status, [...ACTIVE_CALL_STATUSES])),
        )
        .returning();
      return row ?? null;
    },
    async appendTranscript(id, lines) {
      if (lines.length === 0) return;
      await db
        .update(callSessions)
        .set({
          transcript: sql`${callSessions.transcript} || ${JSON.stringify(lines)}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(callSessions.id, id));
    },
    async appendNote(id, note) {
      await db
        .update(callSessions)
        .set({
          notes: sql`${callSessions.notes} || ${JSON.stringify([note.slice(0, 500)])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(callSessions.id, id));
    },
    async addCheckin(id, checkin) {
      await db
        .update(callSessions)
        .set({
          checkins: sql`${callSessions.checkins} || ${JSON.stringify([checkin])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(callSessions.id, id));
    },
    async answerCheckin(agentId, id, checkinId, answer, via) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(and(eq(callSessions.id, id), eq(callSessions.agentId, agentId)))
          .for('update');
        const checkins = (row?.checkins as CallCheckin[] | undefined) ?? [];
        const target = checkins.find((checkin) => checkin.id === checkinId);
        if (!row || !target || target.answer !== null) return false;
        const answeredAt = new Date().toISOString();
        await tx
          .update(callSessions)
          .set({
            checkins: checkins.map((checkin) =>
              checkin.id === checkinId
                ? { ...checkin, answer: answer.slice(0, 1_000), answeredAt, via }
                : checkin,
            ),
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id));
        return true;
      });
    },
    async requestHangup(agentId, id) {
      const rows = await db
        .update(callSessions)
        .set({ hangupRequested: true, updatedAt: sql`now()` })
        .where(
          and(
            eq(callSessions.id, id),
            eq(callSessions.agentId, agentId),
            inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
          ),
        )
        .returning({ id: callSessions.id });
      return rows.length === 1;
    },
  };
}
