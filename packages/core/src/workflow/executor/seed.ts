import { createPostgresExecutionContextRepository, type Db, type TaskRow } from '@assistant/db';
import type { ExecutionContextRepository } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { BACKGROUND_NOTICE_MARKER } from '../../chat.js';
import { conversationMessageTexts } from '../../conversation-context.js';
import type { TaskState } from '../../events.js';
import { isKnownSenderReplyTask, isUnattendedGoalSession } from './context-helpers.js';

function triggerInstruction(task: TaskRow): string | undefined {
  const trigger = task.trigger as { payload?: { text?: unknown; instruction?: unknown } } | null;
  return typeof trigger?.payload?.text === 'string'
    ? trigger.payload.text
    : typeof trigger?.payload?.instruction === 'string'
      ? trigger.payload.instruction
      : undefined;
}

function executionContextRepository(
  value: Db | ExecutionContextRepository,
): ExecutionContextRepository {
  return (value as Partial<ExecutionContextRepository>).kind === 'execution-context-repository'
    ? (value as ExecutionContextRepository)
    : createPostgresExecutionContextRepository(value as Db);
}

export async function seedContext(
  db: Db | ExecutionContextRepository,
  task: TaskRow,
): Promise<ModelMessage[]> {
  const repository = executionContextRepository(db);
  if (task.conversationId) {
    // A deterministically-enqueued known-sender reply child (D9) carries its
    // exact instruction + draft on the trigger. Seed from that, never the shared
    // (known-trust) email thread, so the child proposes precisely that reply and
    // reads no other message in the conversation.
    if (isKnownSenderReplyTask(task)) {
      const instruction = (task.trigger as { payload?: { instruction?: unknown } } | null)?.payload
        ?.instruction;
      if (typeof instruction === 'string' && instruction.length > 0) {
        return [{ role: 'user', content: instruction } as ModelMessage];
      }
    }
    if (task.trust === 'known' || task.trust === 'unknown') {
      const trigger = task.trigger as {
        source?: unknown;
        payload?: { messageId?: unknown };
      } | null;
      const messageId =
        trigger?.source === 'email' && typeof trigger.payload?.messageId === 'string'
          ? trigger.payload.messageId
          : undefined;
      if (messageId) {
        const inbound = await repository.getInboundMessage({
          agentId: task.agentId,
          conversationId: task.conversationId,
          channelMessageId: `gmail:${messageId}`,
        });
        if (inbound) return [{ role: 'user', content: inbound.text } as ModelMessage];
      }
      // Never expose the rest of a private bound conversation to an external
      // sender when no event-specific message can be proven.
      return [
        {
          role: 'user',
          content: `External task trigger (${task.type}):\n${JSON.stringify(task.trigger)}`,
        } as ModelMessage,
      ];
    }
    const recent = await repository.seedHistory({
      agentId: task.agentId,
      conversationId: task.conversationId,
      before: new Date(Date.now() + 1),
      limit: 20,
    });
    // A reminder that fired, a pulse alert, a briefing — all of these land in
    // the owner's primary thread, which is the same thread they chat in. Seeded
    // as bare assistant turns they are indistinguishable from replies, and a
    // model asked a question with one sitting at the end of its window answers
    // the question and then repeats the notice back. Name them instead.
    const notices = await repository.noticeIds(task.agentId, recent);
    const contextTexts =
      task.trust === 'owner' && task.type === 'chat_turn'
        ? conversationMessageTexts(recent, notices)
        : new Map<string, string>();
    const conversationWindow = recent.map((m) => {
      const text = contextTexts.get(m.id) || m.text || '(empty)';
      return {
        role: m.role as 'user' | 'assistant',
        content: notices.has(m.id) ? `${BACKGROUND_NOTICE_MARKER}\n${text}` : text,
      } as ModelMessage;
    });
    const initialInstruction = triggerInstruction(task);

    // A goal's work chat is intentionally reused across automatic sessions.
    // Conversation history supplies useful continuity, but it is not the task
    // instruction and does not contain the durable Goal ID. Always append the
    // generated session instruction so progress writes target the bound goal
    // instead of forcing the model to guess an ID from old chat messages.
    if (isUnattendedGoalSession(task) && initialInstruction) {
      return [...conversationWindow, { role: 'user', content: initialInstruction } as ModelMessage];
    }

    // A scheduled firing is a new instruction, not a continuation of whatever
    // the owner happened to discuss last in the bound chat. In production a
    // reminder inherited a photo-search conversation, searched Drive, and
    // silently dropped the reminder text. Goal sessions are the sole scheduled
    // exception above because their durable work chat is intentional context.
    if (task.type === 'scheduled' && initialInstruction) {
      return [{ role: 'user', content: initialInstruction } as ModelMessage];
    }
    if (conversationWindow.length > 0) return conversationWindow;

    // A newly-created Goal work chat deliberately does not render the
    // system-generated opening instruction as if the owner had written it.
    // Its durable task trigger remains the source of truth for the first
    // model step, so the work can begin without a misleading chat bubble.
    if (initialInstruction) {
      return [{ role: 'user', content: initialInstruction } as ModelMessage];
    }
    return conversationWindow;
  }
  return [
    {
      role: 'user',
      content: `Task trigger (${task.type}):\n\`\`\`json\n${JSON.stringify(task.trigger)}\n\`\`\``,
    } as ModelMessage,
  ];
}

