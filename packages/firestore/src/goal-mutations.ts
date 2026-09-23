import type { Records } from '@assistant/persistence';
import type {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Transaction,
} from '@google-cloud/firestore';
import { privacyErasureIsActive, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Goal = Records['goals'];
type Schedule = Records['schedules'];
type GoalSettings = Pick<
  Goal,
  | 'title'
  | 'description'
  | 'priority'
  | 'targetDate'
  | 'progress'
  | 'nextAction'
  | 'mirrorToPrimary'
>;
const TERMINAL_TASKS = new Set(['done', 'failed', 'cancelled']);
const MAX_GOAL_TASKS = 200;

function goalName(id: string) {
  return `goal:${id}`;
}

function identity<T extends { id: string; agentId: string }>(
  doc: DocumentSnapshot,
  row: T,
  id: string,
  agentId: string,
) {
  if (row.id !== id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
    throw new Error('Goal record identity mismatch');
}

function ownerScheduleQuery(store: InstallationStore, agentId: string, name: string) {
  return store
    .collection('schedules')
    .where('agentId', '==', agentId)
    .where('name', '==', name)
    .limit(2);
}

function decodeGoal(doc: DocumentSnapshot, id: string, agentId: string): Goal {
  const goal = decodeRecord<Goal>(doc.data());
  identity(doc, goal, id, agentId);
  return goal;
}

function decodeGoalSchedules(
  snapshot: QuerySnapshot,
  agentId: string,
  name: string,
): Array<{ doc: QueryDocumentSnapshot; row: Schedule }> {
  return snapshot.docs.map((doc) => {
    const row = decodeRecord<Schedule>(doc.data());
    if (documentKey(row.id) !== doc.id || row.agentId !== agentId || row.name !== name)
      throw new Error('Goal automation record is malformed');
    return { doc, row };
  });
}

/** Owner-scoped transactional mutations for existing mobile Goals. */
export class FirestoreGoalMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async mutate<T>(
    id: string,
    apply: (input: {
      tx: Transaction;
      goalDoc: DocumentSnapshot;
      goal: Goal;
      schedule?: { doc: QueryDocumentSnapshot; row: Schedule };
      schedules: Array<{ doc: QueryDocumentSnapshot; row: Schedule }>;
      now: Date;
    }) => Promise<T>,
  ): Promise<T> {
    if (!id || !this.configuredAgentId)
      throw new Error('Goal mutation requires the configured owner');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const result = await this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        documentKey(this.configuredAgentId) !== owner.id
      )
        throw new Error('Goals require exactly one configured owner');
      const goalRef = this.store.doc('goals', id);
      const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
      const [goalDoc, erasure] = await tx.getAll(goalRef, erasureRef);
      if (!goalDoc?.exists) throw new Error('goal not found');
      if (erasure?.exists) {
        if (
          erasure.get('agentId') !== this.configuredAgentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          (fence && !erasure.updateTime.isEqual(fence)) ||
          (!fence && erasure.exists)
        )
          throw new Error('Privacy erasure is in progress');
      } else if (fence) {
        throw new Error('Privacy erasure changed during goal mutation');
      }
      const goal = decodeGoal(goalDoc, id, this.configuredAgentId);
      const snapshots = await tx.get(
        ownerScheduleQuery(this.store, this.configuredAgentId, goalName(id)),
      );
      const schedules = decodeGoalSchedules(snapshots, this.configuredAgentId, goalName(id));
      if (schedules.length > 1) throw new Error('Ambiguous goal automation');
      const schedule = schedules[0];
      const value = await apply({ tx, goalDoc, goal, schedule, schedules, now: this.store.now() });
      return value;
    });
    return result;
  }

  async updateSettings(
    id: string,
    input: GoalSettings,
    scheduleUpdate: { cron: string; instruction: string },
  ): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, schedule, now }) => {
      if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)
        throw new Error('invalid goal priority');
      tx.update(goalDoc.ref, encodeRecord({ ...input, updatedAt: now }));
      if (schedule) {
        const current = schedule.row.taskTemplate;
        if (!current || typeof current !== 'object' || Array.isArray(current))
          throw new Error('Goal automation template is malformed');
        const template = current as Record<string, unknown>;
        if (template.goalId !== id) throw new Error('Goal automation belongs to another goal');
        tx.update(schedule.doc.ref, {
          cron: scheduleUpdate.cron,
          taskTemplate: encodeRecord({ ...template, instruction: scheduleUpdate.instruction }),
          nextRunAt: null,
          updatedAt: now,
        });
      }
    });
  }

  async setStatus(id: string, status: 'active' | 'paused' | 'done' | 'abandoned'): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      if (!['active', 'paused', 'done', 'abandoned'].includes(status))
        throw new Error('invalid goal status');
      const activeStatus = status === 'active' && !goal.archivedAt;
      if (activeStatus && !schedule)
        throw new Error('Goal automation is unavailable for this goal');
      const taskPage =
        status === 'abandoned'
          ? await tx.get(
              this.store
                .collection('tasks')
                .where('goalId', '==', id)
                .limit(MAX_GOAL_TASKS + 1),
            )
          : null;
      if (taskPage && taskPage.size > MAX_GOAL_TASKS)
        throw new Error('Too much goal work to update safely');
      const tasks =
        taskPage?.docs.flatMap((doc) => {
          const row = decodeRecord<Records['tasks']>(doc.data());
          if (!row.id || documentKey(row.id) !== doc.id)
            throw new Error('Goal task identity mismatch');
          return row.agentId === this.configuredAgentId &&
            row.goalId === id &&
            !TERMINAL_TASKS.has(row.status) &&
            row.status !== 'running'
            ? [doc]
            : [];
        }) ?? [];
      tx.update(goalDoc.ref, encodeRecord({ status, updatedAt: now }));
      if (schedule)
        tx.update(schedule.doc.ref, {
          enabled: activeStatus,
          nextRunAt: activeStatus ? null : schedule.row.nextRunAt,
          updatedAt: now,
        });
      for (const task of tasks)
        tx.update(task.ref, {
          status: 'cancelled',
          progress: 'stopped because its goal was stopped',
          runAfter: null,
          lockedUntil: null,
          updatedAt: now,
        });
    });
  }

  async archive(id: string): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      const taskPage = await tx.get(
        this.store
          .collection('tasks')
          .where('goalId', '==', id)
          .limit(MAX_GOAL_TASKS + 1),
      );
      if (taskPage.size > MAX_GOAL_TASKS) throw new Error('Too much goal work to archive safely');
      const active = taskPage.docs.some((doc) => {
        const row = decodeRecord<Records['tasks']>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id)
          throw new Error('Goal task identity mismatch');
        return (
          row.agentId === this.configuredAgentId &&
          row.goalId === id &&
          !TERMINAL_TASKS.has(row.status)
        );
      });
      if (active)
        throw new Error('finish, cancel, or pause active work before archiving this goal');
      if (goal.archivedAt) return;
      tx.update(goalDoc.ref, encodeRecord({ archivedAt: now, updatedAt: now }));
      if (schedule) tx.update(schedule.doc.ref, { enabled: false, updatedAt: now });
    });
  }

  async restore(id: string): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      if (goal.status === 'active' && !schedule)
        throw new Error('Goal automation is unavailable for this goal');
      if (!goal.archivedAt) return;
      tx.update(goalDoc.ref, encodeRecord({ archivedAt: null, updatedAt: now }));
      if (schedule && goal.status === 'active')
        tx.update(schedule.doc.ref, { enabled: true, nextRunAt: null, updatedAt: now });
    });
  }

  async setAutonomy(id: string, enabled: boolean): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, now }) => {
      if (enabled && goal.taintedOrigin)
        throw new Error('a goal created from external content cannot be given free-range autonomy');
      tx.update(goalDoc.ref, encodeRecord({ autonomy: enabled, updatedAt: now }));
    });
  }
}
