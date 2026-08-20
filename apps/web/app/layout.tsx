import { loadConfig } from '@assistant/config';
import { hiddenModuleNavHrefs } from '@assistant/modules/meta';
import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import type { CSSProperties, ReactNode } from 'react';
import { auth, authMode } from '@/auth';
import { getAgentIdentity, getApplication } from '@/lib/server';
import { NavCommandsProvider, type NavDestination } from './nav-commands';
import { NotchCompanion } from './notch-companion';
import './globals.css';
import './motion-system.css';
import './chrome.css';
import './conversation.css';
import './mobile-shell.css';
import './notch.css';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

// Sets the .dark class from localStorage or OS preference BEFORE first paint, so
// there is no light→dark flash and OS-dark users still default to dark.
const THEME_SCRIPT = `(()=>{try{const t=localStorage.getItem('theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.jellyMode=d?'dark':'light';}catch{}})()`;

export async function generateMetadata(): Promise<Metadata> {
  const { name } = await getAgentIdentity();
  return {
    title: { default: name, template: `%s · ${name}` },
    description: `${name} — your personal AI assistant`,
    applicationName: name,
    manifest: '/manifest.webmanifest',
    appleWebApp: {
      capable: true,
      title: name,
      // The translucent style is what lets the app canvas continue beneath the
      // clock, Dynamic Island, and notch in an iOS home-screen installation.
      statusBarStyle: 'black-translucent',
    },
    // Keep iOS from inventing tappable phone/address links inside assistant
    // responses. Real links rendered by Markdown are unaffected.
    formatDetection: {
      telephone: false,
      date: false,
      address: false,
      email: false,
      url: false,
    },
    icons: {
      icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
      apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    // Next emits the standards-track mobile-web-app-capable tag for
    // `appleWebApp`; this legacy Apple spelling is still useful on older iOS.
    other: { 'apple-mobile-web-app-capable': 'yes' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Lets the layout reach the physical edges of a notched phone, which is what
  // makes env(safe-area-inset-*) report real values. Without it those insets are
  // always 0 and `.mobile-safe-bottom` — which exists precisely to keep the chat
  // composer off the home indicator — silently does nothing. Every edge that can
  // now reach hardware pads itself from the insets (see `.page-gutter`).
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef5f0' },
    { media: '(prefers-color-scheme: dark)', color: '#121a15' },
  ],
  colorScheme: 'light dark',
};

// The shell badge counts and session lookup are per-request — never prerender.
export const dynamic = 'force-dynamic';

// IA (owner-approved): the chat composer's "/" palette is the whole navigation.
// A flat, typed, searchable list needs no primary/utility/system grouping — the
// two tiers only ever existed to keep a menu panel short. Routes with a real
// parent stay off this list and are linked from it: /import from Documents,
// /tasks/<id> from Activity, /profile/... from Memory.
const navItems: Array<Omit<NavDestination, 'count'>> = [
  {
    href: '/chat',
    label: 'Chat',
    command: '/chat',
    hint: 'Your main thread with the assistant',
    aliases: ['home'],
  },
  {
    href: '/chat/all',
    label: 'All chats',
    command: '/chats',
    hint: 'Every conversation, active and archived',
    aliases: ['history', 'conversations'],
  },
  {
    href: '/approvals',
    label: 'Approvals',
    command: '/approvals',
    hint: 'Actions waiting on your decision',
    aliases: [],
  },
  {
    href: '/tasks',
    label: 'Activity',
    command: '/activity',
    hint: 'What the assistant is working on',
    aliases: ['tasks'],
  },
  {
    href: '/goals',
    label: 'Goals',
    command: '/goals',
    hint: 'Outcomes you are working toward',
    aliases: [],
  },
  {
    href: '/profile',
    label: 'Memory',
    command: '/memory',
    hint: 'What the assistant knows about you',
    aliases: ['profile', 'people'],
  },
  {
    href: '/documents',
    label: 'Documents',
    command: '/documents',
    hint: 'Files the assistant can read',
    aliases: ['files'],
  },
  {
    href: '/skills',
    label: 'Skills',
    command: '/skills',
    hint: 'What the assistant has learned to do',
    aliases: [],
  },
  {
    href: '/settings',
    label: 'Settings',
    command: '/settings',
    hint: 'Identity, models, and behaviour',
    aliases: [],
  },
  {
    href: '/costs',
    label: 'Costs',
    command: '/costs',
    hint: 'What the assistant is spending',
    aliases: ['spend', 'budget'],
  },
  {
    href: '/anomalies',
    label: 'Anomalies',
    command: '/anomalies',
    hint: 'Things that did not look right',
    aliases: [],
  },
  {
    href: '/improvements',
    label: 'Improvements',
    command: '/improvements',
    hint: 'Changes the assistant is proposing',
    aliases: [],
  },
];

/** The one place a destination's badge count comes from. */
function badgeCountFor(
  href: string,
  counts: { pendingApprovals: number; memoryReview: number; needsAttention: number },
): number {
  if (href === '/approvals') return counts.pendingApprovals;
  if (href === '/profile') return counts.memoryReview;
  if (href === '/tasks') return counts.needsAttention;
  return 0;
}

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
  const counts = {
    pendingApprovals: dashboard.pendingApprovals,
    memoryReview: memoryHealth.awaitingReview,
    needsAttention: dashboard.needsAttention,
  };
  const destinations = visibleNavItems.map((item) => ({
    ...item,
    count: badgeCountFor(item.href, counts),
  }));

  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
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
        {/* No navigation chrome in the shell — the destinations ride down to the
            chat composer's "/" palette, and every other surface carries a back
            link. `main` is the whole app column. */}
        {/* The companion lives in the notch: a pair of eyes in a dark housing
            at the top of every page, tucked away until a message moves or the
            shell's presence says work is happening. */}
        <NotchCompanion presence={dashboard.presence} />
        <NavCommandsProvider destinations={destinations} signedIn={!!session?.user}>
          <main className="app-main page-gutter relative z-10 min-w-0 flex-1 py-5 lg:py-7">
            {children}
          </main>
        </NavCommandsProvider>
      </body>
    </html>
  );
}
