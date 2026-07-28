import { planBrowse } from '@assistant/core';
import {
  type BrowserJobLauncher,
  CloudRunJobLauncher,
  LocalProcessLauncher,
  registerBrowserTools,
} from '@assistant/tools/browser';
import { defineModule } from '../platform.js';
import { browserMeta } from './meta.js';

export const browserModule = defineModule<BrowserJobLauncher | undefined>({
  meta: browserMeta,
  create: ({ config, registry, router, repoRoot, workspacePrefix, workspaceRoot }) => {
    const launcher =
      config.BROWSER_DRIVER === 'cloudrun'
        ? new CloudRunJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.BROWSER_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
              ...(config.TRACES_BUCKET
                ? {
                    tracesBucket: config.TRACES_BUCKET,
                    tracesPrefix: config.ASSISTANT_WORKSPACE_ID,
                  }
                : {}),
            },
          })
        : new LocalProcessLauncher({
            repoRoot,
            workspaceRoot,
            profileEncKey: config.PROFILE_ENC_KEY,
          });
    registerBrowserTools(registry, {
      plan: (input) => planBrowse(router, input),
      launcher,
      callbackUrl: `${config.PUBLIC_URL}/webhooks/browser/callback`,
    });
    return { exports: launcher };
  },
});
