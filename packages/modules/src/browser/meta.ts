import { isModuleEnabled } from '@assistant/config';
import type { ModuleMeta } from '../contract.js';
import { browserToolLabels } from './labels.js';

export const browserMeta = {
  name: 'browser',
  title: 'Browser',
  summary: 'Planned web interaction executed by an isolated, credential-free browser job.',
  configKeys: ['BROWSER_DRIVER', 'BROWSER_JOB_NAME', 'PROFILE_ENC_KEY', 'TRACES_BUCKET'],
  prodProblems: (config) =>
    config.CANARY_ENABLED && !isModuleEnabled(config, 'browser')
      ? ['the browser module is required when CANARY_ENABLED=true']
      : [],
  infra: { workerImage: 'browser' },
  ui: {
    toolLabels: browserToolLabels,
  },
  billing: {
    gcp: [
      {
        service: 'Cloud Run Job (2 vCPU, 2 GiB)',
        tier: 'usage',
        note: 'Billed per second of browsing only while a job runs; idle cost is zero.',
      },
      {
        service: 'Artifact Registry',
        tier: 'free-tier-likely',
        note: 'Stores the browser image (~1 GiB with Playwright); 0.5 GiB is free.',
      },
      {
        service: 'Cloud Storage',
        tier: 'free-tier-likely',
        note: 'Optional trace bucket, deleted after 30 days by lifecycle rule.',
      },
    ],
  },
  // Worker result callback; the per-launch one-shot token in the body is
  // the credential, validated by the handler itself.
  webhooks: [{ path: '/browser/callback', auth: { kind: 'oneShotToken' } }],
} satisfies ModuleMeta;
