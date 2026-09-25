import {
  addMicros,
  type MissionProgressRepository,
  type MissionRepository,
  type MissionSessionProgressInput,
  microsToUsd,
  type Records,
  usdToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Task = Records['tasks'];

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
/** A mission wakes about daily, so this is well past a long mission's sessions. */
const MAX_MISSION_SESSIONS = 500;

function ownedTask(snapshot: DocumentSnapshot, agentId: string): Task | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Task>(snapshot.data());
  if (documentKey(row.id) !== snapshot.id || row.agentId !== agentId) return null;
  return row;
}

/** Mission wake reads and the mission.update session write. */
export class FirestoreMissionRepository implements MissionRepository, MissionProgressRepository {
  readonly kind = 'mission-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private assertOwner(agentId: string) {
    if (!this.configuredAgentId || agentId !== this.configuredAgentId)
      throw new Error('Mission is outside the configured installation');
  }

  private async sessions(agentId: string, missionId: string): Promise<Task[]> {
    this.assertOwner(agentId);
    const snapshot = await this.store
      .collection('tasks')
      .where('parentTaskId', '==', missionId)
      .limit(MAX_MISSION_SESSIONS + 1)
      .get();
    if (snapshot.size > MAX_MISSION_SESSIONS)
      throw new Error('Too many mission sessions to read safely');
    return snapshot.docs.map((doc) => {
      const row = decodeRecord<Task>(doc.data());
      if (
        documentKey(row.id) !== doc.id ||
        row.agentId !== agentId ||
        row.parentTaskId !== missionId
      )
        throw new Error('Mission session identity mismatch');
      return row;
    });
  }

  async activeSession(agentId: string, missionId: string) {
    const active = (await this.sessions(agentId, missionId))
      .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
      )[0];
    return active ? { id: active.id, status: active.status } : null;
  }

  async spentUsd(agentId: string, missionId: string) {
    const [mission, sessions] = await Promise.all([
      this.store.doc('tasks', missionId).get(),
      this.sessions(agentId, missionId),
    ]);
    const row = ownedTask(mission, agentId);
    return microsToUsd(
      addMicros(
        ...[...(row ? [row] : []), ...sessions].map((task) => usdToMicros(Number(task.spentUsd))),
      ),
    );
  }

  async recordSessionProgress(input: MissionSessionProgressInput) {
    this.assertOwner(input.agentId);
    if (
      input.progress.length < 3 ||
      input.progress.length > 1000 ||
      input.nextAction.length > 500 ||
      input.notes.length > 2000
    )
      throw new Error('Invalid mission progress');
    return this.store.db.runTransaction(async (tx) => {
      const session = ownedTask(
        await tx.get(this.store.doc('tasks', input.sessionTaskId)),
        input.agentId,
      );
      if (!session?.parentTaskId) throw new Error('this task has no parent mission');
      const missionRef = this.store.doc('tasks', session.parentTaskId);
      const mission = ownedTask(await tx.get(missionRef), input.agentId);
      if (mission?.type !== 'mission') throw new Error('parent is not a mission');
      const state =
        mission.state && typeof mission.state === 'object' && !Array.isArray(mission.state)
          ? { ...(mission.state as Record<string, unknown>) }
          : {};
      if (input.notes) state.scratchpad = input.notes.slice(0, 4000);
      tx.update(
        missionRef,
        encodeRecord({
          progress: input.progress,
          nextAction: input.nextAction,
          progressPercent: input.progressPercent ?? mission.progressPercent,
          state,
          updatedAt: this.store.now(),
        }),
      );
      return { updated: mission.id };
    });
  }
}
