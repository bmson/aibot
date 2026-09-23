import type { ModuleMeta } from '../contract.js';

/**
 * PostgreSQL-independent Google Calendar reads. Mutations, Gmail, and the
 * remaining Workspace tools stay in the separate `google` module.
 */
export const calendarMeta = {
  name: 'calendar',
  title: 'Google Calendar',
  summary: 'Read calendars, events, and free/busy availability.',
  configKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'BOT_GOOGLE_REFRESH_TOKEN'],
  readiness: (config) => {
    const ready = Boolean(
      config.GOOGLE_OAUTH_CLIENT_ID &&
        config.GOOGLE_OAUTH_CLIENT_SECRET &&
        config.BOT_GOOGLE_REFRESH_TOKEN,
    );
    return { ready, detail: ready ? 'ready' : 'missing Google OAuth credentials' };
  },
  infra: { gcpApis: ['calendar-json.googleapis.com'] },
  billing: { gcp: [], external: [] },
} satisfies ModuleMeta;
