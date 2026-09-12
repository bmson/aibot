import { describe, expect, it, vi } from 'vitest';
import { type ReconcileSpawn, runReconcile } from './reconcile.js';

describe('runReconcile', () => {
  it('starts the direct maintenance wrapper with resolved DATABASE_URL and inherited stdio', () => {
    const spawn = vi.fn<ReconcileSpawn>(() => ({ error: undefined, signal: null, status: 0 }));
    const secretUrl = 'postgres://user:p%40ss@ep-test-pooler.c-2.us-west-2.aws.neon.tech/db';

    expect(runReconcile({ DATABASE_URL: secretUrl }, spawn)).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('/infra/docker/database-admin.sh'), 'pnpm', 'reconcile:direct'],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: secretUrl }),
        stdio: 'inherit',
      }),
    );
  });

  it('propagates child exit status and converts a terminating signal to failure', () => {
    const failed = vi.fn<ReconcileSpawn>(() => ({ error: undefined, signal: null, status: 17 }));
    const signaled = vi.fn<ReconcileSpawn>(() => ({
      error: undefined,
      signal: 'SIGTERM',
      status: null,
    }));

    expect(runReconcile({ DATABASE_URL: 'postgres://localhost/db' }, failed)).toBe(17);
    expect(runReconcile({ DATABASE_URL: 'postgres://localhost/db' }, signaled)).toBeGreaterThan(0);
  });

  it('fails without echoing the database URL when the child cannot start', () => {
    const secretUrl = 'postgres://user:secret@ep-test-pooler.c-2.us-west-2.aws.neon.tech/db';
    const spawn = vi.fn<ReconcileSpawn>(() => ({
      error: new Error(`failed to launch with ${secretUrl}`),
      signal: null,
      status: null,
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runReconcile({ DATABASE_URL: secretUrl }, spawn)).toBe(1);
    expect(error).toHaveBeenCalledWith('Could not start the database reconcile command.');
    expect(error.mock.calls.flat().join(' ')).not.toContain(secretUrl);
    error.mockRestore();
  });
});
