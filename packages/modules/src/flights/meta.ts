import type { ModuleMeta } from '../contract.js';
import { flightsToolLabels } from './labels.js';

export const flightsMeta = {
  name: 'flights',
  title: 'Flights',
  summary: 'Live flight status, gates and delays through FlightAware AeroAPI.',
  configKeys: ['AEROAPI_KEY'],
  readiness: (config) => ({
    ready: Boolean(config.AEROAPI_KEY),
    detail: config.AEROAPI_KEY ? 'ready' : 'no AeroAPI key: set AEROAPI_KEY',
  }),
  ui: { toolLabels: flightsToolLabels },
  billing: {
    external: [
      {
        vendor: 'FlightAware',
        required: true,
        note: 'AeroAPI bills per query (flight status is about half a cent); live cards read a flight at most every two minutes while on screen, and a shared one-minute cache absorbs repeats.',
        url: 'https://www.flightaware.com/aeroapi/portal',
      },
    ],
  },
} satisfies ModuleMeta;
