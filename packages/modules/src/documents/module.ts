import {
  CloudRunDocumentJobLauncher,
  type DocumentProcessorConfig,
  LocalDocumentProcessLauncher,
} from '@assistant/core';
import { defineModule } from '../runtime-kit.js';
import { documentsMeta } from './meta.js';

export const documentsModule = defineModule<DocumentProcessorConfig | undefined>({
  meta: documentsMeta,
  create: ({ config, repoRoot, workspacePrefix, workspaceRoot }) => {
    const callbackUrl = `${config.PUBLIC_URL}/webhooks/document/callback`;
    if (config.PROCESSOR_DRIVER === 'cloudrun') {
      return {
        exports: {
          launcher: new CloudRunDocumentJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.PROCESSOR_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
            },
          }),
          callbackUrl,
        },
      };
    }
    if (config.QUEUE_DRIVER === 'local') {
      return {
        exports: {
          launcher: new LocalDocumentProcessLauncher({ repoRoot, workspaceRoot }),
          callbackUrl,
        },
      };
    }
    // A cloud installation without a processor job has nowhere to run
    // extraction; document tools stay registered but produce no launches.
    return {};
  },
});
