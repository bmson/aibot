'use client';

import { useState } from 'react';
import { rotateMobileToken } from '@/app/settings/actions';
import { btnSm } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

/**
 * Pairing panel for the iOS app.
 *
 * The stored token NEVER reaches the browser: the server sends only a masked
 * preview (`ab12cd…wxyz`). The full value is visible exactly once — in the
 * response of the rotate action, held in component state until the page
 * changes — mirroring how GitHub PATs and Cloud providers handle their
 * tokens. An owner who needs a working key rotates and copies the fresh one.
 *
 * Rotation is only offered when the server has a writable .env (local and
 * self-hosted installs). Cloud Run installs manage the value through Secret
 * Manager, so the panel shows the CLI steps instead of a button whose effect
 * would silently revert on the next instance recycle.
 */
export function MobileTokenPanel({
  maskedToken,
  serverUrl,
  canRotate,
}: {
  /** Masked preview like `ab12cd…wxyz`, or null when no token is configured. */
  maskedToken: string | null;
  serverUrl: string;
  canRotate: boolean;
}) {
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context, permission denied) — the
      // field stays selectable for manual copy.
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-muted">Assistant server</span>
          <code className="min-w-0 truncate rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-sm text-strong select-all">
            {serverUrl}
          </code>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-muted">Mobile access key</span>
          <code className="min-w-0 truncate rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-sm text-strong select-all">
            {maskedToken ?? 'Not configured'}
          </code>
        </div>
      </div>

      <p className="text-xs leading-5 text-muted">
        Enter these two values in the iPhone app’s Connection screen. The key is stored in the
        device Keychain and sent only to this server. For security the stored key is never shown
        here — rotating generates a new one you can copy once, and invalidates the old key
        immediately.
      </p>

      {freshToken ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
          <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            New key — copy it now. It won’t be shown again.
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-emerald-300 bg-white px-3 py-2 font-mono text-sm text-strong select-all dark:border-emerald-800 dark:bg-emerald-950">
              {freshToken}
            </code>
            <button
              type="button"
              onClick={() => copy(freshToken)}
              className={btnSm.outline}
              title="Copy the new key"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            Update the Connection screen on your phone — the previous key no longer works.
          </span>
        </div>
      ) : null}

      {canRotate ? (
        <div>
          <form
            action={async () => {
              setError(null);
              setFreshToken(null);
              const result = await rotateMobileToken();
              if (result.error) {
                setError(result.error);
              } else if (result.token) {
                setFreshToken(result.token);
              }
            }}
          >
            <ConfirmButton
              variant="dangerOutline"
              size="sm"
              pendingLabel={maskedToken ? 'Rotating…' : 'Generating…'}
              confirmLabel={maskedToken ? 'Confirm rotate' : 'Confirm generate'}
              title={
                maskedToken
                  ? 'Generate a new key and invalidate the current one'
                  : 'Generate a mobile access key'
              }
            >
              {maskedToken ? 'Rotate key' : 'Generate key'}
            </ConfirmButton>
          </form>
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted">
          This server has neither a writable <code>.env</code> nor a <code>GCP_PROJECT</code>, so
          there is nowhere to persist a new key. Set <code>MOBILE_API_TOKEN</code> in the
          environment directly.
        </p>
      )}

      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
