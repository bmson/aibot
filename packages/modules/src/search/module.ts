import { registerSearchTools } from '@assistant/tools/search';
import { defineModule } from '../platform.js';
import { searchMeta } from './meta.js';

export const searchModule = defineModule({
  meta: searchMeta,
  create: ({ config, registry }) => {
    // The readiness rule lives in metadata so `pnpm config:check` and this
    // warning can never disagree about what "configured" means. The provider
    // test is repeated here only because it is what narrows the enum below.
    const { ready, detail } = searchMeta.readiness(config);
    if (!ready || config.SEARCH_PROVIDER === 'none') {
      console.warn(`search module enabled but unavailable — ${detail}`);
      return {};
    }
    registerSearchTools(registry, {
      provider: config.SEARCH_PROVIDER,
      apiKey: config.SEARCH_API_KEY,
    });
    return {};
  },
});
