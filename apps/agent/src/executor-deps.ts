import { type ExecutorDeps, TrustSchema } from '@assistant/core';
import type { AgentDeps } from './deps.js';
import { deliverEmailFinal } from './email-channel.js';
import { deliverSmsFinal, notifyApprovalsBySms, notifyOwnerBySms } from './sms-channel.js';

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
 * The executor wired with this app's channel hooks: final answers route back
 * through the channel the request came from (email thread reply, SMS), plus
 * approval pings. Each deliverer guards on its own channel, so chaining is safe.
 */
export function executorDeps(deps: AgentDeps): ExecutorDeps {
  return {
    db: deps.db,
    router: deps.router,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    documentProcessor: deps.documentProcessor,
    jobUnavailable: (job) => deps.modules.jobUnavailable(job),
    deliverFinal: async (task, text) => {
      // Let provider failures escape: the workflow has already checkpointed
      // the exact final text and will retry delivery without rerunning the model.
      if (
        task.type === 'email_triage' &&
        task.trust === 'owner' &&
        !deps.googleClient.configured()
      ) {
        throw new Error('email final delivery is not configured');
      }
      if (task.type === 'sms_turn' && task.trust === 'owner' && !deps.twilio.configured()) {
        throw new Error('SMS final delivery is not configured');
      }
      await deliverEmailFinal(deps, task, text);
      await deliverSmsFinal(
        deps,
        {
          id: task.id,
          conversationId: task.conversationId,
          trust: TrustSchema.parse(task.trust),
        },
        text,
      );
    },
    // A parked approval has to reach the owner where they actually are. SMS is
    // the out-of-band ping and the only channel that can RESOLVE an approval
    // (sms-channel parses "YES A7"). The email reply is what stops an
    // email-triggered request from going silent: postConversationNotice only
    // writes a dashboard row, so without this the thread the owner is watching
    // shows nothing at all. deliverEmailFinal guards on its own channel, so
    // this is a no-op for every non-email task.
    notifyApproval: async (task, approvals) => {
      await notifyApprovalsBySms(deps, approvals);
      await deliverEmailFinal(deps, task, approvalNoticeEmail(approvals));
    },
    notifyOwner: ({ taskId, text }) => notifyOwnerBySms(deps, { taskId, text }),
  };
}
