import { type FlightsFetch, flightsInEmail, trackFlight } from '@assistant/core/flights';
import type { ModelRouter } from '@assistant/core/model-router';
import type {
  GeneratedCardRepository,
  NotificationsConversationRepository,
  WatchRepository,
} from '@assistant/persistence';
import type { InboundEmailEvent } from '../platform.js';
import { flightNotice } from './follow.js';

/**
 * Flights noticed in the owner's mail. A booking confirmation, a schedule
 * change or a check-in reminder names a flight; the owner should not have to
 * ask about it. Each one found is tracked (core/flights/track.ts): a live card
 * now if it leaves within two days, otherwise a card two days before. The
 * owner hears about it once, in the ambient channel, and a later email about
 * the same flight adds nothing.
 *
 * Mail is untrusted, so what it can do is narrow: name flight numbers the
 * email states word for word, which are then looked up at FlightAware. The
 * card and the notice are built from FlightAware's answer, never the email.
 */

export interface FlightEmailDeps {
  router: ModelRouter;
  watches: WatchRepository;
  generatedCards: GeneratedCardRepository;
  notifications: NotificationsConversationRepository;
  notifyOwner: (input: { text: string; urgency?: 'ambient' | 'interrupt' }) => Promise<void>;
  apiKey: string;
  fetchImpl?: FlightsFetch;
}

export async function noticeFlightsInEmail(
  deps: FlightEmailDeps,
  event: InboundEmailEvent,
): Promise<number> {
  const now = event.now ?? new Date();
  const flights = await flightsInEmail({
    router: deps.router,
    subject: event.subject,
    body: event.body,
    received: now,
  });
  if (!flights.length) return 0;
  const conversationId = await deps.notifications.getOrCreate(event.agentId);
  let noticed = 0;
  for (const mention of flights) {
    const tracked = await trackFlight(
      {
        watches: deps.watches,
        generatedCards: deps.generatedCards,
        apiKey: deps.apiKey,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
      {
        agentId: event.agentId,
        flight: mention.flight,
        date: mention.date,
        conversationId,
        source: 'email',
        now,
      },
    );
    if (tracked.outcome === 'carded') {
      await deps.notifyOwner({
        text: `From your email: ${flightNotice(tracked.flight)}`,
        urgency: 'ambient',
      });
      noticed += 1;
    } else if (tracked.outcome === 'waiting') {
      const day = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${tracked.date}T12:00:00Z`));
      await deps.notifyOwner({
        text: `Noticed flight ${tracked.ident} on ${day} in your email. Two days before, it'll be on your Cards page with live times and gate.`,
        urgency: 'ambient',
      });
      noticed += 1;
    }
  }
  return noticed;
}
