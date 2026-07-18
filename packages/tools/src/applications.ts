import { createHash } from 'node:crypto';
import { applicationConfirmations, conversations, tasks } from '@assistant/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { GoogleClient } from './google/client.js';
import { a1Range } from './google/sheets.js';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_WATCH_DAYS = 90;

const spreadsheetId = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/, 'not a Google spreadsheet id');
const sheetName = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !/[[\]:*?/\\]/.test(value), 'sheet name contains a reserved character');
const startCell = z
  .string()
  .regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/, 'startCell must be an A1 cell such as A2');
const cell = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);

/** A fixed, deliberately small Sheet mutation approved before external mail arrives. */
export const ApplicationTrackerUpdateSchema = z.object({
  spreadsheetId,
  sheetName,
  startCell,
  rows: z.array(z.array(cell).min(1).max(50)).min(1).max(10),
});

export type ApplicationTrackerUpdate = z.infer<typeof ApplicationTrackerUpdateSchema>;

const confirmationToken = z
  .string()
  .trim()
  .min(6)
  .max(100)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/,
    'confirmationToken must be an opaque receipt or requisition id using letters, numbers, _ or -',
  )
  .transform((value) => value.toUpperCase());

const watchSchema = z.object({
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(200),
  expectedSenderEmails: z
    .array(z.string().trim().toLowerCase().email())
    .min(1)
    .max(5)
    .transform((values) => [...new Set(values)]),
  confirmationToken,
  expiresAt: z.string().datetime({ offset: true }),
  trackerUpdate: ApplicationTrackerUpdateSchema,
});

const applySchema = z.object({ applicationId: z.string().uuid() });
const listSchema = z.object({
  status: z
    .enum([
      'awaiting_confirmation',
      'confirmation_received',
      'updated',
      'update_unknown',
      'update_failed',
      'cancelled',
      'expired',
    ])
    .optional(),
});

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token.trim().toUpperCase()).digest('hex');
}

