'use client';

import { MobileNavMenu } from './mobile-nav-menu';

interface NavItem {
  href: string;
  label: string;
  utility?: boolean;
  system?: boolean;
}

export function AppNav({
  navItems,
  pendingApprovals,
  signedIn,
  memoryReviewCount,
  needsAttentionCount,
}: {
  navItems: NavItem[];
  pendingApprovals: number;
  signedIn: boolean;
  memoryReviewCount: number;
  needsAttentionCount: number;
}) {
  return (
    <MobileNavMenu
      navItems={navItems}
      pendingApprovals={pendingApprovals}
      signedIn={signedIn}
      memoryReviewCount={memoryReviewCount}
      needsAttentionCount={needsAttentionCount}
    />
  );
}
