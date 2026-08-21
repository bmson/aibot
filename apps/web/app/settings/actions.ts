'use server';

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { envFile, reloadConfig } from '@assistant/config';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

function revalidateSettings(): void {
  revalidatePath('/settings');
}

/** Editable agent identity: timezone, locale, signature. */
export async function updateAgentSettings(input: {
  timezone: string;
  locale: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getApplication().updateSettings(input);
  if (result.error) return result;
  revalidateSettings();
  return {};
}

/** Pause/resume a proactive schedule. Re-enabling recomputes next_run_at on the next sweep. */
export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getApplication().setScheduleEnabled(scheduleId, enabled);
  revalidateSettings();
}

/** Enable/disable a standing approval rule. */
export async function setPolicyEnabled(policyId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getApplication().setPolicyEnabled(policyId, enabled);
  revalidateSettings();
}

/** Remove a standing approval rule entirely — the tool goes back to asking. */
export async function deletePolicy(policyId: string): Promise<void> {
  await requireOwner();
  await getApplication().deletePolicy(policyId);
  revalidateSettings();
}

/**
 * Persist one env value into the repository .env, replacing the existing line
 * when present. Returns false when there is no .env to write — a Cloud Run
 * service is configured from injected env vars, and silently "rotating" only
 * the in-memory value would revert on the next instance recycle.
 *
 * The write is atomic (temp file + rename) with a `.bak` alongside: this file
 * is the single configuration source every local process reads at boot, so a
 * crash mid-write must not leave a truncated .env behind.
 */
function persistEnvValue(key: string, value: string): boolean {
  if (!existsSync(envFile)) return false;
  const content = readFileSync(envFile, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const updated = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
  copyFileSync(envFile, `${envFile}.bak`);
  const tempFile = `${envFile}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tempFile, updated);
  renameSync(tempFile, envFile);
  return true;
}

/** On Cloud Run, fetch an access token for the web runtime's service account. */
async function metadataAccessToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Publish a new mobile-api-token version in Secret Manager, then make the
 * running instance use it. Only the versions become available — the service
 * reads `mobile-api-token:latest`, so adding a version is what rolls it out.
 */
async function publishToSecretManager(project: string, token: string): Promise<string | null> {
  const accessToken = await metadataAccessToken();
  const parent = `projects/${project}/secrets/mobile-api-token`;
  const res = await fetch(`${parent}:addVersion`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(token, 'utf8').toString('base64') } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return `Secret Manager rejected the rotation (${res.status}): ${detail.slice(0, 200)}`;
  }
  return null;
}

/**
 * Generate a new MOBILE_API_TOKEN and put it into effect. Two paths:
 *  - Local / self-hosted (.env present): persist to .env, reload in place.
 *  - Cloud Run (no .env): add a Secret Manager version, then point the running
 *    process at it. The web service account holds secretVersionAdder on this
 *    one secret only, so it can rotate its own mobile credential and nothing
 *    else.
 * The new token is returned once so the UI can show it; the stored value is
 * only ever masked after this.
 */
export async function rotateMobileToken(): Promise<{ token?: string; error?: string }> {
  await requireOwner();
  const token = randomBytes(32).toString('hex');

  if (existsSync(envFile)) {
    persistEnvValue('MOBILE_API_TOKEN', token);
  } else {
    const project = process.env.GCP_PROJECT;
    if (!project) {
      return { error: 'No .env file and no GCP_PROJECT — nowhere to persist the new key.' };
    }
    const secretError = await publishToSecretManager(project, token).catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    );
    if (secretError) return { error: secretError };
  }

  // Load-bearing: dotenv does not override variables already present in
  // process.env, so the new value is set explicitly before the config cache
  // is dropped — otherwise reloadConfig() would re-parse the stale one.
  process.env.MOBILE_API_TOKEN = token;
  reloadConfig();
  revalidateSettings();
  return { token };
}
