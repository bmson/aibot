'use client';

import { LoaderCircle } from 'lucide-react';
import type { ReactNode, ToggleEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { btn, btnSm } from './ui';

type BtnVariant = keyof typeof btn;

// Size the button by choosing the scale here — never by passing btnSm.* through
// className (that stacks h-9 and h-8 utilities on one element and the winner is
// stylesheet order, not intent). 'md' is the default; 'sm' is for list rows.
const btnScale = { md: btn, sm: btnSm } as const;

/**
 * A server-action submit button that disables itself and shows a pending label
 * while the action runs (via useFormStatus) — so the plain-form buttons that
 * used to be silently double-submittable now give feedback. Drop into any
 * <form action={serverAction}>.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Working…',
  variant = 'outline',
  size = 'md',
  className = '',
  title,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      title={title}
      className={`${btnScale[size][variant]} ${className}`}
    >
      {pending ? (
        <>
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/**
 * A dropdown of secondary actions behind a trigger button. The panel is a
 * native `popover`, so it renders in the top layer — it can never be clipped
 * by an `overflow-hidden` card shell — and light-dismiss (outside click,
 * Escape) comes from the platform. Placement is viewport-aware: the panel
 * opens downward and flips above the trigger when the fold would cut it off.
 *
 * Clicking a link or an element marked `data-menu-close` closes the panel;
 * everything else (submit buttons, two-step confirms) keeps it open so
 * pending labels and arm states stay visible until the action lands.
 */
export function ActionMenu({
  label = 'More',
  trigger,
  triggerClassName,
  triggerTitle,
  triggerAriaCurrent,
  variant = 'outline',
  size = 'md',
  panelClassName = 'w-56',
  className = '',
  onOpenChange,
  children,
}: {
  label?: ReactNode;
  /** Replaces `label` inside the trigger button — for callers that need the
      trigger to look like something other than a standard button (e.g. a nav
      tile). Pairs with `triggerClassName`. */
  trigger?: ReactNode;
  /** Full className override for the trigger button; `label`/btnScale styling
      applies only when this is omitted. */
  triggerClassName?: string;
  triggerTitle?: string;
  /** For a trigger standing in for a nav link to the page you're already on. */
  triggerAriaCurrent?: 'page';
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  /** Sizing/extra classes for the panel; keep a width here so placement can measure. */
  panelClassName?: string;
  className?: string;
  /** Fires on every open/close, e.g. to lazy-load panel content on first open. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel?.matches(':popover-open')) return;
    const edge = 8;
    const rect = trigger.getBoundingClientRect();
    const fitsBelow = window.innerHeight - rect.bottom >= panel.offsetHeight + edge * 2;
    const flipUp = !fitsBelow && rect.top >= panel.offsetHeight + edge * 2;
    panel.style.top = `${flipUp ? rect.top - panel.offsetHeight - edge : rect.bottom + edge}px`;
    panel.style.left = `${Math.max(
      edge,
      Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - edge),
    )}px`;
  }, []);

  // The trigger can move under an open panel (window resize, any scroll).
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="true"
        aria-expanded={open}
        aria-current={triggerAriaCurrent}
        title={triggerTitle}
        className={triggerClassName ?? `${btnScale[size][variant]} ${className}`}
        onClick={() => {
          panelRef.current?.togglePopover();
          place(); // togglePopover is synchronous; placing now avoids a first-frame jump
        }}
      >
        {trigger ?? label}
      </button>
      {/* Click delegation, not an interactive element itself: menu items are real
          buttons/links (keyboard-activatable), and Escape closes via the popover. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on items fires click; Escape is native */}
      <div
        ref={panelRef}
        popover="auto"
        onToggle={(event: ToggleEvent<HTMLDivElement>) => {
          const isOpen = event.newState === 'open';
          setOpen(isOpen);
          onOpenChange?.(isOpen);
          if (isOpen) place();
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a, [data-menu-close]')) {
            panelRef.current?.hidePopover();
          }
        }}
        // Open/close motion lives in globals.css on [popover] — a keyframe here
        // would only play on enter and would fight the exit transition.
        className={`scroll-subtle fixed inset-auto z-50 m-0 max-h-[min(24rem,calc(100vh-1rem))] flex-col gap-2 overflow-y-auto rounded-xl border border-edge bg-raised p-3 shadow-lg [&:popover-open]:flex ${panelClassName}`}
      >
        {children}
      </div>
    </>
  );
}

/**
 * A two-step confirm for a destructive server action: the first click arms
 * ("Confirm?") and a second within 3s submits; otherwise it reverts. No modal,
 * no new deps — enough friction to stop an accidental Deny/Delete.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Confirm?',
  pendingLabel = 'Working…',
  variant = 'dangerOutline',
  size = 'md',
  className = '',
  title,
}: {
  children: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  const [armed, setArmed] = useState(false);
  const base = `${btnScale[size][variant]} ${className}`;

  if (pending) {
    return (
      <button type="submit" disabled aria-busy="true" title={title} className={base}>
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        {pendingLabel}
      </button>
    );
  }
  if (!armed) {
    return (
      <button
        type="button"
        title={title}
        onClick={() => {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
        }}
        className={base}
      >
        {children}
      </button>
    );
  }
  return (
    <button type="submit" title={title} className={base}>
      {confirmLabel}
    </button>
  );
}
