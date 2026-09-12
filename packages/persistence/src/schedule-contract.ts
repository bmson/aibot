import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReminderRepository } from './contracts.js';
import type { Records } from './records.js';
import type { ScheduleOccurrence, ScheduleRecord, ScheduleRepository } from './schedules.js';
import type { TaskRepository } from './task-lifecycle.js';

export interface ScheduleFixture {
  agentId: string;
  conversationId: string;
  repository: ScheduleRepository;
  reminders: ReminderRepository;
  tasks: TaskRepository;
  readSchedule(id: string): Promise<Records['schedules']>;
  patchSchedule(id: string, patch: Partial<Records['schedules']>): Promise<void>;
  listTasks(scheduleId: string): Promise<Records['tasks'][]>;
  /** Firestore only: count durable intents belonging to this schedule's task IDs. */
  outboxCount?: (scheduleId: string) => Promise<number>;
  dispose(): Promise<void>;
}

export function scheduleContract(
  name: string,
  fixture: () => Promise<ScheduleFixture>,
  skip = false,
) {
  describe.skipIf(skip)(name, () => {
    let f: ScheduleFixture;
    const now = new Date('2025-06-01T12:00:00Z');
    const due = new Date(now.getTime() - 60_000);
    const next = new Date(now.getTime() + 60_000);
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.dispose();
    });
    const create = (patch: Partial<Parameters<ScheduleRepository['ensure']>[0]> = {}) =>
      f.repository.ensure({
        agentId: f.agentId,
        name: `reminder:${randomUUID()}`,
        cron: '* * * * *',
        taskTemplate: {
          reminderKind: 'recurring',
          reminderText: 'contract',
          conversationId: f.conversationId,
        },
        nextRunAt: due,
        ...patch,
      });
    const occurrence = (
      row: ScheduleRecord,
      patch: Partial<ScheduleOccurrence> = {},
    ): ScheduleOccurrence => {
      const event = `schedule:${row.id}:${row.nextRunAt?.toISOString()}`;
      return {
        expected: row,
        now,
        mode: 'due',
        nextRunAt: next,
        enabled: true,
        task: {
          agentId: f.agentId,
          conversationId: f.conversationId,
          type: 'scheduled',
          trust: 'assistant',
          externalEventId: event,
          trigger: { source: 'schedule', payload: { scheduleId: row.id, occurrenceId: event } },
        },
        ...patch,
      };
    };
    it('creates one schedule under concurrent ensure without overwriting existing settings', async () => {
      const name = `reminder:${randomUUID()}`;
      const [a, b] = await Promise.all([create({ name }), create({ name })]);
      expect(a.id).toBe(b.id);
      expect(await f.repository.getByName(f.agentId, name)).toEqual(a);
      expect(await create({ name, enabled: false, nextRunAt: next })).toEqual(a);
      expect(await f.repository.getByName(randomUUID(), name)).toBeNull();
    }, 30_000);
    it('commits one task and one advancement under concurrent firing and stale replay', async () => {
      const row = await create();
      const input = occurrence(row);
      const results = await Promise.all([
        f.repository.commitOccurrence(input),
        f.repository.commitOccurrence(input),
      ]);
      expect(results.filter((result) => result?.task?.created)).toHaveLength(1);
      expect(await f.repository.commitOccurrence(input)).toBeNull();
      expect(await f.listTasks(row.id)).toHaveLength(1);
      expect(await f.readSchedule(row.id)).toMatchObject({
        enabled: true,
        lastRunAt: now,
        nextRunAt: next,
      });
      if (f.outboxCount) expect(await f.outboxCount(row.id)).toBe(1);
    }, 30_000);
    it('does not fire early and returns bounded deterministically ordered due pages', async () => {
      const first = await create({ nextRunAt: new Date(due.getTime() - 60_000) });
      const second = await create();
      const future = await create({ nextRunAt: next });
      await create({ enabled: false });
      const rows = await f.repository.listDue(now, 2);
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(await f.repository.commitOccurrence(occurrence(future))).toBeNull();
      await expect(f.repository.listDue(now, 201)).rejects.toThrow('batch');
    });
    it('rechecks edits as well as enabled state even when timestamps do not change', async () => {
      const row = await create();
      await f.patchSchedule(row.id, {
        taskTemplate: { reminderKind: 'recurring', reminderText: 'edited' },
      });
      expect(await f.repository.commitOccurrence(occurrence(row))).toBeNull();
      expect(await f.listTasks(row.id)).toHaveLength(0);
      const current = await f.readSchedule(row.id);
      await f.patchSchedule(row.id, { enabled: false });
      expect(await f.repository.commitOccurrence(occurrence(current))).toBeNull();
    });
    it('serializes reminder cancellation against task creation', async () => {
      const row = await create();
      const [cancelled] = await Promise.all([
        f.reminders.cancel(f.agentId, row.id, now),
        f.repository.commitOccurrence(occurrence(row)),
      ]);
      expect(cancelled.cancelled).toBe(true);
      expect(await f.repository.commitOccurrence(occurrence(row))).toBeNull();
      expect(await f.readSchedule(row.id)).toMatchObject({ enabled: false, nextRunAt: null });
      for (const task of await f.listTasks(row.id)) {
        expect(task.status).toBe('cancelled');
        expect(await f.tasks.claim(task.id, task.queueGeneration)).toBeNull();
      }
    }, 30_000);
    it('one-time firing disables scheduling while its queued delivery remains claimable once', async () => {
      const row = await create({ taskTemplate: { reminderKind: 'once', reminderText: 'once' } });
      const result = await f.repository.commitOccurrence(
        occurrence(row, { enabled: false, nextRunAt: null }),
      );
      expect(result?.task?.created).toBe(true);
      expect(
        await f.repository.commitOccurrence(occurrence(row, { enabled: false, nextRunAt: null })),
      ).toBeNull();
      const [task] = await f.listTasks(row.id);
      if (!task) throw new Error('Missing occurrence task');
      expect(await f.tasks.claim(task.id, 0)).not.toBeNull();
      expect(await f.tasks.claim(task.id, 0)).toBeNull();
    });
    it('initialization loses to cancellation and never overwrites an already initialized row', async () => {
      const row = await create({ nextRunAt: null });
      expect(
        (await f.repository.listUninitialized(200)).some((candidate) => candidate.id === row.id),
      ).toBe(true);
      expect(await f.repository.initialize(row, next, now)).toBe(true);
      expect(await f.repository.initialize(row, new Date(next.getTime() + 60_000), now)).toBe(
        false,
      );
      const cancelled = await create({ nextRunAt: null });
      await f.reminders.cancel(f.agentId, cancelled.id, now);
      expect(await f.repository.initialize(cancelled, next, now)).toBe(false);
      expect((await f.readSchedule(cancelled.id)).nextRunAt).toBeNull();
    });
    it('rejects invalid task input without advancing the schedule or retaining an intent', async () => {
      const row = await create();
      const request = occurrence(row);
      if (!request.task) throw new Error('Missing task input');
      await expect(
        f.repository.commitOccurrence({
          ...request,
          task: { ...request.task, budgetUsdLimit: '10000' },
        }),
      ).rejects.toThrow();
      expect(await f.readSchedule(row.id)).toEqual(row);
      expect(await f.listTasks(row.id)).toHaveLength(0);
      if (f.outboxCount) expect(await f.outboxCount(row.id)).toBe(0);
      expect((await f.repository.commitOccurrence(request))?.task?.created).toBe(true);
    });
    it('binds the task to the exact owner, schedule and occurrence', async () => {
      const row = await create();
      const request = occurrence(row);
      if (!request.task) throw new Error('Missing task input');
      for (const patch of [
        { agentId: randomUUID() },
        { externalEventId: `schedule:${row.id}:wrong` },
        { trigger: { source: 'schedule', payload: { scheduleId: row.id, occurrenceId: 'wrong' } } },
      ])
        await expect(
          f.repository.commitOccurrence({ ...request, task: { ...request.task, ...patch } }),
        ).rejects.toThrow('does not belong');
      expect(await f.listTasks(row.id)).toHaveLength(0);
      expect(await f.readSchedule(row.id)).toEqual(row);
    });
    it('early and due firings cannot both advance the same snapshot', async () => {
      const row = await create();
      const request = occurrence(row);
      if (!request.task) throw new Error('Missing task input');
      const earlyEvent = `schedule:${row.id}:wake:2025-06-01`;
      const results = await Promise.all([
        f.repository.commitOccurrence(request),
        f.repository.commitOccurrence({
          ...request,
          mode: 'early',
          task: {
            ...request.task,
            externalEventId: earlyEvent,
            trigger: {
              source: 'schedule',
              payload: { scheduleId: row.id, occurrenceId: earlyEvent },
            },
          },
        }),
      ]);
      expect(results.filter((result) => result?.task?.created)).toHaveLength(1);
      expect(await f.listTasks(row.id)).toHaveLength(1);
      if (f.outboxCount) expect(await f.outboxCount(row.id)).toBe(1);
    }, 30_000);
  });
}