/**
 * Fold owner corrections typed while the task was parked into the resumed window.
 *
 * A task parks on an approval; the owner adds "actually make it Bob" in the same
 * chat; that reply becomes its OWN task and the parked task, on resume, would run
 * from a stale window and act on the pre-correction args. Append owner chat
 * messages newer than the watermark so the correction shapes the NEXT model step.
 *
 * Chat channel ONLY: never re-inject email/SMS conversation content, which can
 * carry third-party text (the taint boundary). The approved call's exact args
 * stay authoritative — the owner's Approve click post-dates their correction, so
 * this shapes what happens next rather than rewriting a decided action; Deny
 * remains the cancel path. Idempotent: the watermark advances past folded
 * messages, so a second resume appends nothing. On the first run (no watermark)
 * it only initializes the mark from the latest existing message — the seed window
 * already holds those — so nothing is double-counted.
 */
export async function foldOwnerRepliesSincePark(
  db: Db | ExecutionContextRepository,
  task: Pick<TaskRow, 'conversationId' | 'agentId'>,
  state: TaskState,
  window: ModelMessage[],
): Promise<void> {
  if (!task.conversationId) return;
  const repository = executionContextRepository(db);

  if (!state.seenConversationAt) {
    // First run: baseline the mark at the newest existing message (already seeded).
    const baseline = await repository.getLatestOwnerReplyCursor({
      agentId: task.agentId,
      conversationId: task.conversationId,
    });
    if (!baseline) return;
    state.seenConversationAt = (baseline.cursor?.createdAt ?? new Date(0)).toISOString();
    state.seenConversationId = baseline.cursor?.id ?? null;
    return;
  }

  const seenAt = new Date(state.seenConversationAt);
  if (!Number.isFinite(seenAt.getTime())) throw new Error('Invalid conversation watermark');
  const newer = await repository.getOwnerRepliesAfter({
    agentId: task.agentId,
    conversationId: task.conversationId,
    after: {
      createdAt: seenAt,
      ...(state.seenConversationId ? { id: state.seenConversationId } : {}),
    },
    limit: 200,
  });
  if (newer.length === 0) return;
  for (const m of newer) {
    const text = m.text?.trim();
    if (text) {
      window.push({
        role: 'user',
        content: `[The owner added this while the task was paused:]\n${text}`,
      } as ModelMessage);
    }
  }
  const last = newer[newer.length - 1];
  if (last) {
    state.seenConversationAt = last.createdAt.toISOString();
    state.seenConversationId = last.id;
  }
}
