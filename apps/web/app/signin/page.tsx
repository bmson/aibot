import { notFound, redirect } from 'next/navigation';
import { authMode, isAuthed } from '@/auth';
import { PageHeader, PageShell } from '@/lib/ui';
import { SignInClient } from './signin-client';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (authMode !== 'passkey') notFound();
  if (await isAuthed()) redirect('/chat');
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader title="Sign in" intro="This assistant is private. Use the owner passkey." />
      <SignInClient />
    </PageShell>
  );
}
