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
  },
): ToolRegistry {
  register(
    registry,
    {
      name: 'owner.notify',
      description:
        'Leave a message for the owner in the current conversation, or in Notifications when there is no conversation. A phone ping may be requested, but is reported as unavailable until a phone channel is configured.',
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
        return { notified: true, conversationId: result.conversationId, pinged: false };
      },
    },
    { ownerVisibleOnly: true },
  );
  return registry;
}
