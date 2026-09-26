import type { CitedDateEntity, GraphDateBackfillRepository } from '@assistant/persistence';
import { FirestoreKnowledgeGraphCurationRepository } from './knowledge-graph-curation.js';
import type { InstallationStore } from './store.js';

/** The date backfill on Firestore, through the owner curation fences. */
export class FirestoreGraphDateBackfillRepository implements GraphDateBackfillRepository {
  readonly kind = 'graph-date-backfill-repository' as const;
  private readonly curation: FirestoreKnowledgeGraphCurationRepository;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {
    this.curation = new FirestoreKnowledgeGraphCurationRepository(store);
  }

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Graph date backfill is outside the configured owner');
  }

  async dateSettings(agentId: string): Promise<{ timeZone: string; locale: string }> {
    this.owned(agentId);
    const agent = await this.store.doc('agents', agentId).get();
    if (!agent.exists || agent.get('id') !== agentId) throw new Error('Agent not found');
    const timeZone = agent.get('timezone');
    const locale = agent.get('locale');
    return {
      timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC',
      locale: typeof locale === 'string' && locale ? locale : 'en',
    };
  }

  citedDateEntities(agentId: string): Promise<CitedDateEntity[]> {
    this.owned(agentId);
    return this.curation.citedDateEntities(agentId);
  }

  async canonicalHolder(
    agentId: string,
    canonicalKey: string,
    excludeId: string,
  ): Promise<string | null> {
    this.owned(agentId);
    const holders = await this.store
      .collection('knowledgeGraphEntities')
      .where('agentId', '==', agentId)
      .where('canonicalKey', '==', canonicalKey)
      .select('id')
      .limit(2)
      .get();
    const holder = holders.docs.find((doc) => doc.get('id') !== excludeId);
    return holder ? String(holder.get('id')) : null;
  }

  recanonicalize(
    agentId: string,
    input: { entityId: string; fromKey: string; canonicalKey: string; label: string },
  ): Promise<'updated' | 'missing' | 'changed' | 'conflict'> {
    this.owned(agentId);
    return this.curation.recanonicalizeDate(agentId, input);
  }

  merge(agentId: string, sourceId: string, targetId: string): Promise<boolean> {
    this.owned(agentId);
    return this.curation.merge(agentId, sourceId, targetId);
  }

  removeOrphanedEntities(agentId: string): Promise<number> {
    this.owned(agentId);
    return this.curation.removeOrphanedEntities(agentId);
  }

  countRelativeDateSources(agentId: string): Promise<number> {
    this.owned(agentId);
    return this.curation.countRelativeDateSources(agentId);
  }
}
