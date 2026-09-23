import type { ProfileVoiceOverviewRepository, Records } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const VOICE_IMPORT_LIMIT = 5;

/** Installation-wide voice data and agent-owned voice import state. */
export class FirestoreProfileVoiceOverviewRepository implements ProfileVoiceOverviewRepository {
  readonly kind = 'profile-voice-overview-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async load() {
    const configured = await this.store.collection('agents').limit(2).get();
    if (configured.size !== 1 || !configured.docs[0])
      throw new Error('Voice overview requires exactly one configured agent');
    const agent = configured.docs[0];
    const agentId = agent.get('id');
    if (typeof agentId !== 'string' || documentKey(agentId) !== agent.id)
      throw new Error('Configured agent record is malformed');
    const fence = await readPrivacyErasureFence(this.store, agentId);

    const [samples, imports, profile] = await Promise.all([
      this.store.collection('writingSamples').select('id', 'context').get(),
      this.store.collection('importSources').where('agentId', '==', agentId).get(),
      this.store.doc('voiceProfile', '1').get(),
    ]);
    const contexts = samples.docs.map((doc) => {
      const row = decodeRecord<Records['writingSamples']>(doc.data());
      if (!row.id || documentKey(row.id) !== doc.id)
        throw new Error('Malformed writing sample record');
      return row.context;
    });
    const voice = profile.exists ? decodeRecord<Records['voiceProfile']>(profile.data()) : null;
    if (voice && voice.id !== 1) throw new Error('Malformed voice profile record');
    const voiceImports = imports.docs
      .map((doc) => {
        const row = decodeRecord<Records['importSources']>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
          throw new Error('Malformed voice import record');
        return row;
      })
      .filter((row) => row.source.startsWith('voice-samples'))
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, VOICE_IMPORT_LIMIT);

    const result = {
      voiceStats: {
        total: contexts.length,
        auto: contexts.filter((context) => context.startsWith('auto:')).length,
        uploaded: contexts.filter((context) => context.startsWith('upload:')).length,
      },
      voiceProfile: {
        description: voice?.description ?? '',
        dos: Array.isArray(voice?.dos)
          ? voice.dos.filter((value): value is string => typeof value === 'string')
          : [],
        donts: Array.isArray(voice?.donts)
          ? voice.donts.filter((value): value is string => typeof value === 'string')
          : [],
        signature: voice?.signature ?? '',
      },
      voiceImports: voiceImports.map((row) => ({
        source: row.source,
        status: row.status,
        itemsTotal: row.itemsTotal,
        itemsProcessed: row.itemsProcessed,
        memoriesSaved: row.memoriesSaved,
        taskId: row.taskId,
        error: row.error,
      })),
    };
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
