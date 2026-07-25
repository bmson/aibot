'use client';

import { ArrowRight, LoaderCircle, Settings } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { focusRing } from '@/lib/ui';
import { ActionMenu } from '@/lib/ui-client';
import { getSettingsSummary, type SettingsSummary } from './actions';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: SettingsSummary };

/**
 * The Settings nav tile, collapsed-rail edition: instead of navigating away
 * (the only feedback in an icon-only rail is which page you land on), it
 * opens a popover with the real settings content. Data is fetched lazily on
 * first open rather than joined into the layout's own data — nothing outside
 * the settings page should pay for these queries on every navigation.
 */
export function SettingsPopoverTile({ active }: { active: boolean }) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });

  const load = () => {
    if (state.status === 'loading' || state.status === 'ready') return;
    setState({ status: 'loading' });
    getSettingsSummary()
      .then((data) => setState({ status: 'ready', data }))
      .catch(() => setState({ status: 'error' }));
  };

  return (
    <ActionMenu
      trigger={
        <>
          <span className="flex size-10 shrink-0 items-center justify-center">
            <span
              className={`flex size-6 items-center justify-center rounded-md ${active ? 'bg-white/15' : ''}`}
            >
              <Settings
                className={`size-4 shrink-0 ${active ? '' : 'opacity-70'}`}
                aria-hidden="true"
              />
            </span>
          </span>
          <span />
          <span />
        </>
      }
      triggerTitle="Settings"
      triggerAriaCurrent={active ? 'page' : undefined}
      triggerClassName={`nav-tile mobile-touch-target relative grid h-10 w-full grid-cols-[2.5rem_1fr_auto] items-center gap-1 rounded-lg pr-3 text-sm motion-safe:transition-colors ${focusRing} ${
        active
          ? 'bg-accent font-semibold text-white'
          : 'font-medium text-zinc-600 hover:bg-sunken hover:text-strong active:bg-sunken dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
      panelClassName="w-80"
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <SettingsSummaryContent state={state} />
    </ActionMenu>
  );
}

function SettingsSummaryContent({ state }: { state: LoadState }) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        Loading settings…
      </div>
    );
  }
  if (state.status === 'error') {
    return <p className="px-1 py-2 text-sm text-muted">Couldn’t load settings.</p>;
  }

  const { data } = state;
  return (
    <div className="flex flex-col gap-4 px-1 py-1">
      <div className="flex items-center justify-between gap-2">
        <p className="font-display text-sm font-semibold text-strong">Settings</p>
        <Link
          href="/settings"
          className={`inline-flex items-center gap-1 rounded text-xs font-medium text-accent hover:underline ${focusRing}`}
        >
          Open full settings
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>

      <div>
        <p className="text-2xs font-semibold tracking-[0.14em] text-muted uppercase">Assistant</p>
        <p className="mt-1 text-sm text-strong">{data.agent.name}</p>
        <p className="text-xs text-muted">
          {data.agent.email} · {data.agent.timezone}
        </p>
      </div>

      <div>
        <p className="text-2xs font-semibold tracking-[0.14em] text-muted uppercase">
          Recurring jobs{data.schedules.length > 0 ? ` (${data.schedules.length})` : ''}
        </p>
        {data.schedules.length === 0 ? (
          <p className="mt-1 text-xs text-muted">No recurring jobs yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {data.schedules.map((s) => (
              <li key={s.id} className="text-xs">
                <span className={`font-medium ${s.enabled ? 'text-strong' : 'text-muted'}`}>
                  {s.title}
                </span>
                {s.enabled ? null : ' · Paused'}
                <span className="block text-muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {data.goalAutomationCount > 0 ? (
          <p className="mt-1 text-2xs text-muted">
            +{data.goalAutomationCount} goal automation
            {data.goalAutomationCount === 1 ? '' : 's'} (see Goals)
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-2xs font-semibold tracking-[0.14em] text-muted uppercase">
          Standing approvals{data.policies.length > 0 ? ` (${data.policies.length})` : ''}
        </p>
        {data.policies.length === 0 ? (
          <p className="mt-1 text-xs text-muted">No standing rules yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {data.policies.map((p) => (
              <li key={p.id} className="text-xs">
                <span className="font-medium text-strong">{p.title}</span>
                {' — '}
                <span
                  className={
                    p.allowed
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }
                >
                  {p.allowed ? 'Allowed' : 'Blocked'}
                </span>
                {p.enabled ? null : ' · Paused'}
                {p.scope ? <span className="block text-muted">{p.scope}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        href="/costs"
        className={`inline-flex items-center gap-1 self-start rounded text-xs font-medium text-accent hover:underline ${focusRing}`}
      >
        Open costs
        <ArrowRight className="size-3" aria-hidden="true" />
      </Link>
    </div>
  );
}
