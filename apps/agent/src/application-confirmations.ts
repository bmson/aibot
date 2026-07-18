import {
  claimTask,
  completeTask,
  enqueueTask,
  markTaskNeedsAttention,
  persistMessage,
} from '@assistant/core';
import {
  type ApplicationConfirmationRow,
  applicationConfirmations,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ApplicationTrackerUpdateSchema, hashConfirmationToken } from '@assistant/tools';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { AgentDeps } from './deps.js';

const MAX_TOKEN_CANDIDATES = 1_000;
const TOKEN_PATTERN = /[a-zA-Z0-9][a-zA-Z0-9_-]{5,99}/g;

export type ApplicationConfirmationResult =
  | { kind: 'ignored' }
  | { kind: 'ambiguous'; applicationIds: string[] }
  | { kind: 'in_progress'; applicationId: string }
  | { kind: 'replay'; applicationId: string; status: string };

export interface ApplicationConfirmationInput {
  agentId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  /** True only for Gmail receiver-authenticated, From-aligned SPF/DKIM/DMARC. */
  authenticated: boolean;
  now?: Date;
}

/** Hash bounded opaque-token candidates without exposing raw email to a privileged task. */
export function confirmationTokenHashes(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    result.add(hashConfirmationToken(token));
    if (result.size >= MAX_TOKEN_CANDIDATES) break;
  }
  return result;
}

function eventId(messageId: string): string {
  return `application-confirmation:gmail:${messageId}`;
}

async function postNotice(
  deps: AgentDeps,
  record: ApplicationConfirmationRow,
  taskId: string,
  text: string,
  suffix: string,
): Promise<void> {
  if (!record.conversationId) return;
  await persistMessage(deps.db, {
    conversationId: record.conversationId,
    taskId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
    channelMessageId: `application-confirmation-notice:${taskId}:${suffix}`,
  });
}

async function reportAmbiguous(
  deps: AgentDeps,
  input: ApplicationConfirmationInput,
  matches: ApplicationConfirmationRow[],
): Promise<void> {
  const { task, created } = await enqueueTask(deps.db, {
    type: 'adhoc',
    event: {
      source: 'internal',
      externalEventId: `${eventId(input.messageId)}:ambiguous`,
      agentId: input.agentId,
      conversationId: matches.find((record) => record.conversationId)?.conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation_ambiguous',
        applicationIds: matches.map((record) => record.id),
        from: input.from.toLowerCase(),
        matchCount: matches.length,
      },
    },
    deferNotification: true,
  });
  if (created) {
    const claimed = await claimTask(deps.db, task.id);
    if (claimed) {
      await markTaskNeedsAttention(
        deps.db,
        claimed,
        `Authenticated confirmation from ${input.from.toLowerCase()} matched ${matches.length} active applications; no tracker was changed.`,
      );
    }
  }

  for (const record of matches) {
    await postNotice(
      deps,
      record,
      task.id,
      `I received an authenticated email from ${input.from.toLowerCase()}, but it matched more than one active application watch. I did not update any tracker. Review the application references ending in ${matches.map((candidate) => candidate.confirmationTokenHint).join(', ')}.`,
      `ambiguous:${record.id}`,
    );
  }
}

async function enqueueAuthorizedUpdate(
  deps: AgentDeps,
  input: ApplicationConfirmationInput,
  record: ApplicationConfirmationRow,
): Promise<ApplicationConfirmationResult> {
  const { task } = await enqueueTask(deps.db, {
    type: 'adhoc',
    event: {
      source: 'internal',
      externalEventId: eventId(input.messageId),
      agentId: input.agentId,
      conversationId: record.conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation',
        applicationId: record.id,
        confirmationMessageId: `gmail:${input.messageId}`,
      },
    },
    maxSteps: 1,
  });

  if (task.status === 'done') {
    return { kind: 'replay', applicationId: record.id, status: 'updated' };
  }
  if (task.status === 'needs_attention' || task.status === 'failed') {
    return { kind: 'replay', applicationId: record.id, status: record.status };
  }

  return { kind: 'in_progress', applicationId: record.id };
}

