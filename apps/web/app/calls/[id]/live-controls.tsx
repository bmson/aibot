'use client';

import { LoaderCircle, PhoneOff, Send } from 'lucide-react';
import { useState, useTransition } from 'react';
import { answerCheckinAction, hangUpAction } from '@/app/calls/actions';
import { btn, inputClass } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

/** What the owner can do while a call is live: answer a check-in, or end it. */
export function LiveCallControls({
  callId,
  checkin,
}: {
  callId: string;
  checkin: { id: string; question: string } | null;
}) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action().catch(() => ({ error: 'That did not go through. Try again.' }));
      if (result.error) setError(result.error);
      else after?.();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {checkin && !sent ? (
        <form
          className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => answerCheckinAction({ callId, checkinId: checkin.id, answer }),
              () => setSent(true),
            );
          }}
        >
          <p className="text-sm font-medium text-strong">The assistant is asking you</p>
          <p className="mt-1 text-base leading-6 text-strong">“{checkin.question}”</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              required
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Your answer, e.g. “Yes, 7:30 is fine”"
              className={`${inputClass} min-w-0 flex-1 basis-60`}
              maxLength={1_000}
            />
            <button type="submit" disabled={pending} className={btn.primary}>
              {pending ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            The other person is on hold. After about a minute the assistant tells them it will
            confirm later.
          </p>
        </form>
      ) : null}
      {sent ? <p className="text-sm text-muted">Sent — the assistant has your answer.</p> : null}
      <div>
        <ConfirmButton
          disabled={pending}
          confirmLabel="Confirm hang up"
          title="End this call now"
          onConfirm={() => run(() => hangUpAction(callId))}
        >
          <PhoneOff className="size-4" />
          Hang up
        </ConfirmButton>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
