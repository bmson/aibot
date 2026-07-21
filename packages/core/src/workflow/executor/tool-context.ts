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
