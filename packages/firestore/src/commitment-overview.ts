import type { OwnerCommitment } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;
const MAX_ACTIVE_SCAN = 10_000;
const OVERVIEW_LIMIT = 30;

export type FirestoreCommitmentOverviewRow = Pick<
  OwnerCommitment,
  'id' | 'kind' | 'title' | 'details' | 'nextAction' | 'dueAt' | 'status'
>;

async function assertConfiguredOwner(store: InstallationStore, agentId: string): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('Commitment overview requires exactly one configured agent');
}

/** Strict owner-facing read: malformed active rows may never disappear from the list. */
export async function getFirestoreCommitmentOverview(
  store: InstallationStore,
  configuredAgentId: string,
  now: Date,
): Promise<FirestoreCommitmentOverviewRow[]> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const active: OwnerCommitment[] = [];
  let scanned = 0;
  for (const status of ['open', 'snoozed'] as const) {
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = store
        .collection('commitments')
        .where('agentId', '==', configuredAgentId)
        .where('status', '==', status)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        scanned += 1;
        if (scanned > MAX_ACTIVE_SCAN)
          throw new Error('Commitment overview active scan exceeds its limit');
        const row = decodeRecord<OwnerCommitment>(doc.data());
        if (
          row.id === undefined ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== configuredAgentId ||
          row.status !== status ||
          !['decision', 'question', 'promise', 'waiting_on'].includes(row.kind) ||
          typeof row.title !== 'string' ||
          typeof row.details !== 'string' ||
          typeof row.nextAction !== 'string' ||
          (row.dueAt !== null &&
            (!(row.dueAt instanceof Date) || !Number.isFinite(row.dueAt.getTime()))) ||
          !(row.updatedAt instanceof Date) ||
          !Number.isFinite(row.updatedAt.getTime()) ||
          (status === 'snoozed' &&
            (!(row.snoozedUntil instanceof Date) || !Number.isFinite(row.snoozedUntil.getTime())))
        )
          throw new Error('Commitment overview contains a malformed active row');
        if (status === 'open' || (row.snoozedUntil as Date) < now) active.push(row);
      }
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
  }
  active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return active
    .slice(0, OVERVIEW_LIMIT)
    .map(({ id, kind, title, details, nextAction, dueAt, status }) => ({
      id,
      kind,
      title,
      details,
      nextAction,
      dueAt,
      status,
    }));
}
