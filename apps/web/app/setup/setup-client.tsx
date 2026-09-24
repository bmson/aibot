'use client';

import { useEffect, useState } from 'react';
import { deviceLabel, ownerAuthMessage, registerPasskey } from '@/lib/owner-auth/client';
import { btn } from '@/lib/ui';
import { RecoveryCodeNotice } from './recovery-code';

/**
 * The installer prints `/setup#claim=CODE`. The fragment never reaches the
 * server or its logs; it is read here and removed from the address bar and
 * history before anything else happens.
 */
export function SetupClient() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    const match = /(?:^|[#&])claim=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    setCode(match?.[1] ?? '');
  }, []);

  if (recoveryCode) return <RecoveryCodeNotice code={recoveryCode} continueHref="/chat" />;

  if (code === '')
    return (
      <p className="text-sm text-muted">
        Open the setup link printed by the installer. It contains a one-time claim code and is valid
        for 24 hours. If it expired, run the installer&apos;s owner-claim step again.
      </p>
    );

  return (
    <div className="grid gap-4">
      <p className="text-base leading-6 text-muted">
        Create a passkey on this device. It replaces a password: your device unlocks it with Face
        ID, Touch ID, or its screen lock. No Google sign-in or email is involved.
      </p>
      <div>
        <button
          type="button"
          className={btn.primary}
          disabled={busy || code === null}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await registerPasskey(
                '/api/owner/claim',
                { code: code ?? '' },
                deviceLabel(),
              );
              setRecoveryCode(String(result.recoveryCode ?? ''));
            } catch (failure) {
              setError(ownerAuthMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Waiting for passkey…' : 'Create passkey'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
