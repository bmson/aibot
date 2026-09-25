import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';
import type { WorkspaceStore } from '../workspace-store.js';
import {
  extractWebText,
  fetchPublicWebPage,
  looksLikeBotChallenge,
  type WebFetchIo,
} from './web-fetch.js';

/** Register SSRF-guarded public page reads without a persistence dependency. */
export function registerPortableWebFetchTool(
  registry: ToolRegistry,
  options: { io?: WebFetchIo } = {},
): ToolRegistry {
  register(
    registry,
    {
      name: 'web.fetch',
      description:
        'Fetch a public web page over HTTP GET and return its text content. For reading only — no forms, no logins.',
      inputSchema: z.object({ url: z.string().url() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // The exact URL matters because a fetch to an attacker URL is itself the
      // egress/exfiltration channel.
      approvalSummary: (args) => `Fetch the public web page ${args.url}`,
      cacheTtlSeconds: 900,
      execute: async (args, ctx) => {
        const fetched = await fetchPublicWebPage(
          args.url,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
          options.io,
        );
        const text = extractWebText(fetched.contentType, fetched.body);
        if (looksLikeBotChallenge(fetched.status, text)) {
          throw new Error(
            `bot-challenge wall instead of content: ${fetched.finalUrl} answered HTTP ${fetched.status} with a CAPTCHA/verification page. ` +
              'This site blocks automated fetches — do not retry this URL; go to a different source (the target site directly, its API or RSS feed).',
          );
        }
        return {
          status: fetched.status,
          contentType: fetched.contentType,
          text: text.slice(0, 20000),
          truncated: fetched.truncated || text.length > 20000,
          finalUrl: fetched.finalUrl,
        };
      },
    },
    {
      returnsUntrustedContent: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    },
  );
  return registry;
}

/** Register workspace file tools against a local or cloud workspace adapter. */
export function registerPortableWorkspaceTools(
  registry: ToolRegistry,
  workspace: WorkspaceStore,
): ToolRegistry {
  register(
    registry,
    {
      name: 'workspace.write',
      description: "Write a text file into the assistant's workspace.",
      inputSchema: z.object({
        path: z.string().min(1).max(300),
        content: z.string().max(200_000),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const { bytes } = await workspace.write(args.path, args.content);
        return { written: args.path, bytes };
      },
    },
    { writesWorkspace: true },
  );

  register(
    registry,
    {
      name: 'workspace.read',
      description: "Read a text file from the assistant's workspace.",
      inputSchema: z.object({ path: z.string().min(1).max(300) }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const content = await workspace.read(args.path);
        return { path: args.path, content: content.slice(0, 100_000) };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  register(
    registry,
    {
      name: 'workspace.list',
      description: 'List files in a workspace directory.',
      inputSchema: z.object({ path: z.string().max(300).default('.') }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const entries = await workspace.list(args.path || '.');
        return { entries };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  return registry;
}

/** Compose the web and workspace tools for persistence-specific agent roots. */
export function registerPortableWebWorkspaceTools(
  registry: ToolRegistry,
  options: { workspace: WorkspaceStore; webFetchIo?: WebFetchIo },
): ToolRegistry {
  registerPortableWebFetchTool(registry, options.webFetchIo ? { io: options.webFetchIo } : {});
  return registerPortableWorkspaceTools(registry, options.workspace);
}
