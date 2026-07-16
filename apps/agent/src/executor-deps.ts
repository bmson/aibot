import type { ExecutorDeps } from '@assistant/core';
import type { AgentDeps } from './deps.js';
import { deliverSmsFinal, notifyApprovalsBySms } from './sms-channel.js';

/** The executor wired with this app's channel hooks (SMS delivery + approval pings). */
export function executorDeps(deps: AgentDeps): ExecutorDeps {
  return {
    db: deps.db,
    router: deps.router,
    dispatcher: deps.dispatcher,
    deliverFinal: (task, text) => deliverSmsFinal(deps, task, text),
    notifyApproval: (approvals) => notifyApprovalsBySms(deps, approvals),
  };
}
