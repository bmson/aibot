'use server';

import { signOut } from '@/auth';

/** Sidebar sign-out — the layout only renders the button when a real Google session exists. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
