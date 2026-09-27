import { type FlightsFetch, lookupFlight, trackFlight } from '@assistant/core/flights';
import type { GeneratedCardRepository, WatchRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';

export function registerFlightTools(
  registry: ToolRegistry,
  deps: {
    apiKey: string;
    fetchImpl?: FlightsFetch;
    /** Where a tracked flight's waiting watch and card are kept. */
    tracking?: { watches: WatchRepository; generatedCards: GeneratedCardRepository };
  },
) {
  register(
    registry,
    {
      name: 'flights.status',
      description:
        'Live status of one flight from FlightAware: departure and arrival times on each airport\'s clock (scheduled, estimated, actual), gates, terminals, baggage claim, delay, and progress in the air. Give the flight number as written ("FI614", "UA 1", "BAW283"); add `date` (the departure day, YYYY-MM-DD) when the owner names one, otherwise the flight in the air or the next to leave is returned. Covers ten days back and two days ahead. The chat draws the flight as a live card that updates itself and can follow the flight on the Lock Screen, so the reply only needs the takeaway: on time or how late, and the gate. `notFound` means no such flight in that window — say so rather than guessing.',
      inputSchema: z.object({
        flight: z.string().min(2).max(12).describe('Flight number, e.g. "FI614" or "UA 1".'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'Departure date in the departure city, YYYY-MM-DD. Omit for the current or next flight.',
          ),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 60,
      execute: async (args, ctx) => {
        try {
          return await lookupFlight({
            apiKey: deps.apiKey,
            ident: args.flight,
            ...(args.date ? { date: args.date } : {}),
            now: ctx.now(),
            signal: ctx.signal,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } catch (err) {
          return { error: `FlightAware could not be reached: ${String(err)}` };
        }
      },
    },
    // Neither networkEgress nor returnsUntrustedContent, like weather.lookup
    // and maps.directions: the host is fixed, the only argument that reaches
    // a URL is a designator checked against a strict pattern, and the result
    // is times, codes and gate numbers rather than third-party prose.
    {},
  );

  const tracking = deps.tracking;
  if (tracking)
    register(
      registry,
      {
        name: 'flights.track',
        description:
          'Keep track of a flight the owner is taking, before they ask about it: "I\'m flying FI614 on December 1", "keep an eye on my flight BA283 next Friday". Give the flight number and the departure date (YYYY-MM-DD, in the departure city). A flight within two days becomes a live card on the Cards page now; one further out is checked two days before departure, when the card appears and the owner is told. Tracking the same flight twice does nothing. Use flights.status instead for a question about a flight right now.',
        inputSchema: z.object({
          flight: z.string().min(2).max(12),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        risk: 'autonomous',
        acceptsUntrustedInput: false,
        execute: async (args, ctx) => {
          try {
            return await trackFlight(
              {
                watches: tracking.watches,
                generatedCards: tracking.generatedCards,
                apiKey: deps.apiKey,
                ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
              },
              {
                agentId: ctx.agentId,
                flight: args.flight,
                date: args.date,
                source: 'chat',
                now: ctx.now(),
                ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
              },
            );
          } catch (err) {
            return { error: `The flight could not be tracked: ${String(err)}` };
          }
        },
      },
      // It files a watch and a card: a private write, like watch.create.
      { privateWrite: true },
    );
  return registry;
}
