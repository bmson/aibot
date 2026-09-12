import { createHash, randomUUID } from 'node:crypto';
import {
  existingTaskResult,
  newTaskRecord,
  occurrenceIsCurrent,
  type Records,
  type ScheduleCommitResult,
  type ScheduleCreateInput,
  type ScheduleOccurrence,
  type ScheduleRecord,
  type ScheduleRepository,
  scheduleBatch,
  scheduleCanRun,
  scheduleMatches,
  scheduleTime,
  type TaskCreateResult,
  validateScheduleCreate,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/**
 * Schedule names are installation-local, but the name itself is not a safe
 * Firestore document ID. Keep the uniqueness fence in a separate collection
 * so a schedule can retain its UUID document ID.
 */
function scheduleNameKey(agentId: string, name: string): string {
  return createHash('sha256')
    .update(JSON.stringify([agentId, name]))
    .digest('hex');
}

function taskEventKey(eventId: string): string {
  // Keep this byte-for-byte compatible with createTask() in task-creation.ts.
  return createHash('sha256').update(eventId).digest('hex');
}

function scheduleQuery(store: InstallationStore, agentId: string, name: string) {
  return store
    .collection('schedules')
    .where('agentId', '==', agentId)
    .where('name', '==', name)
    .limit(2);
}

function decodeSchedule(value: unknown): ScheduleRecord {
  return decodeRecord<Records['schedules']>(value);
}

function decodeSchedules(snapshot: { docs: Array<{ data(): unknown }> }): ScheduleRecord[] {
  return snapshot.docs.map((doc) => decodeSchedule(doc.data()));
}

function ambiguousName(): Error {
  return new Error('Ambiguous schedule name');
}

/** Firestore adapter for durable recurring schedules and their task firings. */
export class FirestoreScheduleRepository implements ScheduleRepository {
  readonly kind = 'schedule-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async ensure(input: ScheduleCreateInput): Promise<ScheduleRecord> {
    validateScheduleCreate(input);
    const id = randomUUID();
    const key = scheduleNameKey(input.agentId, input.name);
    const keyRef = this.store.doc('scheduleNames', key);

    return this.store.db.runTransaction(async (tx) => {
      // Read both the uniqueness fence and legacy rows before any write. The
      // query repairs rows written before scheduleNames existed and detects
      // duplicate legacy data instead of silently choosing one row.
      const keySnapshot = await tx.get(keyRef);
      const matches = await tx.get(scheduleQuery(this.store, input.agentId, input.name));
      const rows = decodeSchedules(matches);
      if (rows.length > 1) throw ambiguousName();
      const keyScheduleId = keySnapshot.exists ? String(keySnapshot.get('scheduleId') ?? '') : '';
      if (
        keySnapshot.exists &&
        keySnapshot.get('agentId') !== undefined &&
        (keySnapshot.get('agentId') !== input.agentId || keySnapshot.get('name') !== input.name)
      ) {
        throw new Error('Schedule name key does not match its name');
      }

      if (rows[0]) {
        const row = rows[0];
        if (keyScheduleId && keyScheduleId !== row.id)
          throw new Error('Schedule name key points to another schedule');
        // Backfill the stable key for a legacy row in the same transaction.
        if (!keySnapshot.exists || !keyScheduleId) {
          tx.set(keyRef, {
            agentId: input.agentId,
            name: input.name,
            scheduleId: row.id,
            createdAt: this.store.now(),
          });
        }
        return row;
      }

      const now = this.store.now();
      const row: ScheduleRecord = {
        id,
        name: input.name,
        createdAt: now,
        updatedAt: now,
        agentId: input.agentId,
        enabled: input.enabled ?? true,
        cron: input.cron,
        taskTemplate: input.taskTemplate,
        lastRunAt: null,
        nextRunAt: input.nextRunAt,
      };
      // A stale key can remain after an old schedule was removed. Replacing
      // that pointer is safe because the transaction queried this agent/name.
      tx.create(this.store.doc('schedules', id), encodeRecord(row));
      tx.set(keyRef, {
        agentId: input.agentId,
        name: input.name,
        scheduleId: id,
        createdAt: now,
      });
      return row;
    });
  }

  async getByName(agentId: string, name: string): Promise<ScheduleRecord | null> {
    if (!agentId || !name) return null;
    const keySnapshot = await this.store.doc('scheduleNames', scheduleNameKey(agentId, name)).get();
    const matches = await scheduleQuery(this.store, agentId, name).get();
    const rows = decodeSchedules(matches);
    if (rows.length > 1) throw ambiguousName();
    if (rows[0]) {
      const keyScheduleId = keySnapshot.exists ? String(keySnapshot.get('scheduleId') ?? '') : '';
      if (keyScheduleId && keyScheduleId !== rows[0].id)
        throw new Error('Schedule name key points to another schedule');
      return rows[0];
    }
    // A stale key is harmless and is treated as a missing schedule. This also
    // keeps reads compatible with installations where a schedule was removed
    // before its uniqueness fence was cleaned up.
    return null;
  }

  async listPage(
    agentId: string,
    options: { afterId?: string; limit?: number } = {},
  ): Promise<{ items: ScheduleRecord[]; nextCursor: string | null }> {
    if (!agentId) throw new Error('Invalid schedule owner');
    if (
      options.afterId !== undefined &&
      (typeof options.afterId !== 'string' || options.afterId.length === 0)
    )
      throw new Error('Invalid schedule cursor');
    const limit = scheduleBatch(options.limit);
    let query = this.store
      .collection('schedules')
      .where('agentId', '==', agentId)
      .orderBy('id', 'asc');
    if (options.afterId !== undefined) query = query.startAfter(options.afterId);
    const page = await query.limit(limit).get();
    const items = page.docs.map((doc) => {
      const row = decodeSchedule(doc.data());
      try {
        if (
          row.id !== doc.get('id') ||
          documentKey(row.id) !== doc.ref.id ||
          row.agentId !== agentId
        )
          throw new Error('Schedule document identity mismatch');
      } catch {
        throw new Error('Schedule document identity mismatch');
      }
      return row;
    });
    return { items, nextCursor: page.size === limit ? (items.at(-1)?.id ?? null) : null };
  }

  async listUninitialized(limit = 100): Promise<ScheduleRecord[]> {
    const batch = scheduleBatch(limit);
    const result = await this.store
      .collection('schedules')
      .where('enabled', '==', true)
      .where('nextRunAt', '==', null)
      .orderBy('nextRunAt', 'asc')
      .orderBy('id', 'asc')
      .limit(batch)
      .get();
    return decodeSchedules(result);
  }

  async listDue(now: Date, limit = 100): Promise<ScheduleRecord[]> {
    scheduleTime(now);
    const batch = scheduleBatch(limit);
    const result = await this.store
      .collection('schedules')
      .where('enabled', '==', true)
      .where('nextRunAt', '<=', now)
      .orderBy('nextRunAt', 'asc')
      .orderBy('id', 'asc')
      .limit(batch)
      .get();
    return decodeSchedules(result);
  }

  async initialize(expected: ScheduleRecord, nextRunAt: Date, now: Date): Promise<boolean> {
    scheduleTime(nextRunAt);
    scheduleTime(now);
    const ref = this.store.doc('schedules', expected.id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const current = decodeSchedule(snapshot.data());
      // Recheck the complete snapshot and the cancellation fence while locked.
      if (
        !scheduleMatches(current, expected) ||
        current.nextRunAt !== null ||
        !scheduleCanRun(current)
      )
        return false;
      tx.update(ref, encodeRecord({ nextRunAt, updatedAt: now }));
      return true;
    });
  }

  async commitOccurrence(input: ScheduleOccurrence): Promise<ScheduleCommitResult | null> {
    scheduleTime(input.now);
    if (input.nextRunAt !== null) scheduleTime(input.nextRunAt);
    const scheduleRef = this.store.doc('schedules', input.expected.id);
    const taskId = input.task ? randomUUID() : null;
    const eventRef = input.task?.externalEventId
      ? this.store.doc('taskEventKeys', taskEventKey(input.task.externalEventId))
      : null;

    return this.store.db.runTransaction(async (tx) => {
      const scheduleSnapshot = await tx.get(scheduleRef);
      if (!scheduleSnapshot.exists) return null;
      const current = decodeSchedule(scheduleSnapshot.data());
      // This is the cancellation and complete-snapshot fence shared with the
      // reminder delivery/cancellation transactions.
      if (!occurrenceIsCurrent(current, input)) return null;

      let eventSnapshot = null;
      let existingTaskSnapshot = null;
      if (eventRef) {
        eventSnapshot = await tx.get(eventRef);
        if (eventSnapshot.exists) {
          const existingId = String(eventSnapshot.get('taskId') ?? '');
          if (!existingId) throw new Error('Task event index has no task ID');
          existingTaskSnapshot = await tx.get(this.store.doc('tasks', existingId));
          if (!existingTaskSnapshot.exists)
            throw new Error('Task event index points to a missing task');
        }
      }

      let taskResult: TaskCreateResult | null = null;
      if (input.task) {
        if (eventSnapshot?.exists && existingTaskSnapshot?.exists) {
          const existing = decodeRecord<Records['tasks']>(existingTaskSnapshot.data());
          const trigger = existing.trigger as {
            source?: string;
            payload?: { scheduleId?: string };
          } | null;
          if (
            existing.agentId !== current.agentId ||
            trigger?.source !== 'schedule' ||
            trigger.payload?.scheduleId !== current.id
          )
            throw new Error('Task event belongs to another schedule');
          taskResult = existingTaskResult(existing, input.task);
        } else {
          const task = newTaskRecord(input.task, taskId as string, input.now);
          tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
          tx.create(eventRef as NonNullable<typeof eventRef>, {
            taskId: task.id,
            createdAt: input.now,
          });
          createWakeIntent(tx, this.store, {
            taskId: task.id,
            generation: 0,
            availableAt: task.runAfter ?? input.now,
          });
          taskResult = { task, created: true };
        }
      }

      const schedule: ScheduleRecord = {
        ...current,
        enabled: input.enabled,
        nextRunAt: input.nextRunAt,
        lastRunAt: input.now,
        updatedAt: input.now,
      };
      tx.update(
        scheduleRef,
        encodeRecord({
          enabled: schedule.enabled,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
          updatedAt: schedule.updatedAt,
        }),
      );
      return { schedule, task: taskResult };
    });
  }
}
