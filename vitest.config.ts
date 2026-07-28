import { defineConfig } from 'vitest/config';

/**
 * Projects that never touch PostgreSQL run their files in parallel; the
 * integration projects inherit the root's serial setting because they share
 * one database, where parallel files let count-based assertions observe
 * another suite's fixture.
 */
const parallel = (root: string) => ({
  extends: true as const,
  test: { root, fileParallelism: true },
});

export default defineConfig({
  test: {
    // Inherited default for the DB-touching projects listed as plain strings.
    fileParallelism: false,
    projects: [
      'packages/application',
      'packages/core',
      'packages/db',
      'packages/tools',
      'apps/agent',
      parallel('packages/config'),
      parallel('packages/modules'),
      parallel('packages/setup'),
      parallel('apps/web'),
      parallel('workers/browser-job'),
      parallel('workers/code-runner'),
      parallel('workers/document-processor'),
    ],
  },
});
