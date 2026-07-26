import { getMemoryHealth } from '@assistant/core';
import { approvals, tasks } from '@assistant/db';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import type { CSSProperties, ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';
import { AppNav } from './app-nav';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });
// Display face for titles and the brand lockup only — body/UI text stays
// Inter. One variable to revert (--font-display in globals).
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

// Sets the .dark class from localStorage or OS preference BEFORE first paint, so
// there is no light→dark flash and OS-dark users still default to dark.
const THEME_SCRIPT = `(()=>{try{const t=localStorage.getItem('theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.jellyMode=d?'dark':'light';}catch{}})()`;

// Same shape as THEME_SCRIPT: stamps the rail's collapsed state pre-paint so
// there's no flash of the wrong width on load.
const NAV_SCRIPT = `(()=>{try{document.documentElement.classList.toggle('nav-collapsed',localStorage.getItem('nav-collapsed')==='1');}catch{}})()`;

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
  // Lets the layout reach the physical edges of a notched phone, which is what
  // makes env(safe-area-inset-*) report real values. Without it those insets are
  // always 0 and `.mobile-safe-bottom` — which exists precisely to keep the chat
  // composer off the home indicator — silently does nothing. Every edge that can
  // now reach hardware pads itself from the insets (see `.page-gutter`).
  viewportFit: 'cover',
};

// The sidebar badge (DB) and session lookup are per-request — never prerender.
export const dynamic = 'force-dynamic';

// IA (owner-approved): five primary destinations, a small Manage group, and a
// collapsed System group for the self-monitoring pages. Routes that left the
// rail stay alive and linked from their parent surface — /chat/all from the
// chat header, /import from the Documents page.
const navItems = [
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
  const identity = await getAgentIdentity();
  const [pendingApprovals, session, presenceRows, memoryHealth] = await Promise.all([
    (async () => {
      try {
        const [pendingRow] = await getDb()
          .select({ value: count() })
          .from(approvals)
          .innerJoin(tasks, eq(approvals.taskId, tasks.id))
          .where(
            and(
              eq(tasks.agentId, identity.id),
              eq(approvals.status, 'pending'),
              gt(approvals.expiresAt, sql`now()`),
            ),
          );
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
    (async () => {
      try {
        return await getDb()
          .select({ status: tasks.status, value: count() })
          .from(tasks)
          .where(
            and(
              eq(tasks.agentId, identity.id),
              inArray(tasks.status, ['running', 'needs_attention']),
            ),
          )
          .groupBy(tasks.status);
      } catch {
        return [];
      }
    })(),
    identity.id
      ? getMemoryHealth(getDb(), identity.id).catch(() => ({
          totalUsable: 0,
          notYetOrganized: 0,
          awaitingReview: 0,
          ownerConfirmed: 0,
          lastOrganizedAt: null,
        }))
      : Promise.resolve({
          totalUsable: 0,
          notYetOrganized: 0,
          awaitingReview: 0,
          ownerConfirmed: 0,
          lastOrganizedAt: null,
        }),
  ]);
  const needsAttentionCount =
    presenceRows.find((row) => row.status === 'needs_attention')?.value ?? 0;
  const presence =
    pendingApprovals > 0 || needsAttentionCount > 0
      ? 'attention'
      : presenceRows.some((row) => row.status === 'running' && row.value > 0)
        ? 'working'
        : 'idle';

  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash theme script */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static no-flash nav-collapse script */}
        <script dangerouslySetInnerHTML={{ __html: NAV_SCRIPT }} />
      </head>
      {/* The page column is a flex stack: the dev banner is a fixed row and the
          shell takes exactly what is left. It used to be `min-h-screen` sitting
          *below* the banner, which made the document 24px taller than the
          viewport on every single page — the whole app scrolled by the height
          of the banner even when nothing overflowed. `--app-chrome` carries the
          banner's height to the two places that size themselves against the
          viewport directly (the rail, and the chat column). */}
      <body
        style={{ '--app-chrome': authMode === 'dev-bypass' ? '1.5rem' : '0px' } as CSSProperties}
        className="flex min-h-dvh flex-col bg-surface font-sans text-strong antialiased"
      >
        {/* The pinned Jelly runtime powers tactile primary actions, optional
            free-text fields, tabs, and compact icon controls. Navigation links,
            native-validation fields, and destructive confirmations stay native. */}
        <Script
          src="/vendor/jelly-ui/d898ec9/jelly.js"
          type="module"
          strategy="afterInteractive"
          crossOrigin="anonymous"
        />
        {authMode === 'dev-bypass' ? (
          <div className="flex h-6 shrink-0 items-center justify-center bg-amber-100 px-4 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            dev mode — auth disabled
          </div>
        ) : null}
        <div className="flex flex-1 flex-col lg:flex-row">
          <AppNav
            navItems={navItems}
            pendingApprovals={pendingApprovals}
            signedIn={!!session?.user}
            agentName={identity.name}
            presence={presence}
            memoryReviewCount={memoryHealth.awaitingReview}
            needsAttentionCount={needsAttentionCount}
          />
          <main className="app-workspace page-gutter min-w-0 flex-1 py-7 lg:my-4 lg:mr-4 lg:rounded-[1.75rem] lg:border lg:border-edge/80 lg:bg-raised/55 lg:py-10 lg:shadow-[0_24px_70px_-42px_rgb(23_25_35/0.34)] xl:my-5 xl:mr-5">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
