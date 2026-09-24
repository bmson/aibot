'use client';

import { useCallback, useEffect, useState } from 'react';
import { RecoveryCodeNotice } from '@/app/setup/recovery-code';
import { deviceLabel, ownerAuthMessage, ownerPost, registerPasskey } from '@/lib/owner-auth/client';
import { btn, btnSm, inputClass, labelClass } from '@/lib/ui';

type Passkey = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  backedUp: boolean;
};
type Device = { id: string; name: string; createdAt: string; revokedAt: string | null };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  if (response.status === 401) {
    window.location.assign('/signin');
    throw new Error('signed out');
  }
  if (!response.ok) throw new Error('request failed');
  return (await response.json()) as T;
}

const date = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

export function SecurityClient({ serverUrl }: { serverUrl: string }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('iPhone');

  const refresh = useCallback(async () => {
    const [keys, phones] = await Promise.all([
      getJson<{ passkeys: Passkey[] }>('/api/owner/passkeys'),
      getJson<{ devices: Device[] }>('/api/owner/devices'),
    ]);
    setPasskeys(keys.passkeys);
    setDevices(phones.devices);
  }, []);

  useEffect(() => {
    refresh().catch(() => setError('Could not load security settings.'));
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(ownerAuthMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const active = passkeys.filter((key) => !key.revokedAt);

  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold text-strong">Passkeys</h2>
        <p className="text-sm text-muted">
          Keep at least two: add one on another device or a hardware key so losing a phone does not
          lock you out. Removing a passkey signs out every browser.
        </p>
        <ul className="grid gap-2">
          {active.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-strong">{key.label}</span>
                <span className="block text-xs text-muted">
                  Added {date(key.createdAt)} · last used {date(key.lastUsedAt)}
                  {key.backedUp ? ' · synced' : ''}
                </span>
              </span>
              <button
                type="button"
                className={btnSm.dangerOutline}
                disabled={busy || active.length < 2}
                onClick={() =>
                  run(async () => {
                    await ownerPost(
                      `/api/owner/passkeys?id=${encodeURIComponent(key.id)}`,
                      {},
                      'DELETE',
                    );
                    window.location.assign('/signin');
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div>
          <button
            type="button"
            className={btn.outline}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await registerPasskey('/api/owner/passkeys', {}, deviceLabel());
                await refresh();
              })
            }
          >
            Add a passkey
          </button>
        </div>
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold text-strong">Recovery code</h2>
        <p className="text-sm text-muted">
          Generating a new code invalidates the old one immediately.
        </p>
        {recoveryCode ? <RecoveryCodeNotice code={recoveryCode} /> : null}
        <div>
          <button
            type="button"
            className={btn.outline}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await ownerPost('/api/owner/recovery-code', {});
                setRecoveryCode(String(result.recoveryCode ?? ''));
              })
            }
          >
            Generate a new recovery code
          </button>
        </div>
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold text-strong">iPhone and other devices</h2>
        <p className="text-sm text-muted">
          Each device gets its own key, which you can revoke without affecting the others. Enter the
          server address and key in the app&apos;s Connection screen; the key is shown once.
        </p>
        <code className="w-fit rounded-md border border-edge bg-sunken px-3 py-2 font-mono text-sm select-all">
          {serverUrl}
        </code>
        {deviceToken ? (
          <div className="grid gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Device key — copy it now. It won&apos;t be shown again.
            </span>
            <code className="font-mono text-sm break-all select-all">{deviceToken}</code>
          </div>
        ) : null}
        <ul className="grid gap-2">
          {devices
            .filter((device) => !device.revokedAt)
            .map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2"
              >
                <span className="text-sm text-strong">
                  {device.name}{' '}
                  <span className="text-xs text-muted">added {date(device.createdAt)}</span>
                </span>
                <button
                  type="button"
                  className={btnSm.dangerOutline}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await ownerPost(
                        `/api/owner/devices?id=${encodeURIComponent(device.id)}`,
                        {},
                        'DELETE',
                      );
                      await refresh();
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await ownerPost('/api/owner/devices', { name: deviceName });
              setDeviceToken(String(result.token ?? ''));
              await refresh();
            });
          }}
        >
          <label className="grid gap-1">
            <span className={labelClass}>Device name</span>
            <input
              className={inputClass}
              value={deviceName}
              maxLength={80}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </label>
          <button type="submit" className={btn.outline} disabled={busy}>
            Create device key
          </button>
        </form>
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold text-strong">Sessions</h2>
        <div>
          <button
            type="button"
            className={btn.dangerOutline}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await ownerPost('/api/owner/logout', { everywhere: true });
                window.location.assign('/signin');
              })
            }
          >
            Sign out everywhere
          </button>
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
