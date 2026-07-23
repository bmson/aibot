'use client';

import { LoaderCircle } from 'lucide-react';
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
  title,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: BtnVariant;
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
      className={`${btn[variant]} ${className}`}
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
  className = '',
  title,
}: {
  children: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  variant?: BtnVariant;
  className?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();
  const [armed, setArmed] = useState(false);

  if (pending) {
    return (
      <button
        type="submit"
        disabled
        aria-busy="true"
        title={title}
        className={`${btn[variant]} ${className}`}
      >
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
        className={`${btn[variant]} ${className}`}
      >
        {children}
      </button>
    );
  }
  return (
    <button type="submit" title={title} className={`${btn[variant]} ${className}`}>
      {confirmLabel}
    </button>
  );
}
