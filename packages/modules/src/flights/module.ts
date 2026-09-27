import { registerFlightTools } from '@assistant/tools/flights';
import { ApnsClient } from '@assistant/tools/modules/push';
import { defineModule } from '../platform.js';
import { noticeFlightsInEmail } from './email.js';
import { pushFollowedFlights } from './follow.js';
import { flightsMeta } from './meta.js';

export const flightsModule = defineModule({
  meta: flightsMeta,
  create: ({ config, registry, persistence }) => {
    if (!config.AEROAPI_KEY) {
      console.warn(
        `flights module enabled but unavailable — ${flightsMeta.readiness(config).detail}`,
      );
      return {};
    }
    registerFlightTools(registry, {
      apiKey: config.AEROAPI_KEY,
      tracking: { watches: persistence.watches, generatedCards: persistence.generatedCards },
    });
    // Flights followed on the Lock Screen are pushed with the same APNs key as
    // owner notices. Without it the card and the activity still update while
    // the app is open; only the closed-app updates stand down.
    const apns = new ApnsClient(
      config.APNS_KEY_ID,
      config.APNS_TEAM_ID,
      config.APNS_PRIVATE_KEY,
      config.APNS_BUNDLE_ID,
    );
    return {
      hooks: {
        // Flights in the owner's mail are tracked without being asked about.
        emailObservers: [
          async (services, event) => {
            await noticeFlightsInEmail(
              {
                router: services.router,
                watches: services.persistence.watches,
                generatedCards: services.persistence.generatedCards,
                notifications: services.persistence.notifications,
                notifyOwner: services.ownerNotifier.notifyOwner,
                apiKey: config.AEROAPI_KEY,
              },
              event,
            );
          },
        ],
        sweepSteps: [
          {
            name: 'pushFollowedFlights',
            reportKey: 'followedFlightPushes',
            portable: true,
            run: (services) =>
              pushFollowedFlights({
                watches: services.persistence.watches,
                apiKey: config.AEROAPI_KEY,
                generatedCards: services.persistence.generatedCards,
                notifyOwner: services.ownerNotifier.notifyOwner,
                ...(apns.configured()
                  ? { sendLiveActivity: (push) => apns.sendLiveActivity(push) }
                  : {}),
              }),
          },
        ],
      },
    };
  },
});
