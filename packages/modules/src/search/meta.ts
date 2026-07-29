import type { ModuleMeta } from '../contract.js';
import { searchToolLabels } from './labels.js';

export const searchMeta = {
  name: 'search',
  title: 'Web search',
  summary: 'Link-returning web search through a configured provider.',
  configKeys: ['SEARCH_PROVIDER', 'SEARCH_API_KEY'],
  readiness: (config) => {
    const ready = config.SEARCH_PROVIDER !== 'none' && Boolean(config.SEARCH_API_KEY);
    return {
      ready,
      detail: ready ? `ready (${config.SEARCH_PROVIDER})` : 'missing search provider or key',
    };
  },
  ui: {
    toolLabels: searchToolLabels,
  },
  billing: {
    external: [
      {
        vendor: 'Search provider (Brave, Tavily, or Serper)',
        required: true,
        note: 'Billed per query above each provider’s free monthly allowance.',
      },
    ],
  },
} satisfies ModuleMeta;
