import {
  CloudRunCodeJobLauncher,
  type CodeJobLauncher,
  LocalCodeProcessLauncher,
  registerCodeTools,
} from '@assistant/tools/code';
import { defineModule } from '../runtime-kit.js';
import { codeMeta } from './meta.js';

export const codeModule = defineModule<CodeJobLauncher>({
  meta: codeMeta,
  create: ({ config, registry, repoRoot, workspacePrefix, workspaceRoot }) => {
    const launcher: CodeJobLauncher =
      config.CODE_DRIVER === 'cloudrun'
        ? new CloudRunCodeJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.CODE_JOB_NAME,
            storage: {
              driver: 'gcs',
              bucket: config.WORKSPACE_BUCKET,
              prefix: workspacePrefix,
            },
          })
        : new LocalCodeProcessLauncher({ repoRoot, workspaceRoot });
    registerCodeTools(registry, {
      launcher,
      callbackUrl: `${config.PUBLIC_URL}/webhooks/code/callback`,
    });
    return { exports: launcher };
  },
});
