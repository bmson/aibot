'use client';

import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
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
