import { registerWatchTools } from '@assistant/tools/watches';
import { defineModule } from '../platform.js';
import { watchesMeta } from './meta.js';

export const watchesModule = defineModule({
  meta: watchesMeta,
  create: ({ registry }) => {
    registerWatchTools(registry);
    return {};
  },
});
