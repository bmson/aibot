'use client';

import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ActionButton, Modal } from '@/lib/ui-client';

/** Keep the action short; review the server-derived permission before saving it. */
export function AlwaysApproveButton({
  scope,
  disabled = false,
  pending: pendingProp = false,
  size = 'md',
  className = '',
  onConfirm,
}: {
  scope: string;
  disabled?: boolean;
  pending?: boolean;
  size?: 'md' | 'sm';
  className?: string;
  onConfirm?: () => void;
}) {
  const { pending: formPending } = useFormStatus();
  const pending = formPending || pendingProp;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled || pending) setOpen(false);
  }, [disabled, pending]);

  return (
    <div ref={containerRef} className="contents">
      <ActionButton
        variant="outline"
        size={size}
        className={className}
        disabled={disabled}
        pending={pending}
        pendingLabel="Saving…"
        onClick={() => setOpen(true)}
      >
        <ShieldCheck aria-hidden="true" />
        Always approve
      </ActionButton>
      {open ? (
        <Modal
          label="Always approve matching actions?"
          onClose={() => setOpen(false)}
          panelClassName="max-w-lg gap-4"
        >
          <h3 className="text-lg font-semibold">Always approve matching actions?</h3>
          <p className="text-sm leading-6 text-strong [overflow-wrap:anywhere]">{scope}</p>
          <p className="text-sm leading-6 text-muted">
            This approves the current request and saves this permission for future matching actions.
            You can pause or remove it in the mobile app under More → Standing approvals.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton onClick={() => setOpen(false)}>Cancel</ActionButton>
            <ActionButton
              variant="primary"
              disabled={disabled || pending}
              onClick={() => {
                if (disabled || pending) return;
                setOpen(false);
                if (onConfirm) onConfirm();
                else containerRef.current?.closest('form')?.requestSubmit();
              }}
            >
              <ShieldCheck aria-hidden="true" />
              Approve and save
            </ActionButton>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