export type ApplicationConfirmationTaskResult = {
  outcome: 'done' | 'needs_attention' | 'not_claimable';
  applicationId?: string;
};

/** Deterministic recovery route for an ambiguous multi-record match. */
export async function executeAmbiguousApplicationConfirmationTask(
  deps: AgentDeps,
  taskId: string,
): Promise<ApplicationConfirmationTaskResult> {
  const [queued] = await deps.db.select().from(tasks).where(eq(tasks.id, taskId));
  const trigger = queued?.trigger as
    | { source?: unknown; payload?: Record<string, unknown> }
    | undefined;
  if (
    !queued ||
    trigger?.source !== 'internal' ||
    trigger.payload?.kind !== 'application_confirmation_ambiguous'
  ) {
    return { outcome: 'not_claimable' };
  }
  if (queued.status === 'needs_attention') return { outcome: 'needs_attention' };
  const claimed = await claimTask(deps.db, queued.id);
  if (!claimed) return { outcome: 'not_claimable' };
  const count = Number(trigger.payload.matchCount);
  const from = typeof trigger.payload.from === 'string' ? trigger.payload.from : 'the sender';
  await markTaskNeedsAttention(
    deps.db,
    claimed,
    `Authenticated confirmation from ${from} matched ${Number.isInteger(count) ? count : 'multiple'} active applications; no tracker was changed.`,
  );
  return { outcome: 'needs_attention' };
}

