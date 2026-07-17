import { createDb, type Db, schedules, tasks } from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { Plan } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import { claimTask, enqueueTask, taskState } from './machine.js';
import { parseIntervalMs, type Reflection, startMission, wakeMission } from './missions.js';
import { nextRun, runDueSchedules } from './schedules.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let agentTimezone = 'America/Los_Angeles';
const cleanupTaskIds: string[] = [];

function reflectingRouter(reflection: Reflection) {
  return {
    async object() {
      return { ok: true, modelId: 'fake', degraded: false, object: reflection };
    },
  } as unknown as ModelRouter;
}

const basePlan: Plan = {
  action: 'mission',
  reasoning: 'Watch mortgage rates',
  steps: ['check rates', 'compare offers'],
  missingInfo: [],
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const agent = await getAgent(db);
    agentId = agent.id;
    agentTimezone = agent.timezone;
    dbUp = true;
  } catch {
    console.warn('missions.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (cleanupTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.parentTaskId, cleanupTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, cleanupTaskIds));
    }
    await db.delete(schedules).where(like(schedules.name, 'test-%'));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function makeSourceTask() {
  const { task } = await enqueueTask(db, {
    event: { source: 'internal', agentId, trust: 'owner', payload: {} },
    type: 'adhoc',
  });
  cleanupTaskIds.push(task.id);
  return task;
}

describe('missions (integration, scripted model)', () => {
  it('startMission creates a first-class mission with deadline, budget cap, and reflect cadence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(
      db,
      source,
      { ...basePlan, budgetSuggestionUsd: 50 }, // over the cap
      'Watch mortgage rates for 3 months',
    );
    cleanupTaskIds.push(mission.id);

    expect(mission.type).toBe('mission');
    expect(Number(mission.budgetUsdLimit)).toBeLessThanOrEqual(5); // capped
    expect(mission.deadline).toBeTruthy();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(row?.reflectEvery).toBeTruthy();
    expect(row?.nextAction).toBe('check rates');
  });

  it('a wake spawns a fresh session child seeded from mission state, then sleeps the mission', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Watch rates');
    cleanupTaskIds.push(mission.id);
    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();

    const agent = await getAgent(db);
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('sessioned');
    if (wake.action !== 'sessioned') return;

    const [session] = await db.select().from(tasks).where(eq(tasks.id, wake.sessionTaskId));
    expect(session?.parentTaskId).toBe(mission.id);
    expect(session?.status).toBe('pending');
    const trigger = (session?.trigger ?? {}) as { payload?: { instruction?: string } };
    const payload = trigger.payload;
    expect(payload?.instruction).toContain('Watch rates');
    expect(payload?.instruction).toContain('mission.update');

    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('sleeping');
    expect(after?.runAfter?.getTime()).toBeGreaterThan(Date.now());
    expect(taskState(after as NonNullable<typeof after>).step).toBe(1);
  });

  it('deadline reached → final report and done', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const source = await makeSourceTask();
    const mission = await startMission(db, source, basePlan, 'Short mission');
    cleanupTaskIds.push(mission.id);
    await db
      .update(tasks)
      .set({ deadline: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, mission.id));
    const claimed = await claimTask(db, mission.id);
    expect(claimed).not.toBeNull();

    const agent = await getAgent(db);
    const wake = await wakeMission(
      { db, router: reflectingRouter({ decision: 'continue', reasoning: '' }) },
      claimed as NonNullable<typeof claimed>,
      agent,
    );
    expect(wake.action).toBe('deadline_reached');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
    expect(after?.status).toBe('done');
  });

  it('reflection due → applies the decision (escalate → needs_attention; abandon → cancelled)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);

    for (const [decision, expectedStatus] of [
      ['escalate', 'needs_attention'],
      ['abandon', 'cancelled'],
    ] as const) {
      const source = await makeSourceTask();
      const mission = await startMission(db, source, basePlan, `Reflect ${decision}`);
      cleanupTaskIds.push(mission.id);
      await db
        .update(tasks)
        .set({ lastReflectedAt: new Date(Date.now() - 8 * 24 * 3600e3) }) // > 7 days ago
        .where(eq(tasks.id, mission.id));
      const claimed = await claimTask(db, mission.id);
      expect(claimed).not.toBeNull();

      const wake = await wakeMission(
        { db, router: reflectingRouter({ decision, reasoning: 'test', progressPercent: 40 }) },
        claimed as NonNullable<typeof claimed>,
        agent,
      );
      expect(wake.action).toBe('reflected');
      const [after] = await db.select().from(tasks).where(eq(tasks.id, mission.id));
      expect(after?.status).toBe(expectedStatus);
      expect(after?.progressPercent).toBe(40);
      expect(after?.lastReflectedAt).toBeTruthy();
    }
  });
});

describe('schedules (integration)', () => {
  it('nextRun computes a future firing in the agent timezone', () => {
    const next = nextRun('30 7 * * *', 'America/Los_Angeles');
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('due schedules fire exactly one task per firing and advance next_run_at', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [schedule] = await db
      .insert(schedules)
      .values({
        agentId,
        name: `test-schedule-${Date.now()}`,
        cron: '*/5 * * * *',
        taskTemplate: { type: 'scheduled', instruction: 'test tick' },
        enabled: true,
        nextRunAt: new Date(Date.now() - 60_000), // already due
      })
      .returning();

    const fired = await runDueSchedules(db, agentTimezone);
    const mine = fired.filter((f) => f.schedule === schedule?.name);
    expect(mine).toHaveLength(1);
    cleanupTaskIds.push(...mine.map((m) => m.taskId));

    // second tick: not due anymore, no duplicate
    const again = await runDueSchedules(db, agentTimezone);
    expect(again.filter((f) => f.schedule === schedule?.name)).toHaveLength(0);

    const [after] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, (schedule as NonNullable<typeof schedule>).id));
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(after?.lastRunAt).toBeTruthy();
  });
});

describe('parseIntervalMs', () => {
  it('parses day and time intervals', () => {
    expect(parseIntervalMs('7 days')).toBe(7 * 24 * 3600e3);
    expect(parseIntervalMs('1 day')).toBe(24 * 3600e3);
    expect(parseIntervalMs('02:30:00')).toBe(2.5 * 3600e3);
    expect(parseIntervalMs(null)).toBeNull();
  });
});
