import {
  type EmbeddingSpace,
  type Records,
  type VoiceContextRepository,
  type VoiceProfileText,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, type InstallationStore } from './store.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The owner's voice on Firestore: the singleton profile and a native vector
 * search over their writing samples in the installation's embedding space.
 */
export class FirestoreVoiceContextRepository implements VoiceContextRepository {
  readonly kind = 'voice-context-repository' as const;
  private readonly spaceKey: string;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    readonly space: EmbeddingSpace,
  ) {
    validateSkillEmbeddingSpace(space);
    this.spaceKey = embeddingSpaceKey(space);
  }

  async profile(): Promise<VoiceProfileText | null> {
    const snapshot = await this.store.doc('voiceProfile', '1').get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['voiceProfile']>(snapshot.data());
    return {
      description: typeof row.description === 'string' ? row.description : '',
      dos: strings(row.dos),
      donts: strings(row.donts),
      signature: typeof row.signature === 'string' ? row.signature : '',
    };
  }

  private samples(register: string) {
    return this.store
      .collection('writingSamples')
      .where('agentId', '==', this.agentId)
      .where('register', '==', register)
      .where('embeddingSpace', '==', this.spaceKey);
  }

  async hasSamples(register: string): Promise<boolean> {
    return !(await this.samples(register).limit(1).get()).empty;
  }

  async nearestSamples(register: string, embedding: number[], limit: number): Promise<string[]> {
    validateEmbedding(this.space, embedding);
    const result = await this.samples(register)
      .findNearest({
        vectorField: 'embedding',
        queryVector: embedding,
        distanceMeasure: 'COSINE',
        limit,
      })
      .get();
    return result.docs.flatMap((doc) => {
      const text = doc.get('text');
      return typeof text === 'string' ? [text] : [];
    });
  }
}
