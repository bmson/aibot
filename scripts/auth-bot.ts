/**
 * One-time OAuth flow for the bot's Google account (bot@bmson.com).
 *
 * Prereqs (see infra/gcp/oauth-setup.md):
 *   - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env
 *   - The OAuth client must allow redirect URI http://localhost:8123/callback
 *
 * Run: pnpm auth:bot  — then sign in AS THE BOT ACCOUNT in the browser.
 * On success the refresh token is written to .env as BOT_GOOGLE_REFRESH_TOKEN.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(repoRoot, '.env');
dotenv.config({ path: envPath });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
const BOT_EMAIL = 'bot@bmson.com';
const REDIRECT_URI = 'http://localhost:8123/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  // Google Docs: create/edit documents and manage sharing for files the bot created.
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing from .env');
  console.error('Follow infra/gcp/oauth-setup.md first.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('login_hint', BOT_EMAIL);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('missing code');
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = (await tokenRes.json()) as {
      refresh_token?: string;
      access_token?: string;
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokens.refresh_token) {
      throw new Error(
        `token exchange failed: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ''} ` +
          '(no refresh_token usually means the consent screen was skipped — remove prior grants and retry)',
      );
    }

    // Confirm the signed-in account is the bot, not a personal account.
    const payload = JSON.parse(
      Buffer.from((tokens.id_token ?? '..').split('.')[1] ?? '', 'base64url').toString() || '{}',
    ) as { email?: string };
    if (payload.email && payload.email.toLowerCase() !== BOT_EMAIL) {
      throw new Error(
        `signed in as ${payload.email}, expected ${BOT_EMAIL} — run again and pick the bot account`,
      );
    }

    // Write BOT_GOOGLE_REFRESH_TOKEN into .env (replace or append).
    const env = readFileSync(envPath, 'utf8');
    const line = `BOT_GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`;
    const next = env.match(/^BOT_GOOGLE_REFRESH_TOKEN=.*$/m)
      ? env.replace(/^BOT_GOOGLE_REFRESH_TOKEN=.*$/m, line)
      : `${env.trimEnd()}\n${line}\n`;
    writeFileSync(envPath, next);

    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<h2>✓ Bot authorized.</h2><p>Refresh token saved to .env — close this tab.</p>');
    console.log(`✓ refresh token for ${payload.email ?? BOT_EMAIL} written to .env`);
    console.log(
      'Note: the token dies if the bot account password changes — rerun this script then.',
    );
    setTimeout(() => process.exit(0), 200);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    console.error(String(err));
    setTimeout(() => process.exit(1), 200);
  }
});

server.listen(8123, () => {
  console.log('Open this URL and sign in as the BOT account:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for the OAuth callback on :8123 ...');
});
