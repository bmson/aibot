import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { authMode } from '@/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Assistant',
  description: 'Personal AI assistant dashboard',
};

const navItems = [
  { href: '/', label: 'Dashboard' },
  { href: '/chat', label: 'Chat' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/goals', label: 'Goals' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
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
                  className="rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="flex-1 px-8 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
