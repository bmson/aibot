import { defineModuleMeta } from '../kit.js';

export const codeMeta = defineModuleMeta({
  name: 'code',
  title: 'Code execution',
  summary: 'Sandboxed code execution in a job with no database access and no provider credentials.',
  configKeys: ['CODE_DRIVER', 'CODE_JOB_NAME'],
  infra: {
    worker: {
      planKey: 'code',
      image: 'code',
      dockerfile: 'infra/docker/code-runner.Dockerfile',
      jobNameKey: 'CODE_JOB_NAME',
      serviceAccount: 'assistant-code',
      storagePrefixes: ['code-jobs/'],
    },
    serviceAccounts: [{ id: 'assistant-code', displayName: 'Assistant sandboxed code runtime' }],
  },
  billing: {
    gcp: [
      {
        service: 'Cloud Run Job (1 vCPU, 1 GiB)',
        tier: 'usage',
        note: 'Billed per second of execution only while a job runs; idle cost is zero.',
      },
    ],
  },
});
