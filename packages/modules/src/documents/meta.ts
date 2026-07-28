import type { ModuleMeta } from '../contract.js';

export const documentsMeta = {
  name: 'documents',
  title: 'Documents',
  summary: 'Office and PDF ingestion into searchable workspace text.',
  configKeys: ['PROCESSOR_DRIVER', 'PROCESSOR_JOB_NAME'],
  infra: { workerImage: 'processor' },
  billing: {
    gcp: [
      {
        service: 'Cloud Run Job (1 vCPU, 2 GiB)',
        tier: 'usage',
        note: 'Billed per second of extraction only while a document is processed.',
      },
      {
        service: 'Cloud Storage',
        tier: 'free-tier-likely',
        note: 'Extracted text and originals in the workspace bucket.',
      },
    ],
  },
  ui: { navHrefs: ['/documents'] },
  // Keep in step with the documents.* members of CodeJobName in @assistant/core.
  jobs: ['documents.extract', 'documents.process'],
} satisfies ModuleMeta;
