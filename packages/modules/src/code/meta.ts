import type { ModuleMeta } from '../contract.js';

export const codeMeta = {
  name: 'code',
  title: 'Code execution',
  summary: 'Sandboxed code execution in a job with no database access and no provider credentials.',
  configKeys: ['CODE_DRIVER', 'CODE_JOB_NAME'],
  infra: { workerImage: 'code' },
  billing: {
    gcp: [
      {
        service: 'Cloud Run Job (1 vCPU, 1 GiB)',
        tier: 'usage',
        note: 'Billed per second of execution only while a job runs; idle cost is zero.',
      },
    ],
  },
  // Worker result callback; the per-launch one-shot token in the body is
  // the credential, validated by the handler itself.
  webhooks: [{ path: '/code/callback', auth: { kind: 'oneShotToken' } }],
} satisfies ModuleMeta;