/** Durable queue handler: confirmation tasks never enter the model executor. */
export async function executeApplicationConfirmationTask(
  deps: AgentDeps,
  taskId: string,
): Promise<ApplicationConfirmationTaskResult> {
  const [queued] = await deps.db.select().from(tasks).where(eq(tasks.id, taskId));
  const trigger = queued?.trigger as
    | { source?: unknown; payload?: Record<string, unknown> }
    | undefined;
  const applicationId = trigger?.payload?.applicationId;
  if (
    !queued ||
    trigger?.source !== 'internal' ||
    trigger.payload?.kind !== 'application_confirmation' ||
    typeof applicationId !== 'string'
  ) {
    return { outcome: 'not_claimable' };
  }

  const [record] = await deps.db
    .select()
    .from(applicationConfirmations)
    .where(
      and(
        eq(applicationConfirmations.id, applicationId),
        eq(applicationConfirmations.agentId, queued.agentId),
      ),
    );
  if (!record) return { outcome: 'not_claimable' };
  if (queued.status === 'done') return { outcome: 'done', applicationId };
  if (queued.status === 'needs_attention' || queued.status === 'failed') {
    return { outcome: 'needs_attention', applicationId };
  }

  const claimed = await claimTask(deps.db, queued.id);
  if (!claimed) return { outcome: 'not_claimable', applicationId };

  // The Sheet may have committed before a process died while recording the
  // tool result. The record transition happens inside the tool immediately
  // after Google's response, so it is the durable recovery checkpoint.
  if (record.status === 'updated') {
    const tracker = ApplicationTrackerUpdateSchema.parse(record.trackerUpdate);
    // Reconcile the ledger if the process died after the durable record
    // checkpoint but before Dispatcher marked its tool call succeeded.
    await deps.db
      .update(toolCalls)
      .set({
        status: 'succeeded',
        result: {
          applicationId: record.id,
          company: record.company,
          role: record.role,
          spreadsheetId: tracker.spreadsheetId,
          sheetName: tracker.sheetName,
          startCell: tracker.startCell,
          writtenRows: tracker.rows.length,
          status: 'updated',
          recoveredFromRecord: true,
        },
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(toolCalls.taskId, claimed.id),
          eq(toolCalls.toolName, 'applications.apply_confirmation'),
          eq(toolCalls.status, 'executing'),
        ),
      );
    await postNotice(
      deps,
      record,
      claimed.id,
      `I matched the authenticated confirmation for ${record.company} — ${record.role} (reference ending ${record.confirmationTokenHint}) and updated the approved tracker range.`,
      'updated',
    );
    await completeTask(deps.db, claimed, {
      status: 'done',
      progress: `Matched authenticated confirmation for ${record.company} — ${record.role} and applied the pre-authorized tracker update.`,
    });
    return { outcome: 'done', applicationId };
  }
  if (record.status === 'update_unknown' || record.status === 'update_failed') {
    await postNotice(
      deps,
      record,
      claimed.id,
      record.status === 'update_unknown'
        ? `I matched the authenticated confirmation for ${record.company} — ${record.role}, but the tracker update outcome is unknown after an interrupted attempt. I did not retry. Please verify the Sheet manually.`
        : `I matched the authenticated confirmation for ${record.company} — ${record.role}, but the approved tracker update failed. No success is being claimed; the task needs attention.`,
      record.status === 'update_unknown' ? 'unknown' : 'failed',
    );
    await markTaskNeedsAttention(
      deps.db,
      claimed,
      record.lastError ?? 'The pre-authorized tracker update needs attention.',
    );
    return { outcome: 'needs_attention', applicationId };
  }
  if (record.status !== 'confirmation_received') {
    await markTaskNeedsAttention(
      deps.db,
      claimed,
      `Application confirmation record is ${record.status}; no tracker update was attempted.`,
    );
    return { outcome: 'needs_attention', applicationId };
  }

  const outcome = await deps.dispatcher.dispatch({
    task: claimed,
    step: 1,
    toolName: 'applications.apply_confirmation',
    args: { applicationId: record.id },
    ctx: {
      taskId: claimed.id,
      agentId: claimed.agentId,
      conversationId: claimed.conversationId ?? undefined,
      trust: 'assistant',
      tainted: false,
      db: deps.db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    },
    provenance: { plannerVersion: 0, promptVersion: 0, model: 'deterministic/email-match' },
  });

  if (outcome.kind === 'executed') {
    const result = outcome.result as { deliveryStatus?: unknown; status?: unknown } | null;
    if (result?.deliveryStatus === 'unknown') {
      const detail = 'Google may have accepted the tracker update; automatic retry was suppressed.';
      await deps.db
        .update(applicationConfirmations)
        .set({ status: 'update_unknown', lastError: detail, updatedAt: new Date() })
        .where(
          and(
            eq(applicationConfirmations.id, record.id),
            eq(applicationConfirmations.status, 'confirmation_received'),
          ),
        );
      await postNotice(
        deps,
        record,
        claimed.id,
        `I matched the authenticated confirmation for ${record.company} — ${record.role}, but Google returned an ambiguous result while updating the tracker. I did not retry because that could duplicate or overwrite data. Please verify the Sheet manually.`,
        'unknown',
      );
      await markTaskNeedsAttention(deps.db, claimed, detail);
      return { outcome: 'needs_attention', applicationId };
    }

    const progress = `Matched authenticated confirmation for ${record.company} — ${record.role} and applied the pre-authorized tracker update.`;
    await postNotice(
      deps,
      record,
      claimed.id,
      `I matched the authenticated confirmation for ${record.company} — ${record.role} (reference ending ${record.confirmationTokenHint}) and updated the approved tracker range.`,
      'updated',
    );
    await completeTask(deps.db, claimed, { status: 'done', progress });
    return { outcome: 'done', applicationId };
  }

  const reason =
    outcome.kind === 'rejected'
      ? outcome.reason
      : outcome.kind === 'budget_blocked'
        ? outcome.reason
        : 'the confirmation update unexpectedly requested approval';
  const retryWouldBeAmbiguous =
    outcome.kind === 'rejected' &&
    /already executing|ambiguous side-effect retry|already recorded/i.test(outcome.reason);
  const status = retryWouldBeAmbiguous ? 'update_unknown' : 'update_failed';
  await deps.db
    .update(applicationConfirmations)
    .set({
      status,
      lastError: reason.slice(0, 2_000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applicationConfirmations.id, record.id),
        eq(applicationConfirmations.status, 'confirmation_received'),
      ),
    );
  await postNotice(
    deps,
    record,
    claimed.id,
    retryWouldBeAmbiguous
      ? `I matched the authenticated confirmation for ${record.company} — ${record.role}, but the tracker update outcome is unknown after an interrupted attempt. I did not retry. Please verify the Sheet manually.`
      : `I matched the authenticated confirmation for ${record.company} — ${record.role}, but the approved tracker update failed. No success is being claimed; the task needs attention.`,
    retryWouldBeAmbiguous ? 'unknown' : 'failed',
  );
  await markTaskNeedsAttention(deps.db, claimed, reason);
  return { outcome: 'needs_attention', applicationId };
}

