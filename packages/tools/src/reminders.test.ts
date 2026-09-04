import { getAgent, runDueSchedules } from '@assistant/core';
import { createDb, type Db, schedules, tasks } from '@assistant/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import { registerReminderTools } from './reminders.js';
import type { ToolContext } from './types.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('reminder tools', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const firedTaskIds: string[] = [];
  const registry = new ToolRegistry();
  registerReminderTools(registry);
  const tool = (name: string) => registry.get(name)?.tool;

  function ctx(conversationId?: string): ToolContext {
    return {
      taskId: 'task-x',
      agentId,
      conversationId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('reminders.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (firedTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, firedTaskIds));
    await db
      .delete(schedules)
      .where(and(eq(schedules.agentId, agentId), like(schedules.name, 'reminder:%')));
  });

  it('builds a weekday cron from a time + weekday list', async () => {
    if (!dbUp) return;
    const result = (await tool('reminder.create')?.execute(
      { text: 'review approvals', time: '09:00', weekdays: [1, 3, 5] },
      ctx(),
    )) as { cron: string; reminderId: string; text: string };
    expect(result.cron).toBe('0 9 * * 1,3,5');
    const [row] = await db.select().from(schedules).where(eq(schedules.id, result.reminderId));
    expect(row?.name.startsWith('reminder:')).toBe(true);
    expect((row?.taskTemplate as { reminderText?: string })?.reminderText).toBe('review approvals');
    expect((row?.taskTemplate as { type?: string })?.type).toBe('scheduled');
  });

  it('defaults to a daily cron when no weekdays are given', async () => {
    if (!dbUp) return;
    const result = (await tool('reminder.create')?.execute(
      { text: 'stand up', time: '08:30' },
      ctx(),
    )) as { cron: string };
    expect(result.cron).toBe('30 8 * * *');
  });

  it('accepts a raw cron and rejects an invalid one', async () => {
    if (!dbUp) return;
    const ok = (await tool('reminder.create')?.execute(
      { text: 'monthly', cron: '0 9 1 * *' },
      ctx(),
    )) as { cron: string };
    expect(ok.cron).toBe('0 9 1 * *');
    await expect(
      tool('reminder.create')?.execute({ text: 'bad', cron: 'not a cron' }, ctx()),
    ).rejects.toBeTruthy();
  });

  it('creates an exact one-time reminder and disables it after one enqueue', async () => {
    if (!dbUp) return;
    const firesAt = new Date(Date.now() + 60 * 60 * 1000);
    const created = (await tool('reminder.create')?.execute(
      { text: 'one time only', at: firesAt.toISOString() },
      ctx(),
    )) as { kind: string; reminderId: string };
    expect(created.kind).toBe('once');
    await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schedules.id, created.reminderId));

    const agent = await getAgent(db);
    const first = await runDueSchedules(db, agent.timezone);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.reminderId));
    const mine = first.find((f) => f.schedule === row?.name);
    expect(mine).toBeTruthy();
    if (mine) firedTaskIds.push(mine.taskId);
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();

    const second = await runDueSchedules(db, agent.timezone);
    expect(second.some((f) => f.schedule === row?.name)).toBe(false);
  });

  it('resolves a relative one-time reminder on the server clock', async () => {
    if (!dbUp) return;
    const now = new Date('2026-09-03T18:00:00.000Z');
    const result = (await tool('reminder.create')?.execute(
      { text: 'relative reminder', inMinutes: 10 },
      { ...ctx(), now: () => now },
    )) as { reminderId: string; kind: string; nextFires: string; timezone: string };
    expect(result.kind).toBe('once');
    expect(result.nextFires).toBe('2026-09-03T18:10:00.000Z');
    expect(result.timezone).toBe((await getAgent(db)).timezone);
  });

  it('lists active reminders and cancels one by id', async () => {
    if (!dbUp) return;
    const created = (await tool('reminder.create')?.execute(
      { text: 'cancel me', time: '10:00' },
      ctx(),
    )) as { reminderId: string };
    const listed = (await tool('reminder.list')?.execute({}, ctx())) as {
      reminders: Array<{ reminderId: string; text: string; enabled: boolean }>;
    };
    expect(listed.reminders.some((r) => r.reminderId === created.reminderId)).toBe(true);

    const cancelled = (await tool('reminder.cancel')?.execute(
      { reminderId: created.reminderId },
      ctx(),
    )) as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.reminderId));
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();
  });

  it('cancels a uniquely named reminder and reports ambiguous text', async () => {
    if (!dbUp) return;
    const sunglasses = (await tool('reminder.create')?.execute(
      { text: 'Get sunglasses from the car', time: '10:00' },
      ctx(),
    )) as { reminderId: string };
    await tool('reminder.create')?.execute({ text: 'Pack gym bag', time: '10:05' }, ctx());
    const cancelled = (await tool('reminder.cancel')?.execute(
      { query: 'sunglasses reminder' },
      ctx(),
    )) as { cancelled: boolean; reminderId?: string };
    expect(cancelled).toMatchObject({ cancelled: true, reminderId: sunglasses.reminderId });

    await tool('reminder.create')?.execute({ text: 'Buy sunglasses', time: '10:10' }, ctx());
    await tool('reminder.create')?.execute({ text: 'Clean sunglasses', time: '10:15' }, ctx());
    const ambiguous = (await tool('reminder.cancel')?.execute({ query: 'sunglasses' }, ctx())) as {
      cancelled: boolean;
      reason?: string;
      matches?: unknown[];
    };
    expect(ambiguous.cancelled).toBe(false);
    expect(ambiguous.reason).toBe('ambiguous');
    expect(ambiguous.matches).toHaveLength(2);
  });

  it('cancels a queued reminder delivery before a worker claims it', async () => {
    if (!dbUp) return;
    const created = (await tool('reminder.create')?.execute(
      { text: 'queued cancellation test', time: '10:20' },
      ctx(),
    )) as { reminderId: string };
    await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schedules.id, created.reminderId));
    const agent = await getAgent(db);
    const fired = await runDueSchedules(db, agent.timezone);
    const [schedule] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, created.reminderId));
    const queued = fired.find((item) => item.schedule === schedule?.name);
    expect(queued).toBeTruthy();
    if (!queued) return;
    firedTaskIds.push(queued.taskId);

    const result = (await tool('reminder.cancel')?.execute(
      { query: 'queued cancellation' },
      ctx(),
    )) as { cancelled: boolean; queuedTasksCancelled?: number };
    expect(result).toMatchObject({ cancelled: true, queuedTasksCancelled: 1 });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, queued.taskId));
    expect(task?.status).toBe('cancelled');
  });

  it('fires as a scheduled task via runDueSchedules', async () => {
    if (!dbUp) return;
    const created = (await tool('reminder.create')?.execute(
      { text: 'fire test', time: '09:00' },
      ctx(),
    )) as { reminderId: string };
    // Force it due.
    await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schedules.id, created.reminderId));
    const agent = await getAgent(db);
    const fired = await runDueSchedules(db, agent.timezone);
    const mine = fired.find((f) => f.schedule.startsWith('reminder:'));
    expect(mine).toBeTruthy();
    if (mine) {
      firedTaskIds.push(mine.taskId);
      const [task] = await db.select().from(tasks).where(eq(tasks.id, mine.taskId));
      expect(task?.type).toBe('scheduled');
      expect(
        (task?.trigger as { payload?: { instruction?: string } })?.payload?.instruction,
      ).toContain('fire test');
    }
  });
});
