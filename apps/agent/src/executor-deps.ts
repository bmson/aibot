import { type ExecutorDeps, TrustSchema } from '@assistant/core';
import type { AgentDeps } from './deps.js';
import { deliverEmailFinal } from './email-channel.js';
import { deliverSmsFinal, notifyApprovalsBySms, notifyOwnerBySms } from './sms-channel.js';

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
    notifyApproval: (approvals) => notifyApprovalsBySms(deps, approvals),
    notifyOwner: ({ taskId, text }) => notifyOwnerBySms(deps, { taskId, text }),
  };
}
