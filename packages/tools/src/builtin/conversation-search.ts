import type { ConversationSearchRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** `conversations.search` over a message search repository instead of SQL. */
export function registerPortableConversationSearchTool(
  registry: ToolRegistry,
  deps: {
    embed: (texts: string[]) => Promise<number[][]>;
    conversations: ConversationSearchRepository;
  },
): ToolRegistry {
  register(
    registry,
    {
      name: 'conversations.search',
      description: 'Search past conversations semantically ("where did we discuss X").',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const [embedding] = await deps.embed([args.query]);
        if (!embedding) throw new Error('embedding unavailable');
        const semantic = await deps.conversations.semantic({
          agentId: ctx.agentId,
          embedding,
          limit: args.limit,
        });
        if (semantic.length > 0) return { matches: semantic, mode: 'semantic' };
        const text = await deps.conversations.text({
          agentId: ctx.agentId,
          query: args.query,
          limit: args.limit,
        });
        return { matches: text, mode: 'text' };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );
  return registry;
}
