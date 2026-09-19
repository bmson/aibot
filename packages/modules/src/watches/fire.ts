import { persistMessage } from '@assistant/core';
import type { WatchRow } from '@assistant/db';
import type { MessageRepository, WatchRepository } from '@assistant/persistence';
import type { OwnerNotifier } from '../platform.js';

/** What recording a watch firing needs: the database and the owner-notifier port. */
export interface WatchFireDeps {
  watches: WatchRepository;
  messages: MessageRepository;
  notifyOwner: OwnerNotifier['notifyOwner'];
}

/**
 * Record one watch firing idempotently and notify the owner. The unique
 * (watch_id, trigger_ref) index is the fence: a repeated trigger returns false
 * without re-notifying or re-counting. On a genuine fire it bumps fireCount,
 * exhausts a bounded watch once it reaches maxFires, posts the notice to the
 * watch's chat, and pings the owner. Shared by the email matcher and the web
 * poller so both behave identically. The owner-facing text is caller-supplied
 * and must never contain raw watched content — only a spec-derived summary.
 */
export async function recordWatchFire(
  deps: WatchFireDeps,
  watch: WatchRow,
  fire: { triggerRef: string; text: string; channelMessageId: string; excerpt?: string },
  now: Date,
): Promise<boolean> {
  const result = await deps.watches.recordFire({
    watchId: watch.id,
    agentId: watch.agentId,
    triggerRef: fire.triggerRef,
    summary: fire.text,
    excerpt: fire.excerpt ?? '',
    now,
  });
  if (!result.recorded) return false;

  if (watch.conversationId) {
    await persistMessage(deps.messages, {
      conversationId: watch.conversationId,
      role: 'assistant',
      origin: 'assistant',
      parts: [{ type: 'text', text: fire.text }],
      text: fire.text,
      channelMessageId: fire.channelMessageId,
    }).catch((err) => console.error('watch notice failed', err));
  }
  // A watch hit is ambient: the owner asked to know, but not necessarily at
  // 3am — quiet hours and the daily cap govern the phone legs.
  await deps
    .notifyOwner({ text: fire.text, urgency: 'ambient' })
    .catch((err) => console.error('watch owner notification failed', err));
  return true;
}
