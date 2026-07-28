import { defineModuleMeta } from '../kit.js';

export const googleMeta = defineModuleMeta({
  name: 'google',
  title: 'Google Workspace',
  summary: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, and job application confirmations.',
  configKeys: [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'BOT_GOOGLE_REFRESH_TOKEN',
    'GMAIL_PUBSUB_TOPIC',
    'GMAIL_PUSH_SERVICE_ACCOUNT',
    'GMAIL_SYNC_ENABLED',
  ],
  readiness: (config) => {
    const ready = Boolean(
      config.GOOGLE_OAUTH_CLIENT_ID &&
        config.GOOGLE_OAUTH_CLIENT_SECRET &&
        config.BOT_GOOGLE_REFRESH_TOKEN,
    );
    return { ready, detail: ready ? 'ready' : 'missing Google OAuth credentials' };
  },
  prodProblems: (config) => {
    const problems: string[] = [];
    const enabled = config.ASSISTANT_MODULES.includes('google');
    if (config.GMAIL_PUBSUB_TOPIC && !enabled) {
      problems.push('the google module is required when GMAIL_PUBSUB_TOPIC is set');
    }
    if (config.GMAIL_PUBSUB_TOPIC && !config.GMAIL_PUSH_SERVICE_ACCOUNT) {
      problems.push('GMAIL_PUSH_SERVICE_ACCOUNT is required when GMAIL_PUBSUB_TOPIC is set');
    }
    if (config.CANARY_ENABLED && !enabled) {
      problems.push('the google module is required when CANARY_ENABLED=true');
    }
    return problems;
  },
  infra: {
    gcpApis: [
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
      'docs.googleapis.com',
      'sheets.googleapis.com',
      'slides.googleapis.com',
      'drive.googleapis.com',
    ],
    pubsubTopics: ['gmail-events'],
    schedulerJobs: [
      { name: 'assistant-gmail-sync', schedule: '* * * * *', path: '/internal/gmail/sync' },
      { name: 'assistant-gmail-watch', schedule: '0 4 * * *', path: '/internal/gmail/watch' },
    ],
    serviceAccounts: [
      { id: 'assistant-gmail-push', displayName: 'Assistant Gmail Pub/Sub push identity' },
    ],
    secretKeys: [
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'BOT_GOOGLE_REFRESH_TOKEN',
    ],
  },
  billing: {
    gcp: [
      {
        service: 'Pub/Sub',
        tier: 'free-tier-likely',
        note: 'Gmail push notifications; the first 10 GiB per month is free.',
      },
      {
        service: 'Cloud Scheduler',
        tier: 'free-tier-likely',
        note: 'Two jobs (mail sync, watch renewal); three jobs per month are free.',
      },
    ],
    external: [
      {
        vendor: 'Google Workspace',
        required: false,
        note: 'A seat is needed only if the assistant has its own Workspace identity; a consumer Google account works otherwise.',
        url: 'https://workspace.google.com/pricing',
      },
    ],
  },
});
