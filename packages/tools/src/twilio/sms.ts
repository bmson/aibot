import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { SmsSender } from './client.js';

export interface SmsToolDeps {
  sender: SmsSender;
  ownerPhone: string;
  /** Voice pipeline hook for outbound SMS text. */
  prepareOutbound?: (text: string) => Promise<{ text: string; flagged?: string }>;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export function registerSmsTools(registry: ToolRegistry, deps: SmsToolDeps): ToolRegistry {
  const schema = z.object({
    to: z.string().regex(/^\+\d{7,15}$/, 'E.164 phone number'),
    body: z.string().min(1).max(1500),
    /** Set by the voice pipeline when the fact check failed. */
    voiceFlag: z.string().optional(),
  });

  register(
    registry,
    {
      name: 'sms.send',
      description:
        "Send an SMS from the assistant's own number. Replying to the owner in the owner's conversation is autonomous (policy); anyone else requires owner approval.",
      inputSchema: schema,
      // The seeded 'sms.reply_to_owner' policy turns owner-conversation replies
      // autonomous; the base tier stays approval for everything else.
      risk: (args, ctx) =>
        (args as z.infer<typeof schema>).to === deps.ownerPhone && ctx.trust === 'owner'
          ? 'autonomous'
          : 'approval',
      acceptsUntrustedInput: false,
      prepare: async (args) => {
        if (!deps.prepareOutbound) return args;
        const result = await deps.prepareOutbound((args as z.infer<typeof schema>).body);
        return { ...args, body: result.text, voiceFlag: result.flagged };
      },
      approvalSummary: (args) => {
        const a = args as z.infer<typeof schema>;
        return `Send SMS to ${a.to}: "${a.body.slice(0, 80)}${a.body.length > 80 ? '…' : ''}"`;
      },
      idempotencyKey: (args, ctx) => {
        const a = args as z.infer<typeof schema>;
        return `sms-send-${ctx.taskId}-${a.to}-${a.body.slice(0, 40)}`;
      },
      execute: async (args) => {
        const result = await deps.sender.send(args.to, args.body);
        return { sid: result.sid, to: args.to };
      },
    },
    { outwardFacing: true },
  );

  return registry;
}
