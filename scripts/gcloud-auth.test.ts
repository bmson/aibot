import { describe, expect, it, vi } from 'vitest';
import { createGcloudAuthClient } from './gcloud-auth.js';

describe('gcloud auth client', () => {
  it('pins the active account and coalesces token refreshes without exposing the token', async () => {
    const token = `ya29.${'a'.repeat(40)}`;
    let release!: (value: string) => void;
    const pendingToken = new Promise<string>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'list') return 'developer@example.test\n';
      return pendingToken;
    });
    const client = await createGcloudAuthClient(run);
    const first = client.getAccessToken();
    const second = client.getAccessToken();
    release(`${token}\n`);

    await expect(first).resolves.toMatchObject({ token });
    await expect(second).resolves.toMatchObject({ token });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith([
      'auth',
      'print-access-token',
      'developer@example.test',
      '--quiet',
    ]);
  });

  it('rejects missing accounts and malformed token output without echoing either value', async () => {
    await expect(createGcloudAuthClient(async () => '')).rejects.toThrow('no valid active account');
    const client = await createGcloudAuthClient(async (args) =>
      args[1] === 'list' ? 'developer@example.test' : 'bad token output',
    );
    await expect(client.getAccessToken()).rejects.toThrow('could not refresh');
  });
});
