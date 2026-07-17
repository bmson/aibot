import { approvals } from '@assistant/db';
import { count, eq } from 'drizzle-orm';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getDb } from '@/lib/server';
import { AppNav } from './app-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Assistant',
  description: 'Personal AI assistant dashboard',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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
  { href: '/import', label: 'Import' },
  { href: '/costs', label: 'Costs' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [pendingApprovals, session] = await Promise.all([
    (async () => {
      try {
        const [pendingRow] = await getDb()
          .select({ value: count() })
          .from(approvals)
          .where(eq(approvals.status, 'pending'));
        return pendingRow?.value ?? 0;
      } catch (error) {
        console.error('[layout] failed to load pending approval count', error);
        return 0;
      }
    })(),
    (async () => {
      if (authMode !== 'google') return null;
      try {
        return await auth();
      } catch (error) {
        console.error('[layout] failed to load auth session', error);
        return null;
      }
    })(),
  ]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        {authMode === 'dev-bypass' ? (
          <div className="bg-amber-100 px-4 py-1 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            dev mode — auth disabled
          </div>
        ) : null}
        <div className="flex min-h-screen flex-col lg:flex-row">
          <AppNav
            navItems={navItems}
            pendingApprovals={pendingApprovals}
            signedIn={!!session?.user}
          />
          <main className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
