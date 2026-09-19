import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OAuth2Client } from 'google-auth-library';

const execFileAsync = promisify(execFile);
const TOKEN_CACHE_MS = 2 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,8192}$/;

type RunGcloud = (args: string[]) => Promise<string>;

async function defaultRunGcloud(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gcloud', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new Error('gcloud authentication command failed; refresh the active gcloud login');
  }
}

/** Development-only auth that keeps gcloud access tokens in memory. */
export async function createGcloudAuthClient(
  runGcloud: RunGcloud = defaultRunGcloud,
): Promise<OAuth2Client> {
  const account = (
    await runGcloud([
      'auth',
      'list',
      '--filter=status:ACTIVE',
      '--format=value(account)',
      '--limit=1',
    ])
  ).trim();
  if (
    account.length < 1 ||
    account.length > 320 ||
    [...account].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x21 || code > 0x7e;
    })
  )
    throw new Error('gcloud has no valid active account; authenticate the CLI first');

  const client = new OAuth2Client({
    eagerRefreshThresholdMillis: 10_000,
    forceRefreshOnFailure: true,
  });
  let pending: Promise<{ access_token: string; expiry_date: number }> | undefined;
  client.refreshHandler = () => {
    pending ??= runGcloud(['auth', 'print-access-token', account, '--quiet'])
      .then((stdout) => {
        const accessToken = stdout.trim();
        if (!TOKEN_PATTERN.test(accessToken))
          throw new Error('gcloud returned an invalid access token');
        return { access_token: accessToken, expiry_date: Date.now() + TOKEN_CACHE_MS };
      })
      .catch(() => {
        throw new Error('gcloud could not refresh the active account; reauthenticate the CLI');
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  return client;
}
