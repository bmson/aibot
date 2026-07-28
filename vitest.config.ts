import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites share one PostgreSQL database. Running files in
    // parallel lets count-based assertions observe another suite's fixture.
    fileParallelism: false,
    projects: [
      'packages/application',
      'packages/config',
      'packages/core',
      'packages/db',
      'packages/modules',
      'packages/tools',
      'apps/agent',
      'apps/web',
      'workers/browser-job',
      'workers/document-processor',
    ],
  },
});
