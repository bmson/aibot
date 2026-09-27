import { type FlightsFetch, lookupFlight } from '@assistant/core/flights';
import { z } from 'zod';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';

export function registerFlightTools(
  registry: ToolRegistry,
  deps: { apiKey: string; fetchImpl?: FlightsFetch },
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
  return registry;
}
