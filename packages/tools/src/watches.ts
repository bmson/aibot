import { conversations, watches } from '@assistant/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const MAX_WATCH_DAYS = 90;
const DEFAULT_WATCH_DAYS = 30;
const MAX_FIRES_CAP = 1000;

/**
 * The stored `match` shape for an email watch, and the single source of truth
 * for how a message is matched. Parsing is idempotent: senders are lowercased
 * and deduped, so re-parsing a stored row is stable.
 */
export const emailWatchMatchSchema = z.object({
  expectedSenderEmails: z
    .array(z.string().trim().toLowerCase().email())
    .min(1)
    .max(10)
    .transform((values) => [...new Set(values)]),
  keywords: z
    .array(z.string().trim().min(1).max(100))
    .max(10)
    .optional()
    .transform((values) =>
      values?.length ? [...new Set(values.map((value) => value.toLowerCase()))] : undefined,
    ),
});

export type EmailWatchMatch = z.infer<typeof emailWatchMatchSchema>;

export interface EmailWatchCandidate {
  from: string;
  subject: string;
  body: string;
}

/**
 * Pure, deterministic match test — no DB, no model. A watch fires only when the
 * (already authenticated) sender is one the owner named, and — if the owner set
 * keywords — at least one keyword appears in the subject/body. Untrusted content
 * is compared, never interpreted.
 */
export function emailWatchMatches(match: unknown, input: EmailWatchCandidate): boolean {
  const parsed = emailWatchMatchSchema.safeParse(match);
  if (!parsed.success) return false;
  const from = input.from.trim().toLowerCase();
  if (!from || !parsed.data.expectedSenderEmails.includes(from)) return false;
  const { keywords } = parsed.data;
  if (keywords?.length) {
    const haystack = `${input.subject}\n${input.body}`.toLowerCase();
    if (!keywords.some((keyword) => haystack.includes(keyword))) return false;
  }
  return true;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  expectedSenderEmails: z
    .array(z.string().trim().toLowerCase().email())
    .min(1)
    .max(10)
    .transform((values) => [...new Set(values)]),
  keywords: z
    .array(z.string().trim().min(1).max(100))
    .max(10)
    .optional()
    .transform((values) =>
      values?.length ? [...new Set(values.map((value) => value.toLowerCase()))] : undefined,
    ),
  expiresInDays: z.number().int().min(1).max(MAX_WATCH_DAYS).default(DEFAULT_WATCH_DAYS),
  maxFires: z.number().int().min(1).max(MAX_FIRES_CAP).optional(),
});

const listSchema = z.object({
  status: z.enum(['active', 'fired', 'expired', 'cancelled']).optional(),
});

const cancelSchema = z.object({ watchId: z.string().uuid() });

function matchSummary(match: EmailWatchMatch): string {
  const senders = match.expectedSenderEmails.join(', ');
  return match.keywords?.length ? `${senders} (mentioning ${match.keywords.join(' / ')})` : senders;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/**
 * Anticipation-layer watchers (Phase 1: email, notify-only). Creating, listing,
 * and cancelling a watch takes no outward action, so all three are autonomous;
 * they are private-owner tools and are stripped from any external/untrusted
 * task registry. See docs/anticipation-layer.md.
 */
export function registerWatchTools(registry: ToolRegistry): ToolRegistry {
  register(
    registry,
    {
      name: 'watch.create',
      description:
        'Watch the bot inbox for future email from specific senders and notify the owner when it arrives ("tell me if X emails me"). Only authenticated mail from the named senders fires it; optional keywords further narrow it to messages mentioning any of them. This only notifies the owner — it never sends, replies, or takes any outward action. Autonomous; no approval needed.',
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const expiresAt = new Date(ctx.now().getTime() + args.expiresInDays * 24 * 60 * 60_000);
        const match: EmailWatchMatch = {
          expectedSenderEmails: args.expectedSenderEmails,
          keywords: args.keywords,
        };

        // Notices need somewhere the owner can see them. Reuse the originating
        // chat when there is one; otherwise open a dedicated watch chat (the
        // same fallback the application-confirmation watch uses).
        let conversationId = ctx.conversationId;
        if (!conversationId) {
          const [conversation] = await ctx.db
            .insert(conversations)
            .values({
              agentId: ctx.agentId,
              channel: 'chat',
              trust: 'owner',
              title: `Watch: ${args.name}`.slice(0, 80),
            })
            .returning({ id: conversations.id });
          if (!conversation) throw new Error('failed to create watch chat');
          conversationId = conversation.id;
        }

        const [record] = await ctx.db
          .insert(watches)
          .values({
            agentId: ctx.agentId,
            conversationId,
            kind: 'email',
            tier: 'notify',
            name: args.name,
            match,
            maxFires: args.maxFires ?? null,
            expiresAt,
          })
          .returning();
        if (!record) throw new Error('failed to create watch');
        return {
          watchId: record.id,
          name: record.name,
          matching: matchSummary(match),
          expectedSenderEmails: match.expectedSenderEmails,
          keywords: match.keywords ?? [],
          maxFires: record.maxFires,
          expiresAt: record.expiresAt.toISOString(),
          status: record.status,
          conversationId: record.conversationId,
        };
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'watch.list',
      description:
        "List the owner's inbox watches — their senders, optional keywords, fire count, last fire, expiry, and status. Use this before cancelling or explaining a watch.",
      inputSchema: listSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const rows = await ctx.db
          .select()
          .from(watches)
          .where(
            args.status
              ? and(eq(watches.agentId, ctx.agentId), eq(watches.status, args.status))
              : eq(watches.agentId, ctx.agentId),
          )
          .orderBy(desc(watches.createdAt))
          .limit(100);
        return {
          watches: rows.map((row) => {
            const parsed = emailWatchMatchSchema.safeParse(row.match);
            return {
              watchId: row.id,
              name: row.name,
              kind: row.kind,
              tier: row.tier,
              status: row.status,
              matching: parsed.success ? matchSummary(parsed.data) : '(unreadable match)',
              expectedSenderEmails: parsed.success ? parsed.data.expectedSenderEmails : [],
              keywords: parsed.success ? (parsed.data.keywords ?? []) : [],
              fireCount: row.fireCount,
              maxFires: row.maxFires,
              lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
              expiresAt: row.expiresAt.toISOString(),
            };
          }),
        };
      },
    },
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'watch.cancel',
      description:
        'Cancel one active inbox watch by id so it stops notifying. Only an active watch can be cancelled; an already-expired, exhausted, or cancelled watch is reported as-is.',
      inputSchema: cancelSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const [cancelled] = await ctx.db
          .update(watches)
          .set({ status: 'cancelled', updatedAt: ctx.now() })
          .where(
            and(
              eq(watches.id, args.watchId),
              eq(watches.agentId, ctx.agentId),
              eq(watches.status, 'active'),
            ),
          )
          .returning({ id: watches.id });
        if (cancelled) return { watchId: cancelled.id, status: 'cancelled', cancelled: true };

        const [current] = await ctx.db
          .select({ id: watches.id, status: watches.status })
          .from(watches)
          .where(and(eq(watches.id, args.watchId), eq(watches.agentId, ctx.agentId)));
        if (!current) throw new Error('watch not found');
        return { watchId: current.id, status: current.status, cancelled: false };
      },
    },
    { privateWrite: true },
  );

  return registry;
}
