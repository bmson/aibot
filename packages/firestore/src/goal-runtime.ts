import type { GoalRuntimeRepository, GoalSessionState, Records } from '@assistant/persistence';
import type { QuerySnapshot } from '@google-cloud/firestore';
import { FirestoreGoalProgressRepository } from './goal-progress.js';
import { FirestoreGoalReadRepository } from './goals.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Task = Records['tasks'];

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
/** Every task type except the owner-attended chat and SMS turns. */
const UNATTENDED_TASK_TYPES = ['email_triage', 'scheduled', 'mission', 'browser_job', 'adhoc'];
const MAX_OPEN_GOAL_TASKS = 200;

/** Goal state for the executor, mission reports, and the goal schedule gate. */
export class FirestoreGoalRuntimeRepository implements GoalRuntimeRepository {
  readonly kind = 'goal-runtime-repository' as const;
  private readonly reads: FirestoreGoalReadRepository;
  private readonly progress: FirestoreGoalProgressRepository;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.reads = new FirestoreGoalReadRepository(store, configuredAgentId);
    this.progress = new FirestoreGoalProgressRepository(store, configuredAgentId);
  }

  get(agentId: string, goalId: string) {
    return this.reads.get(agentId, goalId);
  }

  recordBlocked(input: { agentId: string; goalId: string; nextAction: string }) {
    return this.progress.recordBlocked(input);
  }

  private ownedTasks(snapshot: QuerySnapshot, agentId: string, goalId: string): Task[] {
    return snapshot.docs.map((doc) => {
      const row = decodeRecord<Task>(doc.data());
      if (documentKey(row.id) !== doc.id || row.agentId !== agentId || row.goalId !== goalId)
        throw new Error('Goal task identity mismatch');
      return row;
    });
  }

  async sessionState(agentId: string, goalId: string): Promise<GoalSessionState> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal session is outside the configured installation');
    const tasks = this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('goalId', '==', goalId);
    const [goal, open, recent] = await Promise.all([
      this.reads.get(agentId, goalId),
      tasks
        .where('status', 'not-in', TERMINAL_TASK_STATUSES)
        .limit(MAX_OPEN_GOAL_TASKS + 1)
        .get(),
      tasks.where('type', 'in', UNATTENDED_TASK_TYPES).orderBy('createdAt', 'desc').limit(3).get(),
    ]);
    if (open.size > MAX_OPEN_GOAL_TASKS)
      throw new Error('Too much open goal work to gate its next session safely');
    return {
      goal,
      openTasks: this.ownedTasks(open, agentId, goalId).map((task) => ({
        id: task.id,
        type: task.type,
        status: task.status,
        updatedAt: task.updatedAt,
      })),
      recentSessions: this.ownedTasks(recent, agentId, goalId).map((task) => ({
        status: task.status,
        progress: task.progress,
        createdAt: task.createdAt,
      })),
    };
  }

  async ownerRepliedSince(input: { agentId: string; conversationId: string; since: Date }) {
    if (input.agentId !== this.configuredAgentId)
      throw new Error('Goal session is outside the configured installation');
    const conversation = await this.store.doc('conversations', input.conversationId).get();
    if (!conversation.exists) return false;
    if (
      conversation.get('agentId') !== input.agentId ||
      conversation.get('id') !== input.conversationId
    )
      throw new Error('Goal work chat is outside the configured installation');
    const reply = await this.store
      .collection('messages')
      .where('conversationId', '==', input.conversationId)
      .where('origin', '==', 'owner')
      .where('createdAt', '>', input.since)
      .limit(1)
      .get();
    return !reply.empty;
  }
}
