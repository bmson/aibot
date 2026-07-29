import type { ExecutorDeps } from '@assistant/core';
import { type AgentDeps, agentServices } from './deps.js';

/**
 * The in-thread version of the parked-approval notice. It deliberately does NOT
 * invite a "YES A7" reply to the email: only the SMS channel parses approval
 * codes, so promising resolution here would be an instruction the system cannot
 * honour — the same class of untruth this notice exists to prevent.
 */
export function approvalNoticeEmail(
  approvals: Array<{ shortCode: string; summary: string }>,
): string {
  return [
    'I need your approval before I act on this:',
    ...approvals.map((a) => `- [${a.shortCode}] ${a.summary}`),
    '',
    'Approve or deny it on the Approvals page of the dashboard, or reply to my text message with YES or NO and the code. I will carry on from there — nothing has happened yet.',
  ].join('\n');
}

/**
 * The executor wired with the installed modules' channels: final answers route
 * back through the channel the request came from (email thread reply, SMS),
 * plus approval pings. Every channel self-guards on its own conversation
 * shape, so fanning out to all of them is safe; composition order (google
 * before sms in assistant.config.ts) preserves the email-then-sms sequence
 * from the hardcoded era. This file names no provider.
 */
export function executorDeps(deps: AgentDeps): ExecutorDeps {
  const services = agentServices(deps);
  const channels = deps.modules.channels;
  return {
    db: deps.db,
    router: deps.router,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    documentProcessor: deps.documentProcessor,
    jobUnavailable: (job) => deps.modules.jobUnavailable(job),
    deliverFinal: async (task, text) => {
      // An owner-facing task whose owning channel module is UNINSTALLED has no
      // channel to assert against, so it would otherwise complete with the
      // answer silently undelivered. Fail loudly first (the pre-refactor code
      // did this via the module's absent() null object). The installed-but-
      // unconfigured case is still handled by the channel's own assertDeliverable.
      if (task.trust === 'owner') {
        const unavailable = deps.modules.channelUnavailable(task.type);
        if (unavailable) throw new Error(unavailable);
      }
      // Every channel's configured-check runs BEFORE any channel delivers, so
      // a half-configured installation fails the task loudly instead of
      // delivering on one channel and silently dropping the other. Provider
      // failures escape: the workflow has already checkpointed the exact final
      // text and will retry delivery without rerunning the model.
      for (const channel of channels) channel.assertDeliverable?.(task);
      for (const channel of channels) await channel.deliverFinal(services, task, text);
    },
    // A parked approval has to reach the owner where they actually are. The
    // out-of-band ping (SMS today) goes first and is the only channel that can
    // RESOLVE an approval; the in-thread notice is what stops an
    // email-triggered request from going silent. Each notice deliverer guards
    // on its own channel, so this is a no-op for every non-email task.
    notifyApproval: async (task, approvals) => {
      await services.ownerNotifier.notifyApprovals(approvals);
      for (const channel of channels) {
        await channel.deliverApprovalNotice?.(services, task, approvalNoticeEmail(approvals));
      }
    },
    notifyOwner: ({ taskId, text }) => services.ownerNotifier.notifyOwner({ taskId, text }),
  };
}
