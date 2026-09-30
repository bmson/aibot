import { existsSync } from 'node:fs';
import { envFile, loadConfig } from '@assistant/config';
import { headers } from 'next/headers';
import { SecurityClient } from '@/app/security/security-client';
import { authMode, requireOwner } from '@/auth';
import { getMobileAccessToken } from '@/lib/mobile-access-token';
import { Card, PageHeader, PageShell } from '@/lib/ui';
import { MobileTokenPanel } from './mobile-token';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireOwner();
  const config = loadConfig();
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http';
  const serverUrl = host ? `${proto}://${host}` : config.AUTH_URL;
  const token = authMode === 'passkey' ? '' : await getMobileAccessToken();
  return (
    <PageShell size="reading" className="grid gap-8">
      <PageHeader
        title="Settings"
        intro="Connect the mobile app to your assistant. Manage access here; use the app for everything else."
      />
      {authMode === 'passkey' ? (
        <SecurityClient serverUrl={serverUrl} />
      ) : (
        <section>
          <h2 className="text-lg font-semibold">Mobile API access token</h2>
          <Card className="mt-3">
            <MobileTokenPanel
              maskedToken={token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null}
              serverUrl={serverUrl}
              canRotate={existsSync(envFile) || Boolean(config.GCP_PROJECT)}
            />
          </Card>
        </section>
      )}
    </PageShell>
  );
}
