import { loadConfig } from '@assistant/config';
import { hiddenModuleNavHrefs } from '@assistant/modules/meta';
import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import type { CSSProperties, ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getAgentIdentity, getApplication } from '@/lib/server';
import { AppNav } from './app-nav';
import './globals.css';
import './motion-system.css';
import './visual-refinement.css';
import './conversation-polish.css';
import './navigation-rethink.css';
import './navigation-bloom.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });
// Display face for titles only — body/UI text stays Inter. One variable to
// revert (--font-display in globals).
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

// Sets the .dark class from localStorage or OS preference BEFORE first paint, so
// there is no light→dark flash and OS-dark users still default to dark.
const THEME_SCRIPT = `(()=>{try{const t=localStorage.getItem('theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.jellyMode=d?'dark':'light';}catch{}})()`;

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

// The shell badge counts and session lookup are per-request — never prerender.
export const dynamic = 'force-dynamic';

// IA (owner-approved): five primary destinations, a small Manage group, and a
// collapsed System group for the self-monitoring pages. Routes that left the
// navigation stay alive and linked from their parent surface — /chat/all from
// the chat header, /import from the Documents page.
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
  const config = loadConfig();
  const hiddenNav = hiddenModuleNavHrefs(config);
  const visibleNavItems = navItems.filter((item) => !hiddenNav.has(item.href));
  const identity = await getAgentIdentity();
  const [shell, session] = await Promise.all([
    identity.id
      ? getApplication()
          .getShellStatus(identity.id)
          .catch((error) => {
            console.error('[layout] failed to load shell status', error);
            return {
              dashboard: { pendingApprovals: 0, needsAttention: 0, presence: 'idle' as const },
              memoryHealth: {
                totalUsable: 0,
                notYetOrganized: 0,
                awaitingReview: 0,
                ownerConfirmed: 0,
                lastOrganizedAt: null,
              },
            };
          })
      : Promise.resolve({
          dashboard: { pendingApprovals: 0, needsAttention: 0, presence: 'idle' as const },
          memoryHealth: {
            totalUsable: 0,
            notYetOrganized: 0,
            awaitingReview: 0,
            ownerConfirmed: 0,
            lastOrganizedAt: null,
          },
        }),
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
  const { dashboard, memoryHealth } = shell;
  const { pendingApprovals, needsAttention: needsAttentionCount } = dashboard;

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
      {/* The page column is a flex stack: the dev banner is a fixed row and the
          shell takes exactly what is left. `--app-chrome` carries the banner's
          height to viewport-positioned shell controls and the chat column. */}
      <body
        style={{ '--app-chrome': authMode === 'dev-bypass' ? '1.5rem' : '0px' } as CSSProperties}
        className="flex min-h-dvh flex-col bg-surface font-sans text-strong antialiased"
      >
        {/* Jelly UI is intentionally limited to compact controls and live counts.
            The CSP in next.config.ts pins script execution to this origin plus
            'self', so no other remote script can run even if injected. */}
        <Script src="https://jelly-ui.com/package.js" type="module" strategy="afterInteractive" />
        {authMode === 'dev-bypass' ? (
          <div className="flex h-6 shrink-0 items-center justify-center bg-amber-100 px-4 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            dev mode — auth disabled
          </div>
        ) : null}
        <div className="flex flex-1 flex-col lg:flex-row">
          <AppNav
            navItems={visibleNavItems}
            pendingApprovals={pendingApprovals}
            signedIn={!!session?.user}
            memoryReviewCount={memoryHealth.awaitingReview}
            needsAttentionCount={needsAttentionCount}
          />
          <main className="page-gutter min-w-0 flex-1 py-5 lg:py-7">{children}</main>
        </div>
      </body>
    </html>
  );
}
