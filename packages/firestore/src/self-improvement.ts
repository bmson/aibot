import { createHash } from 'node:crypto';
import type {
  NewImprovementProposal,
  Records,
  SelfImprovementRepository,
  SelfImproveSignals,
} from '@assistant/persistence';
import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { encodeRecord, type InstallationStore } from './store.js';

const PAGE = 500;
/** Rows read per signal across the seven-day window; far above one owner's volume. */
const SIGNAL_BOUND = 20_000;
const GETALL_CHUNK = 100;

/** A stable UUID per (owner, kind, title), so a re-run converges on the same proposal. */
function proposalIdFor(agentId: string, kind: string, title: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, kind, title]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The self-improvement review on Firestore. Tool calls, model calls, response
 * checks and graph sources carry no reliable owner field, so ownership is
 * confirmed through their task or memory documents, as the health monitor does.
 */
export class FirestoreSelfImprovementRepository implements SelfImprovementRepository {
  readonly kind = 'self-improvement-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Self-improvement is outside the configured owner');
  }

  /** Every document of a bounded, cursor-paged query. */
  private async scan(query: Query): Promise<QueryDocumentSnapshot[]> {
    const docs: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = await (cursor ? query.startAfter(cursor) : query).limit(PAGE).get();
      docs.push(...page.docs);
      if (page.size < PAGE) return docs;
      if (docs.length >= SIGNAL_BOUND) throw new Error('Self-improvement scan exceeded bound');
      cursor = page.docs[page.docs.length - 1];
    }
  }

  /** The ids among `ids` of documents in `collection` that belong to the owner. */
  private async ownedIds(collection: string, ids: string[]): Promise<Set<string>> {
    const owned = new Set<string>();
    const unique = [...new Set(ids.filter(Boolean))];
    for (let index = 0; index < unique.length; index += GETALL_CHUNK) {
      const refs = unique
        .slice(index, index + GETALL_CHUNK)
        .map((id) => this.store.doc(collection, id));
      for (const snapshot of await this.store.db.getAll(...refs)) {
        if (snapshot.exists && snapshot.get('agentId') === this.agentId)
          owned.add(String(snapshot.get('id')));
      }
    }
    return owned;
  }

  private async byOwnedTask(docs: QueryDocumentSnapshot[]): Promise<QueryDocumentSnapshot[]> {
    const owned = await this.ownedIds(
      'tasks',
      docs.map((doc) => String(doc.get('taskId') ?? '')),
    );
    return docs.filter((doc) => owned.has(String(doc.get('taskId'))));
  }

  private async ownedSources(docs: QueryDocumentSnapshot[]): Promise<number> {
    const direct = docs.filter((doc) => doc.get('agentId') === this.agentId).length;
    const unscoped = docs
      .filter((doc) => doc.get('agentId') === undefined || doc.get('agentId') === null)
      .map((doc) => String(doc.get('memoryId') ?? ''));
    return direct + (await this.ownedIds('memories', unscoped)).size;
  }

  async signals(input: {
    agentId: string;
    since: Date;
    staleBefore: Date;
    costOutlierUsd: number;
    outlierLimit: number;
  }): Promise<SelfImproveSignals> {
    this.owned(input.agentId);
    const { agentId, since } = input;
    const sources = this.store.collection('knowledgeGraphSources');
    const [failedCalls, stuck, modelCalls, checks, failedSources, stalePending] = await Promise.all(
      [
        this.scan(
          this.store
            .collection('toolCalls')
            .where('status', '==', 'failed')
            .where('createdAt', '>=', since)
            .select('taskId', 'toolName', 'error')
            .orderBy('createdAt'),
        ),
        this.scan(
          this.store
            .collection('tasks')
            .where('agentId', '==', agentId)
            .where('status', 'in', ['needs_attention', 'failed'])
            .where('updatedAt', '>=', since)
            .select('attempt')
            .orderBy('updatedAt'),
        ),
        this.scan(
          this.store
            .collection('modelCalls')
            .where('createdAt', '>=', since)
            .select('taskId', 'role', 'costUsd')
            .orderBy('createdAt'),
        ),
        this.scan(
          this.store
            .collection('responseChecks')
            .where('createdAt', '>=', since)
            .orderBy('createdAt'),
        ),
        this.scan(sources.where('status', '==', 'failed').orderBy('updatedAt')),
        this.scan(
          sources
            .where('status', '==', 'pending')
            .where('updatedAt', '<', input.staleBefore)
            .orderBy('updatedAt'),
        ),
      ],
    );

    const expensive = modelCalls.filter(
      (doc) => Number(doc.get('costUsd')) >= input.costOutlierUsd,
    );
    const ownChecks = await this.byOwnedTask(checks);
    const count = (field: string) => ownChecks.filter((doc) => doc.get(field) === true).length;
    const sum = (field: string) =>
      ownChecks.reduce((total, doc) => total + (Number(doc.get(field)) || 0), 0);
    return {
      failedCalls: (await this.byOwnedTask(failedCalls)).map((doc) => ({
        toolName: String(doc.get('toolName')),
        error: typeof doc.get('error') === 'string' ? doc.get('error') : null,
      })),
      stuckCount: stuck.filter((doc) => Number(doc.get('attempt')) >= 2).length,
      costOutliers: (await this.byOwnedTask(expensive))
        .map((doc) => ({ role: String(doc.get('role')), costUsd: String(doc.get('costUsd')) }))
        .sort((left, right) => Number(right.costUsd) - Number(left.costUsd))
        .slice(0, input.outlierLimit),
      contractBlocks: count('blocked'),
      unsupportedClaims: sum('unsupportedCount'),
      mustActRetries: sum('mustActRetries'),
      degradedSteps: sum('degradedSteps'),
      verificationUnavailable: count('outputVerificationUnavailable'),
      graphFailedSources: await this.ownedSources(failedSources),
      graphStalePending: await this.ownedSources(stalePending),
    };
  }

  async insertProposal(agentId: string, proposal: NewImprovementProposal): Promise<boolean> {
    this.owned(agentId);
    const id = proposalIdFor(agentId, proposal.kind, proposal.title);
    const ref = this.store.doc('improvementProposals', id);
    const imported = this.store
      .collection('improvementProposals')
      .where('agentId', '==', agentId)
      .where('kind', '==', proposal.kind)
      .where('title', '==', proposal.title)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [byId, byIdentity] = await Promise.all([tx.get(ref), tx.get(imported)]);
      if (byId.exists || !byIdentity.empty) return false;
      const now = this.store.now();
      const row: Records['improvementProposals'] = {
        id,
        agentId,
        status: 'open',
        ...proposal,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(row));
      return true;
    });
  }
}
