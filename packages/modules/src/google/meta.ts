import { type Config, isModuleEnabled, loadConfig } from '@assistant/config';
import type { ModuleMeta } from '../contract.js';

export const googleMeta = {
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
    const enabled = isModuleEnabled(config, 'google');
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
    // Mail sync polls for new messages; the watch registration expires after a
    // week, so it is renewed daily.
    schedulerJobs: [
      { name: 'assistant-gmail-sync', schedule: '* * * * *', path: '/internal/gmail/sync' },
      { name: 'assistant-gmail-watch', schedule: '0 4 * * *', path: '/internal/gmail/watch' },
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
} satisfies ModuleMeta;

/**
 * Whether the agent should poll Gmail for new mail.
 *
 * An explicit true or false always wins; otherwise sync runs only in
 * production, so a developer's machine does not quietly consume the same
 * mailbox as the deployed assistant. The module being installed is a hard gate
 * either way.
 */
export function gmailSyncEnabled(config: Config = loadConfig()): boolean {
  if (!isModuleEnabled(config, 'google')) return false;
  if (config.GMAIL_SYNC_ENABLED === 'true') return true;
  if (config.GMAIL_SYNC_ENABLED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}
