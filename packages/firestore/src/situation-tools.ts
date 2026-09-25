import type { SituationToolRepository } from '@assistant/persistence';
import { FirestoreSituationPackMutationRepository } from './situation-pack-mutations.js';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import type { InstallationStore } from './store.js';

/** The `situations.*` tools over the same pack reads and commands the owner UI uses. */
export class FirestoreSituationToolRepository implements SituationToolRepository {
  private readonly reads: FirestoreSituationPackReadRepository;
  private readonly mutations: FirestoreSituationPackMutationRepository;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.reads = new FirestoreSituationPackReadRepository(store);
    this.mutations = new FirestoreSituationPackMutationRepository(store, configuredAgentId);
  }

  private owner(agentId: string): string {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Situation pack owner is outside the configured Firestore agent');
    return agentId;
  }

  list(agentId: string) {
    return this.reads.list(this.owner(agentId));
  }

  get(agentId: string, packId: string) {
    return this.reads.get(this.owner(agentId), packId);
  }

  sources(agentId: string) {
    return this.reads.listSources(this.owner(agentId));
  }

  decisions(agentId: string, query: string, packId?: string) {
    return this.reads.decisions(this.owner(agentId), query, packId);
  }

  command(agentId: string, input: unknown) {
    this.owner(agentId);
    // The model can never confirm a lasting preference; only the owner UI can.
    return this.mutations.command(input);
  }
}
