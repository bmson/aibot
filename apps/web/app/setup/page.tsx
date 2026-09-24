import { notFound, redirect } from 'next/navigation';
import { authMode, isAuthed } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { SetupClient } from './setup-client';

export const metadata = { title: 'Secure your assistant' };
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (authMode !== 'passkey') notFound();
  if (await isAuthed()) redirect('/security');
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        title="Secure your assistant"
        intro="Claim this installation with a passkey. Only someone holding the one-time setup link can do this."
      />
      <SetupClient />
    </PageShell>
  );
}
