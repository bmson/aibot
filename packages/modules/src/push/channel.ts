import { getAgent } from '@assistant/core/chat';
import { invalidateDeviceToken, listActiveDeviceTokens } from '@assistant/core/push/devices';
import type { Db } from '@assistant/db';
import type { ApnsClient } from '@assistant/tools/modules/push';

export interface PushChannelDeps {
  db: Db;
  apns: ApnsClient;
}

/** Push bodies are glanceable plain text: markdown stays on the dashboard. */
function plain(text: string, max = 220): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** The app's UNNotificationCategory identifiers (NotificationManager.swift). */
const ATTENTION_CATEGORY = 'ASSISTANT_ATTENTION';
const UPDATE_CATEGORY = 'ASSISTANT_UPDATE';

async function deliver(
  deps: PushChannelDeps,
  alert: { title: string; body: string; category: string; data?: Record<string, string> },
): Promise<void> {
  if (!deps.apns?.configured()) return;
  const agent = await getAgent(deps.db);
  const devices = await listActiveDeviceTokens(deps.db, agent.id);
  for (const device of devices) {
    const result = await deps.apns
      .send({
        token: device.token,
        environment: device.environment,
        ...alert,
      })
      .catch((err) => {
        console.error('push: send failed', err);
        return undefined;
      });
    if (result && !result.ok) {
      if (result.unregistered) await invalidateDeviceToken(deps.db, device.token);
      else console.error('push: APNs rejected a send', result.status, result.reason);
    }
  }
}

/**
 * Owner-notifier leg: push the same notice the dashboard leg posts, so an
 * owner away from the thread hears about failures, stalls, and proactive
 * nudges. Best-effort like every notifier leg — a push outage must never
 * swallow the dashboard copy (the fan-out in the composition root isolates
 * legs from one another anyway).
 */
export async function notifyOwnerByPush(
  deps: PushChannelDeps,
  input: { taskId?: string; text: string },
): Promise<void> {
  if (!deps.apns?.configured()) return;
  const agent = await getAgent(deps.db);
  await deliver(deps, {
    title: agent.name,
    body: plain(input.text),
    category: UPDATE_CATEGORY,
    data: { route: 'chat' },
  });
}

/** Approval park ping: one tap lands the owner on the Approvals sheet. */
export async function notifyApprovalsByPush(
  deps: PushChannelDeps,
  approvals: ReadonlyArray<{ taskId: string; shortCode: string; summary: string }>,
): Promise<void> {
  if (!deps.apns?.configured() || approvals.length === 0) return;
  const agent = await getAgent(deps.db);
  const single = approvals.length === 1 ? approvals[0] : undefined;
  // No approvalId in the payload: the notifier port only carries the short
  // code, and a wrong id would mis-resolve the notification's Approve/Deny
  // action — the tap routes to the Approvals sheet instead.
  await deliver(deps, {
    title: agent.name,
    body:
      single !== undefined
        ? `Needs your approval: ${plain(single.summary, 160)}`
        : `${approvals.length} things need your approval`,
    category: ATTENTION_CATEGORY,
    data: { route: 'approvals' },
  });
}
