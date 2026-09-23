import { mapKitCredentials } from '@assistant/core/maps';
import type { ModuleMeta } from '../contract.js';
import { mapsToolLabels } from './labels.js';

export const mapsMeta = {
  name: 'maps',
  title: 'Apple Maps',
  summary: 'Directions, travel times, and route maps through the Apple Maps Server API.',
  configKeys: ['MAPKIT_KEY_ID', 'MAPKIT_TEAM_ID', 'MAPKIT_PRIVATE_KEY'],
  readiness: (config) => {
    const credentials = mapKitCredentials(config);
    const shared = credentials && !config.MAPKIT_KEY_ID;
    return {
      ready: Boolean(credentials),
      detail: credentials
        ? shared
          ? 'ready (signing with the APNs key; MapKit must be enabled on it)'
          : 'ready'
        : 'no MapKit key: set MAPKIT_* or an APNS_* key with MapKit enabled',
    };
  },
  ui: { toolLabels: mapsToolLabels },
  billing: {
    external: [
      {
        vendor: 'Apple',
        required: true,
        note: 'Maps Server API is free up to 25,000 calls a day with an Apple Developer Program membership.',
        url: 'https://developer.apple.com/account/resources/services/maps-ids',
      },
    ],
  },
} satisfies ModuleMeta;
