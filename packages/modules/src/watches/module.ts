import { registerWatchTools } from '@assistant/tools/watches';
import { defineModule } from '../platform.js';
import { matchEmailWatches, reapExpiredWatches } from './email-watches.js';
import { watchesMeta } from './meta.js';
import { pollDueWebWatches } from './web-watches.js';

export const watchesModule = defineModule({
  meta: watchesMeta,
  create: ({ registry, persistence }) => {
    const watches = persistence.watches;
    registerWatchTools(registry, watches);
    return {
      hooks: {
        // Watches observe every authenticated inbound email (the google module
        // fans these out) and notify through whichever owner channel is
        // installed — never by importing a channel module directly.
        emailObservers: [
          async (services, event) => {
            await matchEmailWatches(
              {
                watches: services.persistence.watches,
                messages: services.persistence.messages,
                tasks: services.persistence.tasks,
                notifyOwner: services.ownerNotifier.notifyOwner,
              },
              event,
            );
          },
        ],
        sweepSteps: [
          {
            name: 'reapExpiredWatches',
            // Preserves the /internal/sweep response key from the hardcoded era.
            reportKey: 'expiredInboxWatches',
            run: (services) => reapExpiredWatches({ watches: services.persistence.watches }),
          },
          {
            // Poll due web watches ("watch.poll_web"): fetch each watched page
            // through the SSRF-guarded fetch and notify the owner on a change.
            name: 'pollWebWatches',
            reportKey: 'webWatchFires',
            run: (services) =>
              pollDueWebWatches({
                watches: services.persistence.watches,
                messages: services.persistence.messages,
                notifyOwner: services.ownerNotifier.notifyOwner,
              }),
          },
        ],
      },
    };
  },
});
