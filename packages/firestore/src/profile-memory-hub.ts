import type { ProfileMemoryHubRepository, Records } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;
const MAX_SCAN = 100_000;
const QUARANTINE_LIMIT = 100;
const RECALL_FEEDBACK_WINDOW_DAYS = 90;

/** Read every page or fail explicitly; overview counts must never be silently truncated. */
async function scan(query: Query): Promise<QueryDocumentSnapshot[]> {
  const rows: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    rows.push(...snapshot.docs);
    if (rows.length > MAX_SCAN) throw new Error('Memory hub scan exceeds its explicit limit');
    if (snapshot.size < PAGE_SIZE) return rows;
    cursor = snapshot.docs.at(-1);
  }
}

function ownedRow<T extends { id: string; agentId: string }>(
  doc: QueryDocumentSnapshot,
  agentId: string,
): T {
  const row = decodeRecord<T>(doc.data());
  if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
    throw new Error('Malformed or foreign Memory hub record');
  return row;
}

export class FirestoreProfileMemoryHubRepository implements ProfileMemoryHubRepository {
  readonly kind = 'profile-memory-hub-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async load() {
    const configured = await this.store.collection('agents').limit(2).get();
    if (configured.size !== 1 || !configured.docs[0])
      throw new Error('Memory hub requires exactly one configured agent');
    const agentDoc = configured.docs[0];
    const agentId = agentDoc.get('id');
    if (typeof agentId !== 'string' || documentKey(agentId) !== agentDoc.id)
      throw new Error('Configured agent record is malformed');

    const [contactDocs, memoryDocs, feedbackDocs, taskDocs, cardDoc] = await Promise.all([
      scan(this.store.collection('contacts')),
      scan(this.store.collection('memories').where('agentId', '==', agentId)),
      scan(this.store.collection('recallFeedback').where('agentId', '==', agentId)),
      scan(this.store.collection('tasks').where('agentId', '==', agentId)),
      this.store.doc('ownerCards', agentId).get(),
    ]);
    const contacts = contactDocs.map((doc) => {
      const row = decodeRecord<Records['contacts']>(doc.data());
      if (!row.id || documentKey(row.id) !== doc.id)
        throw new Error('Malformed Memory hub contact');
      return row;
    });
    const owner = contacts.find((row) => row.trust === 'owner');
    const now = this.store.now();
    const knowledge = memoryDocs
      .map((doc) => ownedRow<Records['memories']>(doc, agentId))
      .filter((row) => row.category === 'knowledge');
    const unexpired = knowledge.filter((row) => !row.expiresAt || row.expiresAt > now);
    const usable = unexpired.filter((row) => !row.quarantined);
    const organized = usable
      .map((row) => row.lastConsolidatedAt)
      .filter((date): date is Date => date instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime());
    const review = unexpired.filter((row) => row.quarantined);
    const quarantined = review
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, QUARANTINE_LIMIT);
    const feedbackSince = new Date(now.getTime() - RECALL_FEEDBACK_WINDOW_DAYS * 86_400_000);
    const feedback = feedbackDocs
      .map((doc) => ownedRow<Records['recallFeedback']>(doc, agentId))
      .filter((row) => row.createdAt >= feedbackSince);
    const rated = feedback.map((row) => row.createdAt).sort((a, b) => b.getTime() - a.getTime());
    const latestOrganizer = taskDocs
      .map((doc) => ownedRow<Records['tasks']>(doc, agentId))
      .filter((row) => {
        const trigger = row.trigger as { payload?: { job?: unknown } } | null;
        return trigger?.payload?.job === 'memory.consolidate';
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    const card = cardDoc.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(cardDoc.data())
      : null;
    if (
      card &&
      (card.agentId !== agentId ||
        typeof card.content !== 'string' ||
        !(card.compiledAt instanceof Date))
    )
      throw new Error('Malformed Memory hub owner card');

    return {
      ...(owner ? { owner } : {}),
      quarantined,
      memoryHealth: {
        totalUsable: usable.length,
        notYetOrganized: usable.filter((row) => !row.lastConsolidatedAt).length,
        awaitingReview: review.length,
        ownerConfirmed: usable.filter((row) => row.ownerConfirmed).length,
        lastOrganizedAt: organized[0] ?? null,
      },
      recallFeedback: {
        rated: feedback.length,
        helpful: feedback.filter((row) => row.verdict === 'helpful').length,
        notHelpful: feedback.filter((row) => row.verdict === 'not_helpful').length,
        lastRatedAt: rated[0] ?? null,
        windowDays: RECALL_FEEDBACK_WINDOW_DAYS,
      },
      latestOrganizer: latestOrganizer
        ? {
            id: latestOrganizer.id,
            status: latestOrganizer.status,
            progress: latestOrganizer.progress,
            updatedAt: latestOrganizer.updatedAt,
          }
        : null,
      card: card
        ? { compiledAt: card.compiledAt as Date, empty: (card.content as string).trim() === '' }
        : null,
      ownerFactCount: owner ? usable.filter((row) => row.subjectContactId === owner.id).length : 0,
      peopleCount: contacts.filter((row) => row.trust !== 'owner').length,
    };
  }
}
