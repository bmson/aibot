import type { ProactiveHealthCounts, ProactiveHealthRepository } from '@assistant/persistence';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { decodeRecord, type InstallationStore } from './store.js';

/** Pings read per day; the ambient policy caps them far below this. */
const PING_LIMIT = 2_000;

/** The proactive-health counts on Firestore, through aggregation queries. */
export class FirestoreProactiveHealthRepository implements ProactiveHealthRepository {
  readonly kind = 'proactive-health-repository' as const;
  private readonly devices: FirestoreDeviceTokenRepository;

  constructor(readonly store: InstallationStore) {
    this.devices = new FirestoreDeviceTokenRepository(store);
  }

  async counts(
    agentId: string,
    window: { since24h: Date; since7d: Date },
  ): Promise<ProactiveHealthCounts> {
    const mail = this.store.collection('emailIngest').where('agentId', '==', agentId);
    const [scored24h, scored7d, latest, moments, pings, devices] = await Promise.all([
      mail.where('createdAt', '>=', window.since24h).count().get(),
      mail.where('createdAt', '>=', window.since7d).count().get(),
      mail.orderBy('createdAt', 'desc').select('createdAt').limit(1).get(),
      this.store
        .collection('proactiveMoments')
        .where('agentId', '==', agentId)
        .where('deliveredAt', '>=', window.since24h)
        .count()
        .get(),
      this.store
        .collection('proactivePings')
        .where('agentId', '==', agentId)
        .where('createdAt', '>=', window.since24h)
        .select('delivered')
        .limit(PING_LIMIT)
        .get(),
      this.devices.listActive(agentId),
    ]);
    const lastMailAt = latest.docs[0]
      ? decodeRecord<{ createdAt?: unknown }>(latest.docs[0].data()).createdAt
      : null;
    return {
      mailScored24h: scored24h.data().count,
      mailScored7d: scored7d.data().count,
      lastMailAt: lastMailAt instanceof Date ? lastMailAt : null,
      momentsDelivered24h: moments.data().count,
      pingsDelivered24h: pings.docs.filter((doc) => doc.get('delivered') === true).length,
      pingsHeld24h: pings.docs.filter((doc) => doc.get('delivered') !== true).length,
      pushDevices: devices.length,
    };
  }
}
