'use server';

import { redirect } from 'next/navigation';
import { authMode, signOut } from '@/auth';

/** Sidebar sign-out — the layout only renders the button when a real owner session exists. */
export async function signOutAction(): Promise<void> {
  if (authMode === 'passkey') {
    const { clearOwnerSessionCookie } = await import('@/lib/owner-auth/runtime');
    await clearOwnerSessionCookie();
    redirect('/signin');
  }
  await signOut({ redirectTo: '/' });
}
