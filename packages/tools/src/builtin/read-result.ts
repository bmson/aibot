import type { ToolExecutionRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** `tools.read_result` over the tool-execution repository instead of the SQL row. */
export function registerPortableReadResultTool(
  registry: ToolRegistry,
  deps: { toolExecution: Pick<ToolExecutionRepository, 'load'> },
): ToolRegistry {
  register(
    registry,
    {
      name: 'tools.read_result',
      description:
        'Read more of a truncated tool result. When a result says "truncated" and names a toolCallId, call this with that id and the suggested offset to page through the full stored result. Only results from the current task are readable.',
      inputSchema: z.object({
        toolCallId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        // Scoped to the calling task and its owner: other tasks' results may
        // hold content this task's trust tier was never meant to see.
        const loaded = await deps.toolExecution.load(ctx.agentId, ctx.taskId, args.toolCallId);
        if (!loaded || loaded.toolCall.taskId !== ctx.taskId) {
          return { error: 'no such tool call in this task' };
        }
        const json = JSON.stringify(loaded.toolCall.result ?? null);
        const chunk = json.slice(args.offset, args.offset + 30_000);
        return {
          totalChars: json.length,
          offset: args.offset,
          chunk,
          hasMore: args.offset + chunk.length < json.length,
        };
      },
    },
    // The stored result may embed third-party content (a fetched page, a mail
    // thread), so reading it re-taints exactly like the original tool did.
    { returnsUntrustedContent: true },
  );
  return registry;
}
