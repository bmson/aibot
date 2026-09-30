import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { authMode, isAuthed } from '@/auth';
import { focusRing } from '@/lib/ui';
import './globals.css';

const THEME_SCRIPT = `(()=>{try{const t=localStorage.getItem('theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.jellyMode=d?'dark':'light';}catch{}})()`;

export const metadata: Metadata = {
  title: { default: 'Assistant settings', template: '%s · Assistant' },
  description: 'Mobile access and diagnostics for your assistant.',
  icons: { icon: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const owner = await isAuthed();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-surface font-sans text-strong antialiased">
        {authMode === 'dev-bypass' ? (
          <p className="bg-amber-100 p-2 text-center text-xs text-amber-900">
            Development mode — authentication disabled
          </p>
        ) : null}
        <header className="border-b border-edge">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-5">
            <Link href="/settings" className={`text-lg font-semibold ${focusRing}`}>
              Assistant
            </Link>
            {owner ? (
              <nav aria-label="Administration" className="flex gap-6 text-sm">
                <Link
                  href="/settings"
                  className={`inline-flex min-h-11 items-center hover:underline ${focusRing}`}
                >
                  Settings
                </Link>
                <Link
                  href="/audit"
                  className={`inline-flex min-h-11 items-center hover:underline ${focusRing}`}
                >
                  Audit trail
                </Link>
              </nav>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-5 py-10">{children}</main>
      </body>
    </html>
  );
}
