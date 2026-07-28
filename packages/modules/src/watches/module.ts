import { registerWatchTools } from '@assistant/tools/watches';
import { defineModule } from '../platform.js';
import { matchEmailWatches, reapExpiredWatches } from './email-watches.js';
import { watchesMeta } from './meta.js';

export const watchesModule = defineModule({
  meta: watchesMeta,
  create: ({ registry }) => {
    registerWatchTools(registry);
    return {
      hooks: {
        // Watches observe every authenticated inbound email (the google module
        // fans these out) and notify through whichever owner channel is
        // installed — never by importing a channel module directly.
        emailObservers: [
          async (services, event) => {
            await matchEmailWatches(
              { db: services.db, notifyOwner: services.ownerNotifier.notifyOwner },
              event,
            );
          },
        ],
        sweepSteps: [
          {
            name: 'reapExpiredWatches',
            // Preserves the /internal/sweep response key from the hardcoded era.
            reportKey: 'expiredInboxWatches',
            run: (services) => reapExpiredWatches({ db: services.db }),
          },
        ],
      },
    };
  },
});
