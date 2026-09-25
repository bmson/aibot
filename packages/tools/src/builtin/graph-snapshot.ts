import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type { GraphSnapshotRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** `memory.graph_snapshot` over a graph repository instead of the SQL join. */
export function registerPortableGraphSnapshotTool(
  registry: ToolRegistry,
  deps: {
    embed: (texts: string[]) => Promise<number[][]>;
    graph: GraphSnapshotRepository;
  },
): ToolRegistry {
  register(
    registry,
    {
      name: 'memory.graph_snapshot',
      description:
        'Read active, source-backed knowledge-graph connections relevant to a query. Returns direct relationships plus the exact source memory and evidence. Never infer missing nodes or edges.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const [embedding] = await deps.embed([args.query]);
        if (!embedding) throw new Error('embedding unavailable');
        const rows = await deps.graph.snapshot({
          agentId: ctx.agentId,
          embedding,
          limit: args.limit,
          extractionVersion: GRAPH_EXTRACTION_VERSION,
        });
        return {
          query: args.query,
          complete: rows.length < args.limit,
          relationships: rows.map((row) => ({
            ...row,
            unconfirmed: row.ownerConfirmed !== true || Number(row.memoryConfidence) < 0.7,
          })),
        };
      },
    },
    { confidentialRead: true },
  );
  return registry;
}
