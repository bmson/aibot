import { approvals } from '@assistant/db';
import { count, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getDb } from '@/lib/server';
import { signOutAction } from './actions';
import './globals.css';

export const metadata: Metadata = {
  title: 'Assistant',
  description: 'Personal AI assistant dashboard',
};

// The sidebar badge (DB) and session lookup are per-request — never prerender.
export const dynamic = 'force-dynamic';

const navItems = [
  { href: '/', label: 'Dashboard' },
  { href: '/chat', label: 'Chat' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/goals', label: 'Goals' },
  { href: '/profile', label: 'Profile' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [[pendingRow], session] = await Promise.all([
    getDb().select({ value: count() }).from(approvals).where(eq(approvals.status, 'pending')),
    authMode === 'google' ? auth() : null,
  ]);
  const pendingApprovals = pendingRow?.value ?? 0;

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        {authMode === 'dev-bypass' ? (
          <div className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            dev mode — auth disabled
          </div>
        ) : null}
        <div className="flex min-h-screen">
          <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
            <div className="px-5 py-5">
              <Link href="/" className="text-sm font-semibold tracking-wide">
                Assistant
              </Link>
            </div>
            <nav className="flex flex-col gap-1 px-3">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                >
                  {item.label}
                  {item.href === '/approvals' && pendingApprovals > 0 ? (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      {pendingApprovals}
                    </span>
                  ) : null}
                </Link>
              ))}
            </nav>
            {session?.user ? (
              <div className="mt-auto border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-500 dark:hover:text-zinc-100"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </aside>
          <main className="flex-1 px-8 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
