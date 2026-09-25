'use client';

import { useState } from 'react';
import { RecoveryCodeNotice } from '@/app/setup/recovery-code';
import {
  deviceLabel,
  ownerAuthMessage,
  registerPasskey,
  signInWithPasskey,
} from '@/lib/owner-auth/client';
import { btn, inputClass, labelClass } from '@/lib/ui';

export function SignInClient() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);

  if (newRecoveryCode)
    return <RecoveryCodeNotice code={newRecoveryCode} continueHref="/security" />;

  return (
    <div className="grid gap-6">
      <div>
        <button
          type="button"
          className={btn.primary}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await signInWithPasskey();
              window.location.assign('/chat');
            } catch (failure) {
              setError(ownerAuthMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && !recovering ? 'Waiting for passkey…' : 'Sign in with passkey'}
        </button>
      </div>

      {recovering ? (
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await registerPasskey('/api/owner/recovery', { code }, deviceLabel());
              setNewRecoveryCode(String(result.recoveryCode ?? ''));
            } catch (failure) {
              setError(ownerAuthMessage(failure));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className={labelClass} htmlFor="recovery-code">
            Recovery code
          </label>
          <input
            id="recovery-code"
            className={`${inputClass} font-mono`}
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <p className="text-xs leading-5 text-muted">
            The recovery code adds a passkey on this device, replaces the code, and signs out every
            other browser. If you lost it, the Google Cloud project owner can issue a recovery link
            with the installer.
          </p>
          <div>
            <button type="submit" className={btn.outline} disabled={busy || code.length < 25}>
              Add passkey with recovery code
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="w-fit text-sm text-muted underline"
          onClick={() => setRecovering(true)}
        >
          Lost your passkey?
        </button>
      )}

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
