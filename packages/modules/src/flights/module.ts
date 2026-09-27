import { registerFlightTools } from '@assistant/tools/flights';
import { defineModule } from '../platform.js';
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
    return {};
  },
});
