import type { Db, TaskRow } from '@assistant/db';
import { messages } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { and, eq } from 'drizzle-orm';
import { listMessages } from '../../chat.js';
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
