import { defineModuleMeta } from '../kit.js';

export const browserMeta = defineModuleMeta({
  name: 'browser',
  title: 'Browser',
  summary: 'Planned web interaction executed by an isolated, credential-free browser job.',
  configKeys: ['BROWSER_DRIVER', 'BROWSER_JOB_NAME', 'PROFILE_ENC_KEY', 'TRACES_BUCKET'],
  prodProblems: (config) =>
    config.CANARY_ENABLED && !config.ASSISTANT_MODULES.includes('browser')
      ? ['the browser module is required when CANARY_ENABLED=true']
      : [],
  infra: {
    worker: {
      planKey: 'browser',
      image: 'browser',
      dockerfile: 'infra/docker/browser-job.Dockerfile',
      jobNameKey: 'BROWSER_JOB_NAME',
      serviceAccount: 'assistant-browser',
      storagePrefixes: ['browser-jobs/'],
    },
    serviceAccounts: [
      { id: 'assistant-browser', displayName: 'Assistant sandboxed browser runtime' },
    ],
    secretKeys: ['PROFILE_ENC_KEY'],
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
});
