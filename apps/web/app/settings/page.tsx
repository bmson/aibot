import { existsSync } from 'node:fs';
import { envFile, loadConfig } from '@assistant/config';
import { ArrowRight } from 'lucide-react';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { deletePolicy, setPolicyEnabled, setScheduleEnabled } from '@/app/settings/actions';
import { AgentForm } from '@/app/settings/agent-form';
import { policyLabels, policyScope, scheduleLabels } from '@/app/settings/labels';
import { McpConnectionsPanel } from '@/app/settings/mcp-connections';
import { MobileTokenPanel } from '@/app/settings/mobile-token';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getApplication } from '@/lib/server';
import {
  Badge,
  Card,
  cardInteractiveClass,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  focusRing,
  PageHeader,
  PageShell,
  SectionHeading,
} from '@/lib/ui';
import { ConfirmButton, SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

/**
 * Every list entry on this page is the same shape: what it is, one line of
 * plain-language detail, and its controls on the right. Nested fact grids used
 * to wrap two values in their own boxes, which made a simple "runs daily, ran
 * two hours ago" read like a data table.
 */
function SettingRow({
  title,
  badges,
  detail,
  detailTitle,
  actions,
}: {
  title: string;
  badges?: ReactNode;
  detail: ReactNode;
  /** Tooltip for the machine-readable form (cron expression, tool name). */
  detailTitle?: string;
  actions: ReactNode;
}) {
  return (
    <div
      className={`${cardShellClass} flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-5`}
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className={`flex min-w-0 flex-wrap items-center gap-2 ${cardTitleClass}`}>
          {title}
          {badges}
        </p>
        <p className="mt-1 min-w-0 text-sm leading-5 text-muted" title={detailTitle}>
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export default async function SettingsPage() {
  await requireOwner();
  const now = new Date();
  const [
    { agent, schedules: directScheduleRows, policies: policyRows, goalAutomationCount },
    mcpConnections,
  ] = await Promise.all([getApplication().getSettings(), getApplication().listMcpConnections()]);

  // Pairing values for the iOS app. The URL mirrors what the owner is
  // browsing right now — if they reached settings over a LAN IP or the
  // production domain, that is exactly the address the phone should use.
  //
  // The token leaves the server ONLY as a masked preview: the plaintext in an
  // RSC payload would be one cached-response or shoulder-surf away from a
  // bearer credential that bypasses web sign-in entirely. The full value is
  // revealed once, at rotation time, by the action that generates it.
  const config = loadConfig();
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? '';
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http';
  const serverUrl = host ? `${proto}://${host}` : config.AUTH_URL;
  const token = config.MOBILE_API_TOKEN;
  const maskedToken = token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null;
  // Rotation works when there's a .env to persist to, OR when running on
  // Cloud Run where the service account can add a Secret Manager version.
  const canRotate = existsSync(envFile) || Boolean(config.GCP_PROJECT);

  return (
    <PageShell size="reading" className="flex flex-col gap-10">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Settings"
        intro="Identity, the jobs the assistant runs on its own, spending, and the approvals it can handle without asking."
      />

      {/* Identity */}
      <section>
        <SectionHeading title="Assistant" hint={`${agent.name} · ${agent.email}`} />
        <Card className="mt-3">
          <AgentForm
            initial={{
              timezone: agent.timezone,
              locale: agent.locale,
              signature: agent.signature,
            }}
          />
          <p className="mt-5 border-t border-edge pt-3 text-xs leading-5 text-muted">
            {agent.phoneE164
              ? `Name, email, and phone (${agent.phoneE164}) are`
              : 'Name and email are'}{' '}
            provisioned at deploy time — the name matches the assistant’s email account, so messages
            it sends agree with what you see here.
          </p>
        </Card>
      </section>

      {/* Mobile app pairing */}
      <section>
        <SectionHeading title="Mobile app" hint="pair the iPhone app with this server" />
        <Card className="mt-3">
          <MobileTokenPanel maskedToken={maskedToken} serverUrl={serverUrl} canRotate={canRotate} />
        </Card>
      </section>

      {/* MCP servers */}
      <section>
        <SectionHeading
          title="MCP connections"
          count={mcpConnections.length}
          hint="remote tool servers available to this assistant"
        />
        <Card className="mt-3">
          <McpConnectionsPanel connections={mcpConnections} />
        </Card>
      </section>

      {/* Schedules */}
      <section>
        <SectionHeading
          title="Recurring jobs"
          count={directScheduleRows.length}
          hint={
            goalAutomationCount
              ? `${goalAutomationCount} goal automations are managed from Goals`
              : 'work the assistant starts on its own'
          }
        />
        {directScheduleRows.length === 0 ? (
          <EmptyState>
            {goalAutomationCount
              ? 'No other recurring jobs. Your automatic goal work is managed from Goals.'
              : 'No recurring jobs yet.'}
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {directScheduleRows.map((s) => (
              <SettingRow
                key={s.id}
                title={scheduleLabels[s.name] ?? s.name.replaceAll('-', ' ')}
                badges={
                  s.enabled ? null : (
                    <Badge tone="amber" size="xs">
                      Paused
                    </Badge>
                  )
                }
                detailTitle={`Schedule: ${s.cron}`}
                detail={
                  <>
                    {!s.enabled
                      ? 'Not scheduled'
                      : !s.nextRunAt
                        ? // Resuming clears next_run_at; the sweep recomputes it.
                          'Recalculating on the next sweep'
                        : s.nextRunAt <= now
                          ? // A due time in the past means the sweep has not
                            // reached it yet. "Next 5h ago" reads as a bug.
                            `Overdue since ${formatDateTime(s.nextRunAt, agent.timezone)}`
                          : `Next ${relativeTime(s.nextRunAt, now)}, ${formatDateTime(s.nextRunAt, agent.timezone)}`}
                    {' · '}
                    {s.lastRunAt ? `last ran ${relativeTime(s.lastRunAt, now)}` : 'has not run yet'}
                  </>
                }
                actions={
                  <form action={setScheduleEnabled.bind(null, s.id, !s.enabled)}>
                    <SubmitButton
                      variant="outline"
                      pendingLabel={s.enabled ? 'Pausing…' : 'Resuming…'}
                    >
                      {s.enabled ? 'Pause' : 'Resume'}
                    </SubmitButton>
                  </form>
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Costs — one destination, so the whole row is the link. */}
      <section>
        <SectionHeading title="Spending" />
        <Link
          href="/costs"
          className={`${cardShellClass} ${cardInteractiveClass} ${focusRing} mt-3 flex min-w-0 items-center justify-between gap-4 px-4 py-4 sm:px-5`}
        >
          <span className="min-w-0">
            <span className={`block ${cardTitleClass}`}>Usage and limits</span>
            <span className="mt-1 block text-sm leading-5 text-muted">
              Today’s spend, the monthly total, and the caps that pause work.
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
            Open costs
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </span>
        </Link>
      </section>

      {/* Approval rules */}
      <section>
        <SectionHeading
          title="Standing approvals"
          count={policyRows.length}
          hint="decisions the assistant reuses instead of asking again"
        />
        {policyRows.length === 0 ? (
          <EmptyState>
            No standing rules yet. When you save a choice from an approval, it appears here.
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {policyRows.map((p) => (
              <SettingRow
                key={p.id}
                title={policyLabels[p.templateKey] ?? 'Custom approval rule'}
                badges={
                  <>
                    <Badge tone={p.effect === 'allow' ? 'green' : 'red'} size="xs">
                      {p.effect === 'allow' ? 'Allowed' : 'Blocked'}
                    </Badge>
                    {p.enabled ? null : (
                      <Badge tone="amber" size="xs">
                        Paused
                      </Badge>
                    )}
                  </>
                }
                detailTitle={`${p.toolName} · ${p.templateKey}`}
                detail={policyScope(p.templateKey, p.match) ?? 'Custom scope'}
                actions={
                  <>
                    <form action={setPolicyEnabled.bind(null, p.id, !p.enabled)}>
                      {p.enabled ? (
                        <SubmitButton variant="outline" pendingLabel="Pausing…">
                          Pause
                        </SubmitButton>
                      ) : (
                        <ConfirmButton
                          variant="outline"
                          pendingLabel="Enabling…"
                          confirmLabel="Confirm use rule"
                        >
                          Use
                        </ConfirmButton>
                      )}
                    </form>
                    {p.createdVia !== 'seed' ? (
                      <form action={deletePolicy.bind(null, p.id)}>
                        <ConfirmButton
                          pendingLabel="Deleting…"
                          confirmLabel="Confirm delete"
                          title="Remove the rule — this tool goes back to asking for approval"
                        >
                          Delete
                        </ConfirmButton>
                      </form>
                    ) : null}
                  </>
                }
              />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
