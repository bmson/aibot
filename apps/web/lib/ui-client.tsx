'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { btn } from './ui';

type BtnVariant = keyof typeof btn;

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
  className = '',
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: BtnVariant;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${btn[variant]} ${className}`}>
      {pending ? pendingLabel : children}
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
  className = '',
}: {
  children: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  variant?: BtnVariant;
  className?: string;
}) {
  const { pending } = useFormStatus();
  const [armed, setArmed] = useState(false);

  if (pending) {
    return (
      <button type="submit" disabled className={`${btn[variant]} ${className}`}>
        {pendingLabel}
      </button>
    );
  }
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
        }}
        className={`${btn[variant]} ${className}`}
      >
        {children}
      </button>
    );
  }
  return (
    <button type="submit" className={`${btn[variant]} ${className}`}>
      {confirmLabel}
    </button>
  );
}
