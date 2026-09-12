import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { agents, createDb, schedules } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getSettingsOverview, setRecurringJobEnabled } from './settings.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('settings schedule ownership and projections', () => {
  const fixtures: Array<{
    db: ReturnType<typeof createDb>;
    scheduleIds: string[];
    agentIds: string[];
  }> = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      for (const id of fixture.scheduleIds)
        await fixture.db.delete(schedules).where(eq(schedules.id, id));
      for (const id of fixture.agentIds) await fixture.db.delete(agents).where(eq(agents.id, id));
      await fixture.db.$client.end();
    }
  });

  async function fixture() {
    const db = createDb(testDatabaseUrl());
    const owner = await getAgent(db);
    const otherId = randomUUID();
    await db.insert(agents).values({
      id: otherId,
      name: `settings-schedule-other-${otherId.slice(0, 8)}`,
      email: `${otherId}@settings-schedule.invalid`,
      workspacePrefix: `settings-schedule/${otherId}`,
    });
    const scheduleIds: string[] = [];
    async function schedule(agentId: string, name: string, enabled = true) {
      const id = randomUUID();
      await db.insert(schedules).values({
        id,
        agentId,
        name,
        cron: '* * * * *',
        taskTemplate: name.startsWith('reminder:')
          ? { reminderKind: 'recurring', reminderText: 'settings test' }
          : {},
        enabled,
        nextRunAt: new Date('2026-09-12T13:00:00.000Z'),
      });
      scheduleIds.push(id);
      return id;
    }
    const fixture = { db, scheduleIds, agentIds: [otherId], otherId, ownerId: owner.id, schedule };
    fixtures.push(fixture);
    return fixture;
  }

  it('scopes generic toggles and refuses reminder IDs', async () => {
    const f = await fixture();
    const owned = await f.schedule(f.ownerId, `settings-test:${randomUUID()}`);
    const reminder = await f.schedule(f.ownerId, `reminder:${randomUUID()}`);
    const foreign = await f.schedule(f.otherId, `settings-test:${randomUUID()}`);

    expect(await setRecurringJobEnabled(f.db, owned, false)).toBe(true);
    expect(
      (
        await f.db
          .select({ enabled: schedules.enabled })
          .from(schedules)
          .where(eq(schedules.id, owned))
      )[0]?.enabled,
    ).toBe(false);
    expect(await setRecurringJobEnabled(f.db, foreign, false)).toBe(false);
    expect(
      (
        await f.db
          .select({ enabled: schedules.enabled })
          .from(schedules)
          .where(eq(schedules.id, foreign))
      )[0]?.enabled,
    ).toBe(true);
    expect(await setRecurringJobEnabled(f.db, reminder, false)).toBe(false);
    expect(
      (
        await f.db
          .select({ enabled: schedules.enabled })
          .from(schedules)
          .where(eq(schedules.id, reminder))
      )[0]?.enabled,
    ).toBe(true);
  });

  it('keeps reminders out of generic schedule projection', async () => {
    const f = await fixture();
    const generic = await f.schedule(f.ownerId, `settings-test:${randomUUID()}`);
    const reminder = await f.schedule(f.ownerId, `reminder:${randomUUID()}`);
    const goal = await f.schedule(f.ownerId, `goal:settings-test-${randomUUID()}`);

    const overview = await getSettingsOverview(f.db);
    expect(overview.schedules.map((row) => row.id)).toContain(generic);
    expect(overview.schedules.map((row) => row.id)).not.toContain(reminder);
    expect(overview.reminders.map((row) => row.id)).toContain(reminder);
    expect(overview.goalAutomationCount).toBeGreaterThanOrEqual(1);
    expect(overview.schedules.map((row) => row.id)).not.toContain(goal);
  });
});
