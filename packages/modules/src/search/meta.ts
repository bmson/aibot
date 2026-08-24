import { isModuleEnabled } from '@assistant/config';
import type { ModuleMeta } from '../contract.js';
import { searchToolLabels } from './labels.js';

export const searchMeta = {
  name: 'search',
  title: 'Search API',
  summary: 'Direct link-returning search through Brave, Tavily, or Serper.',
  configKeys: ['SEARCH_PROVIDER', 'SEARCH_API_KEY'],
  readiness: (config) => {
    const ready = config.SEARCH_PROVIDER !== 'none' && Boolean(config.SEARCH_API_KEY);
    return {
      ready,
      detail: ready
        ? `ready (${config.SEARCH_PROVIDER})`
        : isModuleEnabled(config, 'browser')
          ? 'direct search provider missing; browser research is still available'
          : 'missing search provider or key',
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
