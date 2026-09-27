import { registerFlightTools } from '@assistant/tools/flights';
import { ApnsClient } from '@assistant/tools/modules/push';
import { defineModule } from '../platform.js';
import { pushFollowedFlights } from './follow.js';
import { flightsMeta } from './meta.js';

export const flightsModule = defineModule({
  meta: flightsMeta,
  create: ({ config, registry }) => {
    if (!config.AEROAPI_KEY) {
      console.warn(
        `flights module enabled but unavailable — ${flightsMeta.readiness(config).detail}`,
      );
      return {};
    }
    registerFlightTools(registry, { apiKey: config.AEROAPI_KEY });
    // Flights followed on the Lock Screen are pushed with the same APNs key as
    // owner notices. Without it the card and the activity still update while
    // the app is open; only the closed-app updates stand down.
    const apns = new ApnsClient(
      config.APNS_KEY_ID,
      config.APNS_TEAM_ID,
      config.APNS_PRIVATE_KEY,
      config.APNS_BUNDLE_ID,
    );
    if (!apns.configured()) return {};
    return {
      hooks: {
        sweepSteps: [
          {
            name: 'pushFollowedFlights',
            reportKey: 'followedFlightPushes',
            portable: true,
            run: (services) =>
              pushFollowedFlights({
                watches: services.persistence.watches,
                apiKey: config.AEROAPI_KEY,
                sendLiveActivity: (push) => apns.sendLiveActivity(push),
              }),
          },
        ],
      },
    };
  },
});
