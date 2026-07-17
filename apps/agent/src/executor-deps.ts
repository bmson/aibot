import type { ExecutorDeps } from '@assistant/core';
import type { AgentDeps } from './deps.js';
import { deliverEmailFinal } from './email-channel.js';
import { deliverSmsFinal, notifyApprovalsBySms } from './sms-channel.js';

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
      await deliverEmailFinal(deps, task, text).catch((err) =>
        console.error('email delivery failed', err),
      );
      await deliverSmsFinal(deps, task, text);
    },
    notifyApproval: (approvals) => notifyApprovalsBySms(deps, approvals),
  };
}
