import type { Db, TaskRow } from '@assistant/db';
import { conversations, messages } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { listMessages } from '../../chat.js';
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

export async function seedContext(db: Db, task: TaskRow): Promise<ModelMessage[]> {
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
        const [inbound] = await db
          .select({ text: messages.text })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, task.conversationId),
              eq(messages.channelMessageId, `gmail:${messageId}`),
            ),
          )
          .limit(1);
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
    const rows = await listMessages(db, task.conversationId);
    const conversationWindow = rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(
        (m) =>
          ({ role: m.role as 'user' | 'assistant', content: m.text || '(empty)' }) as ModelMessage,
      );
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
  db: Db,
  task: Pick<TaskRow, 'conversationId'>,
  state: TaskState,
  window: ModelMessage[],
): Promise<void> {
  if (!task.conversationId) return;
  const [conv] = await db
    .select({ channel: conversations.channel })
    .from(conversations)
    .where(eq(conversations.id, task.conversationId))
    .limit(1);
  if (conv?.channel !== 'chat') return;

  if (!state.seenConversationAt) {
    // First run: baseline the mark at the newest existing message (already seeded).
    const [latest] = await db
      .select({ at: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, task.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    state.seenConversationAt = (latest?.at ?? new Date(0)).toISOString();
    return;
  }

  const newer = await db
    .select({ text: messages.text, at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, task.conversationId),
        eq(messages.role, 'user'),
        gt(messages.createdAt, new Date(state.seenConversationAt)),
      ),
    )
    .orderBy(asc(messages.createdAt));
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
  if (last) state.seenConversationAt = last.at.toISOString();
}
