import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** Owner-only dashboard notification that does not require a SQL connection. */
export function registerPortableOwnerNotifyTool(
  registry: ToolRegistry,
  deps: {
    post: (input: {
      agentId: string;
      taskId: string;
      conversationId?: string | null;
      text: string;
    }) => Promise<{ conversationId: string }>;
    /**
     * The out-of-band leg (SMS/push) behind the owner's nudge policy. Without
     * it a requested ping is reported as not sent.
     */
    notifyOwner?: (input: { text: string; taskId: string; urgency: 'ambient' }) => Promise<void>;
  },
): ToolRegistry {
  register(
    registry,
    {
      name: 'owner.notify',
      description:
        "Leave a message for the owner in the current conversation, or in Notifications when there is no conversation. Set ping=true to also buzz their phone (SMS/push) — reserved for proactive, time-sensitive notes; the owner's quiet hours and daily ping limit still govern it, and it is reported as not sent when no phone channel is configured.",
      inputSchema: z.object({
        message: z.string().min(1).max(4000),
        ping: z.boolean().optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const result = await deps.post({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          conversationId: ctx.conversationId,
          text: args.message,
        });
        // Ambient by construction, as in the PostgreSQL tool: the policy gate
        // downstream decides whether the phone buzzes, and the chat message
        // above is the record, so a failed radio never fails the tool.
        let pinged = false;
        if (args.ping && deps.notifyOwner) {
          pinged = await deps
            .notifyOwner({ text: args.message, taskId: ctx.taskId, urgency: 'ambient' })
            .then(() => true)
            .catch((err) => {
              console.error('owner.notify ping failed', err);
              return false;
            });
        }
        return { notified: true, conversationId: result.conversationId, pinged };
      },
    },
    { ownerVisibleOnly: true },
  );
  return registry;
}
