import { approvals, tasks } from '@assistant/db';
import { count, eq } from 'drizzle-orm';
import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';
import { AppNav } from './app-nav';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });
// Display face for titles, the brand lockup, and the Home greeting only —
// body/UI text stays Inter. One variable to revert (--font-display in globals).
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

// Sets the .dark class from localStorage or OS preference BEFORE first paint, so
// there is no light→dark flash and OS-dark users still default to dark.
const THEME_SCRIPT = `(()=>{try{const t=localStorage.getItem('theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);}catch{}})()`;

export async function generateMetadata(): Promise<Metadata> {
  const { name } = await getAgentIdentity();
  return {
    title: { default: name, template: `%s · ${name}` },
    description: `${name} — your personal AI assistant`,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// The sidebar badge (DB) and session lookup are per-request — never prerender.
export const dynamic = 'force-dynamic';

// IA (owner-approved): six primary destinations, a small Manage group, and a
// collapsed System group for the self-monitoring pages. Routes that left the
// rail stay alive and linked from their parent surface — /chat/all from the
// chat header, /import from the Documents page.
const navItems = [
  { href: '/', label: 'Home' },
  { href: '/chat', label: 'Chat' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/tasks', label: 'Activity' },
  { href: '/goals', label: 'Goals' },
  { href: '/profile', label: 'Memory' },
  { href: '/documents', label: 'Documents', utility: true },
  { href: '/skills', label: 'Skills', utility: true },
  { href: '/settings', label: 'Settings', utility: true },
  { href: '/costs', label: 'Costs', system: true },
  { href: '/anomalies', label: 'Anomalies', system: true },
  { href: '/improvements', label: 'Improvements', system: true },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [pendingApprovals, session, identity, working] = await Promise.all([
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
    getAgentIdentity(),
    // Presence: the brand mark breathes while anything is actively running.
    // Refreshes with every route render/AutoRefresh — no extra poller.
    (async () => {
      try {
        const [runningRow] = await getDb()
          .select({ value: count() })
          .from(tasks)
          .where(eq(tasks.status, 'running'));
        return (runningRow?.value ?? 0) > 0;
      } catch {
        return false;
      }
    })(),
  ]);

  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-surface font-sans text-strong antialiased">
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
            agentName={identity.name}
            working={working}
          />
          <main className="min-w-0 flex-1 px-4 py-6 lg:px-10 lg:py-9">{children}</main>
        </div>
      </body>
    </html>
  );
}