function literalRows(rows: ApplicationTrackerUpdate['rows']) {
  // Google RAW input prevents confirmation text beginning with '=' from
  // becoming a formula in the owner's tracker.
  return rows.map((row) => row.map((value) => value ?? ''));
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export interface ApplicationToolDeps {
  client: GoogleClient;
}

/**
 * Register the two halves of the confirmation bridge:
 * 1. an owner-approved watch containing every future side-effect argument;
 * 2. an internal-only execution guarded by the exact deterministic event.
 */
export function registerApplicationTools(
  registry: ToolRegistry,
  deps: ApplicationToolDeps,
): ToolRegistry {
  register(
    registry,
    {
      name: 'applications.watch_confirmation',
      description:
        'After a portal has verifiably accepted a job application, watch for one later confirmation email and update one exact tracker range automatically. Requires the exact authenticated sender email, an opaque receipt or requisition token expected in the email, an expiry, and the literal Sheet values to write. Always requires owner approval.',
      inputSchema: watchSchema,
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => {
        const input = args as z.infer<typeof watchSchema>;
        return `Watch ${input.expectedSenderEmails.join(', ')} for ${input.company} — ${input.role}, then update ${input.trackerUpdate.sheetName}!${input.trackerUpdate.startCell}`;
      },
      idempotencyKey: (args, ctx) => {
        const input = args as z.infer<typeof watchSchema>;
        return `application-watch-${ctx.taskId}-${hashConfirmationToken(input.confirmationToken)}`;
      },
      execute: async (args, ctx) => {
        const expiresAt = new Date(args.expiresAt);
        const remainingMs = expiresAt.getTime() - ctx.now().getTime();
        if (remainingMs < 5 * 60_000) {
          throw new Error('application confirmation watch must remain open for at least 5 minutes');
        }
        if (remainingMs > MAX_WATCH_DAYS * 24 * 60 * 60_000) {
          throw new Error(`application confirmation watch cannot exceed ${MAX_WATCH_DAYS} days`);
        }

        const tokenHash = hashConfirmationToken(args.confirmationToken);
        const [existing] = await ctx.db
          .select({ id: applicationConfirmations.id })
          .from(applicationConfirmations)
          .where(
            and(
              eq(applicationConfirmations.agentId, ctx.agentId),
              eq(applicationConfirmations.confirmationTokenHash, tokenHash),
              eq(applicationConfirmations.status, 'awaiting_confirmation'),
            ),
          )
          .limit(1);
        if (existing) throw new Error('an active confirmation watch already uses this token');

        let conversationId = ctx.conversationId;
        if (!conversationId) {
          const [conversation] = await ctx.db
            .insert(conversations)
            .values({
              agentId: ctx.agentId,
              channel: 'chat',
              trust: 'owner',
              title: `${args.company} — ${args.role}`.slice(0, 80),
            })
            .returning({ id: conversations.id });
          if (!conversation) throw new Error('failed to create application follow-up chat');
          conversationId = conversation.id;
        }

        const [record] = await ctx.db
          .insert(applicationConfirmations)
          .values({
            agentId: ctx.agentId,
            sourceTaskId: ctx.taskId,
            conversationId,
            company: args.company,
            role: args.role,
            expectedSenderEmails: args.expectedSenderEmails,
            confirmationTokenHash: tokenHash,
            confirmationTokenHint: args.confirmationToken.slice(-4),
            trackerUpdate: args.trackerUpdate,
            expiresAt,
          })
          .returning();
        if (!record) throw new Error('failed to create application confirmation watch');
        return {
          applicationId: record.id,
          company: record.company,
          role: record.role,
          expectedSenderEmails: record.expectedSenderEmails,
          tokenHint: record.confirmationTokenHint,
          expiresAt: record.expiresAt.toISOString(),
          trackerUpdate: record.trackerUpdate,
          conversationId: record.conversationId,
          status: record.status,
        };
      },
    },
    { privateWrite: true, blanketAllowIneligible: true },
  );

  register(
    registry,
    {
      name: 'applications.list_confirmations',
      description:
        'List the owner-approved application confirmation watches, their status, expiry, sender, masked token, and tracker target. Use this before cancelling or explaining an automated follow-up.',
      inputSchema: listSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const rows = await ctx.db
          .select()
          .from(applicationConfirmations)
          .where(
            args.status
              ? and(
                  eq(applicationConfirmations.agentId, ctx.agentId),
                  eq(applicationConfirmations.status, args.status),
                )
              : eq(applicationConfirmations.agentId, ctx.agentId),
          )
          .orderBy(desc(applicationConfirmations.createdAt))
          .limit(100);
        return {
          confirmations: rows.map((row) => {
            const tracker = ApplicationTrackerUpdateSchema.parse(row.trackerUpdate);
            return {
              applicationId: row.id,
              company: row.company,
              role: row.role,
              status: row.status,
              expectedSenderEmails: row.expectedSenderEmails,
              tokenHint: row.confirmationTokenHint,
              expiresAt: row.expiresAt.toISOString(),
              trackerTarget: `${tracker.sheetName}!${tracker.startCell}`,
              confirmedAt: row.confirmedAt?.toISOString(),
              lastError: row.lastError,
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
      name: 'applications.cancel_confirmation',
      description:
        'Cancel one pending application confirmation watch by id. Cancellation succeeds only before a matching email has been claimed; it never races or reverses an already-started tracker update.',
      inputSchema: applySchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const [cancelled] = await ctx.db
          .update(applicationConfirmations)
          .set({ status: 'cancelled', updatedAt: ctx.now() })
          .where(
            and(
              eq(applicationConfirmations.id, args.applicationId),
              eq(applicationConfirmations.agentId, ctx.agentId),
              eq(applicationConfirmations.status, 'awaiting_confirmation'),
            ),
          )
          .returning({ id: applicationConfirmations.id });
        if (cancelled) {
          return { applicationId: cancelled.id, status: 'cancelled', cancelled: true };
        }
        const [current] = await ctx.db
          .select({ id: applicationConfirmations.id, status: applicationConfirmations.status })
          .from(applicationConfirmations)
          .where(
            and(
              eq(applicationConfirmations.id, args.applicationId),
              eq(applicationConfirmations.agentId, ctx.agentId),
            ),
          );
        if (!current) throw new Error('application confirmation watch not found');
        return {
          applicationId: current.id,
          status: current.status,
          cancelled: false,
          reason: 'the email was already claimed or the watch is no longer active',
        };
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'applications.apply_confirmation',
      description:
        'Internal confirmation worker. It can execute only for the exact pre-authorized application record carried by a verified internal event.',
      inputSchema: applySchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      idempotencyKey: (args) => {
        const input = args as z.infer<typeof applySchema>;
        return `application-confirmation-apply-${input.applicationId}`;
      },
      execute: async (args, ctx) => {
        const [task] = await ctx.db
          .select({ agentId: tasks.agentId, trigger: tasks.trigger })
          .from(tasks)
          .where(eq(tasks.id, ctx.taskId));
        const trigger = task?.trigger as
          | { source?: unknown; payload?: Record<string, unknown> }
          | undefined;
        if (
          task?.agentId !== ctx.agentId ||
          trigger?.source !== 'internal' ||
          trigger.payload?.kind !== 'application_confirmation' ||
          trigger.payload.applicationId !== args.applicationId
        ) {
          throw new Error(
            'application confirmation tool requires its exact verified internal event',
          );
        }

        const [record] = await ctx.db
          .select()
          .from(applicationConfirmations)
          .where(
            and(
              eq(applicationConfirmations.id, args.applicationId),
              eq(applicationConfirmations.agentId, ctx.agentId),
              eq(applicationConfirmations.status, 'confirmation_received'),
            ),
          );
        if (!record) throw new Error('application confirmation is not ready to apply');
        const update = ApplicationTrackerUpdateSchema.parse(record.trackerUpdate);

        await deps.client.api(
          `${SHEETS}/${encodeURIComponent(update.spreadsheetId)}/values/${encodeURIComponent(a1Range(update.sheetName, update.startCell))}?valueInputOption=RAW`,
          {
            method: 'PUT',
            body: JSON.stringify({ majorDimension: 'ROWS', values: literalRows(update.rows) }),
          },
        );

        const [updated] = await ctx.db
          .update(applicationConfirmations)
          .set({ status: 'updated', lastError: null, updatedAt: ctx.now() })
          .where(
            and(
              eq(applicationConfirmations.id, record.id),
              eq(applicationConfirmations.status, 'confirmation_received'),
            ),
          )
          .returning({ id: applicationConfirmations.id });
        if (!updated) throw new Error('application confirmation changed during tracker update');

        return {
          applicationId: record.id,
          company: record.company,
          role: record.role,
          spreadsheetId: update.spreadsheetId,
          sheetName: update.sheetName,
          startCell: update.startCell,
          writtenRows: update.rows.length,
          status: 'updated',
        };
      },
    },
    {
      internalEventKind: 'application_confirmation',
      internalEventArgument: 'applicationId',
      privateWrite: true,
      blanketAllowIneligible: true,
    },
  );

  return registry;
}
