import { mapKitCredentials } from '@assistant/core/maps';
import { registerMapsTools } from '@assistant/tools/maps';
import { defineModule } from '../platform.js';
import { mapsMeta } from './meta.js';

export const mapsModule = defineModule({
  meta: mapsMeta,
  create: ({ config, registry }) => {
    const credentials = mapKitCredentials(config);
    if (!credentials) {
      console.warn(`maps module enabled but unavailable — ${mapsMeta.readiness(config).detail}`);
      return {};
    }
    registerMapsTools(registry, { credentials });
    return {};
  },
});