/**
 * Match one Gmail message to one pre-authorized application watch and execute
 * only its frozen tracker update. Raw subject/body never enters the internal
 * assistant task or model context.
 */
export async function processApplicationConfirmation(
  deps: AgentDeps,
  input: ApplicationConfirmationInput,
): Promise<ApplicationConfirmationResult> {
  if (!input.authenticated) return { kind: 'ignored' };
  const now = input.now ?? new Date();
  const from = input.from.trim().toLowerCase();
  if (!from || !input.messageId) return { kind: 'ignored' };

  await deps.db
    .update(applicationConfirmations)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(applicationConfirmations.agentId, input.agentId),
        eq(applicationConfirmations.status, 'awaiting_confirmation'),
        lte(applicationConfirmations.expiresAt, now),
      ),
    );

  const confirmationMessageId = `gmail:${input.messageId}`;
  const [alreadyClaimed] = await deps.db
    .select()
    .from(applicationConfirmations)
    .where(
      and(
        eq(applicationConfirmations.agentId, input.agentId),
        eq(applicationConfirmations.confirmationMessageId, confirmationMessageId),
      ),
    );
  if (alreadyClaimed) {
    if (alreadyClaimed.status === 'confirmation_received') {
      return enqueueAuthorizedUpdate(deps, input, alreadyClaimed);
    }
    return {
      kind: 'replay',
      applicationId: alreadyClaimed.id,
      status: alreadyClaimed.status,
    };
  }

  const candidates = await deps.db
    .select()
    .from(applicationConfirmations)
    .where(
      and(
        eq(applicationConfirmations.agentId, input.agentId),
        eq(applicationConfirmations.status, 'awaiting_confirmation'),
        gt(applicationConfirmations.expiresAt, now),
        sql`${from} = ANY(${applicationConfirmations.expectedSenderEmails})`,
      ),
    );
  if (candidates.length === 0) return { kind: 'ignored' };

  const hashes = confirmationTokenHashes(`${input.subject}\n${input.body}`);
  const matches = candidates.filter((candidate) => hashes.has(candidate.confirmationTokenHash));
  if (matches.length === 0) return { kind: 'ignored' };
  if (matches.length > 1) {
    await reportAmbiguous(deps, input, matches);
    return { kind: 'ambiguous', applicationIds: matches.map((record) => record.id) };
  }

  const match = matches[0] as ApplicationConfirmationRow;
  const [claimed] = await deps.db
    .update(applicationConfirmations)
    .set({
      status: 'confirmation_received',
      confirmationMessageId,
      confirmationFrom: from,
      confirmedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(applicationConfirmations.id, match.id),
        eq(applicationConfirmations.status, 'awaiting_confirmation'),
        gt(applicationConfirmations.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) {
    const [current] = await deps.db
      .select()
      .from(applicationConfirmations)
      .where(eq(applicationConfirmations.id, match.id));
    return current
      ? { kind: 'replay', applicationId: current.id, status: current.status }
      : { kind: 'ignored' };
  }

  return enqueueAuthorizedUpdate(deps, input, claimed);
}
