import { searchDocumentChunks } from '@assistant/core';
import { z } from 'zod';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';

export interface DocumentToolDeps {
  /** Embedding closure (injected by the app — avoids a core↔tools cycle). */
  embed: (texts: string[]) => Promise<number[][]>;
}

/** Search over documents the owner filed. Installed by the documents module. */
export function registerDocumentTools(
  registry: ToolRegistry,
  deps: DocumentToolDeps,
): ToolRegistry {
  register(
    registry,
    {
      name: 'documents.search',
      description:
        "Search the owner's filed documents — files they uploaded and attachments the assistant filed from trusted senders — by meaning. Returns the most relevant passages with their document title. Use this to answer a question about the content of a document (a PDF, a note, an export).",
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const [embedding] = await deps.embed([args.query]);
        if (!embedding) return { passages: [] };
        const hits = await searchDocumentChunks(ctx.db, {
          agentId: ctx.agentId,
          embedding,
          limit: args.limit,
        });
        return {
          passages: hits.map((h) => ({
            document: h.title,
            source: h.source,
            snippet: h.text.slice(0, 1000),
            similarity: Number(h.similarity.toFixed(3)),
          })),
        };
      },
    },
    // Document content is third-party-authored by nature — a filed PDF or
    // attachment can carry injected instructions — so its text taints the
    // session (owner-approval gates any outward action afterwards).
    { confidentialRead: true, returnsUntrustedContent: true },
  );
  return registry;
}
