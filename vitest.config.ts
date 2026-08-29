import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The integration projects drop and recreate their schema, so they may only
 * ever point at a `_test` database. A contributor's shell usually has
 * DATABASE_URL aimed at their development database, and a suite invoked
 * directly once wiped one — so redirect rather than trust it.
 *
 * Redirecting instead of throwing is deliberate: refusing outright also
 * blocked `vitest packages/config` and the web component suites, which never
 * open a connection, for anyone whose shell had the variable set at all.
 */
function safeTestDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL;
  const url = new URL(configured ?? 'postgres://assistant:assistant@localhost:5432/assistant_test');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL names no database.');
  if (!database.endsWith('_test')) {
    url.pathname = `/${encodeURIComponent(`${database}_test`)}`;
    console.warn(
      `Vitest redirected DATABASE_URL from "${database}" to "${database}_test" — the integration suites recreate the schema they run against.`,
    );
  }
  return url.toString();
}

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
    env: { DATABASE_URL: safeTestDatabaseUrl() },
    // Inherited default for the DB-touching projects listed as plain strings.
    fileParallelism: false,
    projects: [
      'packages/application',
      'packages/core',
      'packages/db',
      // Serial since the watches e2e suite moved in with the watches module —
      // it shares the one database with the other integration projects.
      'packages/modules',
      'packages/tools',
      'apps/agent',
      parallel('packages/config'),
      parallel('packages/setup'),
      {
        ...parallel('apps/web'),
        // Next resolves "@/..." from the app's tsconfig paths; vitest does not
        // read those, so without this any web test that imports a component
        // reaching for @/lib fails to resolve the package rather than the file.
        resolve: {
          alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) },
        },
      },
      parallel('workers/browser-job'),
      parallel('workers/code-runner'),
      parallel('workers/document-processor'),
    ],
  },
});
