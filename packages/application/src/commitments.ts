import { getAgent } from '@assistant/core/chat';
import {
  correctCommitment,
  dismissCommitment,
  listOpenCommitments,
  resolveCommitment,
  snoozeCommitment,
} from '@assistant/core/memory/commitments';
import type { Db } from '@assistant/db';

export type CommitmentView = Pick<
  import('@assistant/db').CommitmentRow,
  'id' | 'kind' | 'title' | 'details' | 'nextAction' | 'dueAt' | 'status'
>;

export async function listCommitmentOverview(db: Db): Promise<CommitmentView[]> {
  const agent = await getAgent(db);
  const rows = await listOpenCommitments(db, { agentId: agent.id, limit: 30 });
  return rows.map(({ id, kind, title, details, nextAction, dueAt, status }) => ({
    id,
    kind,
    title,
    details,
    nextAction,
    dueAt,
    status,
  }));
}

export async function resolveOwnerCommitment(db: Db, id: string, resolution: string) {
  await resolveCommitment(db, id, resolution);
}

export async function snoozeOwnerCommitment(db: Db, id: string, until: Date) {
  await snoozeCommitment(db, id, until);
}

export async function dismissOwnerCommitment(db: Db, id: string) {
  await dismissCommitment(db, id);
}

export async function correctOwnerCommitment(
  db: Db,
  id: string,
  patch: { title: string; details?: string; nextAction?: string },
) {
  await correctCommitment(db, id, patch);
}
