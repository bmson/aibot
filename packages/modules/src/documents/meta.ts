import { defineModuleMeta } from '../kit.js';

export const documentsMeta = defineModuleMeta({
  name: 'documents',
  title: 'Documents',
  summary: 'Office and PDF ingestion into searchable workspace text.',
  configKeys: ['PROCESSOR_DRIVER', 'PROCESSOR_JOB_NAME'],
  infra: {
    worker: {
      planKey: 'processor',
      image: 'processor',
      dockerfile: 'infra/docker/document-processor.Dockerfile',
      jobNameKey: 'PROCESSOR_JOB_NAME',
      serviceAccount: 'assistant-processor',
      storagePrefixes: ['documents/', 'uploads/'],
    },
    serviceAccounts: [
      { id: 'assistant-processor', displayName: 'Assistant sandboxed document processor runtime' },
    ],
  },
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
  ui: { nav: [{ href: '/documents', label: 'Documents' }] },
  jobs: ['documents.extract', 'documents.process'],
});
