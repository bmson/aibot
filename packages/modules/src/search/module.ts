import { registerSearchTools } from '@assistant/tools/search';
import { defineModule } from '../runtime-kit.js';
import { searchMeta } from './meta.js';

export const searchModule = defineModule({
  meta: searchMeta,
  create: ({ config, registry }) => {
    if (config.SEARCH_PROVIDER === 'none' || !config.SEARCH_API_KEY) {
      console.warn('search module enabled but unavailable — set SEARCH_PROVIDER + SEARCH_API_KEY');
      return {};
    }
    registerSearchTools(registry, {
      provider: config.SEARCH_PROVIDER,
      apiKey: config.SEARCH_API_KEY,
    });
    return {};
  },
});
