'use client';

import { useState } from 'react';
import { btn } from '@/lib/ui';

/** Shows a new offline recovery code once and requires acknowledgement before continuing. */
export function RecoveryCodeNotice({
  code,
  continueHref,
}: {
  code: string;
  continueHref?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Save this recovery code somewhere safe and offline, such as a password manager or paper. It
        is shown only once. It lets you add a new passkey if you lose this device.
      </p>
      <code className="rounded-md border border-amber-300 bg-white px-3 py-2 text-center font-mono text-lg tracking-wider text-strong select-all dark:border-amber-800 dark:bg-amber-950">
        {code}
      </code>
      <label className="flex items-center gap-2 text-sm text-strong">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I saved the recovery code
      </label>
      {continueHref ? (
        <div>
          <a
            href={saved ? continueHref : undefined}
            aria-disabled={!saved}
            className={`${btn.primary} ${saved ? '' : 'pointer-events-none opacity-50'}`}
          >
            Continue
          </a>
        </div>
      ) : null}
    </div>
  );
}
