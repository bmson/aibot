import type { Db } from '@assistant/db';
import { toolCalls } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq } from 'drizzle-orm';
import { hashCallbackToken } from '../../browse.js';
import type { TaskState, Trust } from '../../events.js';
import type { ProposedToolCall } from '../../model-router/router.js';
import { checkpointTask, type TaskLease } from '../machine.js';
import type { ToolContextLike } from './types.js';
import { compact, toolResultMessage } from './util.js';

type BrowserStageSnapshots = Map<
  string,
  { contextWindow: TaskState['contextWindow']; pendingJob: TaskState['pendingJob'] }
>;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g;
// E.164 numbers carry 8-15 digits; anything outside that matched the regex by
// accident (an order id, a tracking code) and must not become send-approved.
const isPlausiblePhone = (normalized: string) => {
  const digits = normalized.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
};

/**
 * Harvest the recipient addresses the owner actually provided. Two sources:
 * the trigger payload's address headers (from/to/cc — routing metadata the
 * provider authenticated), and, for owner-trust tasks only, the text of the
 * owner's own messages. This is the provenance whitelist the dispatcher checks
 * a send against.
 *
 * Deliberately NOT scanned: tool results (a fetched page or resumed window
 * carries third-party text), assistant messages, and — for external-trust
 * tasks — the inbound message body. A stranger mentioning victim@example.com
 * in their email must not make sending to that address card-free.
 */
export function harvestKnownAddresses(
  state: TaskState,
  trigger: TaskLease['trigger'],
  trust: Trust,
): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
    for (const m of text.match(PHONE_RE) ?? []) {
      const normalized = m.replace(/[^\d+]/g, '');
      if (isPlausiblePhone(normalized)) phones.add(normalized);
    }
  };
  if (trust === 'owner' || trust === 'assistant') {
    for (const message of state.contextWindow ?? []) {
      if ((message as { role?: unknown }).role !== 'user') continue;
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') scan(content);
    }
  }
  const payload = (trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  for (const key of ['from', 'to', 'cc', 'replyTo', 'sender']) {
    const value = payload[key];
    if (typeof value === 'string') scan(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') scan(v);
  }
  return { emails: [...emails], phones: [...phones] };
}

/**
 * Build the tool-execution context handed to the dispatcher. The browser-job
 * staging closures need the LIVE step-loop window and the calls queued after the
 * one that launched a job — both change as the loop runs, so they are read
 * through getters rather than captured by value.
 */
export function createToolContext(args: {
  db: Db;
  task: TaskLease;
  state: TaskState;
  signal: AbortSignal;
  getWindow: () => ModelMessage[];
  getBrowserStageRemainder: () => ProposedToolCall[];
  browserStageSnapshots: BrowserStageSnapshots;
}): ToolContextLike {
  const { db, task, state, browserStageSnapshots } = args;
  return {
    taskId: task.id,
    agentId: task.agentId,
    conversationId: task.conversationId ?? undefined,
    trust: task.trust as Trust,
    tainted: state.untrustedContext,
    knownAddresses: harvestKnownAddresses(state, task.trigger, task.trust as Trust),
    db,
    now: () => new Date(),
    signal: args.signal,
    log: async () => {},
    stageBrowserJob: async (job) => {
      // The raw callback token has already been handed to the job at launch;
      // only its hash is persisted anywhere (task checkpoint AND the tool_calls
      // sentinel), so a DB read never yields a usable callback credential.
      const callbackTokenHash = hashCallbackToken(job.pending.callbackToken);
      const stagedSentinel = { ...job.pending, callbackToken: callbackTokenHash };
      const pendingJob = {
        dbToolCallId: job.dbToolCallId,
        toolCallId: job.modelToolCallId,
        toolName: job.toolName,
        callbackTokenHash,
        timeoutAt: job.pending.timeoutAt,
      };
      // The model may have proposed several calls in one assistant message. A
      // crash after launch cannot leave dangling tool calls in the durable
      // transcript, so calls after browser.execute are checkpointed as refused
      // exactly as the live loop will refuse them below.
      const durableWindow = [
        ...args.getWindow(),
        ...args.getBrowserStageRemainder().map((call) =>
          toolResultMessage(call.toolCallId, call.toolName, {
            error:
              'a browser job is already running for this task — wait for its result before making more tool calls',
          }),
        ),
      ];
      const contextWindow = compact(durableWindow) as unknown as TaskState['contextWindow'];
      const snapshot = {
        contextWindow: state.contextWindow,
        pendingJob: state.pendingJob,
      };
      // If this is an approved call, remove the approval from the DURABLE
      // recovery checkpoint before launch. Keep the in-memory list untouched so
      // the current loop can continue processing its remaining approvals.
      const checkpointState: TaskState = {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (approval) => approval.dbToolCallId !== job.dbToolCallId,
        ),
        pendingJob,
        contextWindow,
      };
      await db.transaction(async (tx) => {
        const [staged] = await tx
          .update(toolCalls)
          .set({ result: stagedSentinel })
          .where(
            and(
              eq(toolCalls.id, job.dbToolCallId),
              eq(toolCalls.taskId, task.id),
              eq(toolCalls.status, 'executing'),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!staged) throw new Error('browser tool call could not be staged');
        if (!(await checkpointTask(tx as unknown as Db, task, checkpointState))) {
          throw new Error('task lease lost while staging browser job');
        }
      });
      browserStageSnapshots.set(job.dbToolCallId, snapshot);
      state.pendingJob = pendingJob;
      state.contextWindow = contextWindow;
    },
    clearStagedBrowserJob: async (job) => {
      const snapshot = browserStageSnapshots.get(job.dbToolCallId);
      const checkpointState: TaskState = {
        ...state,
        pendingJob: snapshot?.pendingJob ?? null,
        contextWindow: snapshot?.contextWindow ?? state.contextWindow,
      };
      await db.transaction(async (tx) => {
        const [cleared] = await tx
          .update(toolCalls)
          .set({ result: null })
          .where(
            and(
              eq(toolCalls.id, job.dbToolCallId),
              eq(toolCalls.taskId, task.id),
              eq(toolCalls.status, 'executing'),
            ),
          )
          .returning({ id: toolCalls.id });
        if (!cleared) throw new Error('staged browser tool call could not be cleared');
        if (!(await checkpointTask(tx as unknown as Db, task, checkpointState))) {
          throw new Error('task lease lost while clearing browser job');
        }
      });
      state.pendingJob = checkpointState.pendingJob;
      state.contextWindow = checkpointState.contextWindow;
      browserStageSnapshots.delete(job.dbToolCallId);
    },
  };
}
