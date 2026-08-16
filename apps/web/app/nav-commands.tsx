'use client';

import {
  Brain,
  CircleDollarSign,
  Compass,
  FileText,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

/**
 * Navigation is a composer command, not a control on the page. There is no
 * menu button anywhere in the shell: you type "/" in the chat and pick a
 * destination, and every other surface carries a back link home. This module
 * carries the destinations from the shell — which already loads the badge
 * counts for the whole app — down to the composer that renders them.
 */
export interface NavDestination {
  href: string;
  label: string;
  /** What you type to get there. Not always "/" + label — /tasks is "Activity". */
  command: string;
  /** One line on what the page is for, shown under the command. */
  hint: string;
  /** Other spellings that should match while typing ("tasks" finds Activity). */
  aliases: string[];
  /** Items on that page waiting for the owner; 0 renders no badge. */
  count: number;
}

/** Icons live on this side of the boundary — a component can't be a prop from a
 *  server component, so the shell sends hrefs and the palette looks them up. */
const destinationIcons: Record<string, LucideIcon> = {
  '/chat': MessageCircle,
  '/chat/all': MessagesSquare,
  '/approvals': ShieldCheck,
  '/tasks': ListChecks,
  '/goals': Target,
  '/profile': Brain,
  '/documents': FileText,
  '/skills': Lightbulb,
  '/settings': Settings,
  '/costs': CircleDollarSign,
  '/anomalies': TriangleAlert,
  '/improvements': TrendingUp,
};

export function destinationIcon(href: string): LucideIcon {
  return destinationIcons[href] ?? Compass;
}

/** Counts stop being precise once they stop being actionable. */
export function formatBadgeCount(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
}

interface NavCommands {
  destinations: NavDestination[];
  /** Only a real Google session has anything to sign out of. */
  signedIn: boolean;
}

const NavCommandsContext = createContext<NavCommands>({
  destinations: [],
  signedIn: false,
});

export function useNavCommands(): NavCommands {
  return useContext(NavCommandsContext);
}

export function NavCommandsProvider({
  destinations,
  signedIn,
  children,
}: NavCommands & { children: ReactNode }) {
  const value = useMemo(() => ({ destinations, signedIn }), [destinations, signedIn]);
  return <NavCommandsContext.Provider value={value}>{children}</NavCommandsContext.Provider>;
}
