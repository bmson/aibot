import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { GoogleClient } from './client.js';

const CAL = 'https://www.googleapis.com/calendar/v3';

export interface CalendarToolDeps {
  client: GoogleClient;
  botEmail: string;
  ownerEmail: string;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export function registerCalendarTools(
  registry: ToolRegistry,
  deps: CalendarToolDeps,
): ToolRegistry {
  register(
    registry,
    {
      name: 'calendar.availability',
      description:
        "Check free/busy for the assistant's calendar and the owner's (if shared). Times are ISO 8601 with offset.",
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 300,
      execute: async (args) => {
        const res = await deps.client.api<{
          calendars?: Record<
            string,
            { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
          >;
        }>(`${CAL}/freeBusy`, {
          method: 'POST',
          body: JSON.stringify({
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            items: [{ id: deps.botEmail }, { id: deps.ownerEmail }],
          }),
        });
        const calendars = res.calendars ?? {};
        return {
          bot: calendars[deps.botEmail]?.busy ?? [],
          owner:
            calendars[deps.ownerEmail]?.errors !== undefined
              ? 'unavailable — owner has not shared free/busy with the assistant'
              : (calendars[deps.ownerEmail]?.busy ?? []),
        };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  register(
    registry,
    {
      name: 'calendar.list_events',
      description: "List upcoming events on the assistant's own calendar.",
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const url = `${CAL}/calendars/primary/events?timeMin=${encodeURIComponent(args.timeMin)}&timeMax=${encodeURIComponent(args.timeMax)}&maxResults=${args.maxResults}&singleEvents=true&orderBy=startTime`;
        const res = await deps.client.api<{
          items?: Array<{
            id: string;
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            attendees?: Array<{ email: string; responseStatus?: string }>;
          }>;
        }>(url);
        return {
          events: (res.items ?? []).map((e) => ({
            eventId: e.id,
            summary: e.summary ?? '',
            start: e.start?.dateTime ?? e.start?.date ?? '',
            end: e.end?.dateTime ?? e.end?.date ?? '',
            attendees: (e.attendees ?? []).map((a) => `${a.email} (${a.responseStatus ?? '?'})`),
          })),
        };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  const createSchema = z.object({
    summary: z.string().min(1).max(200),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    description: z.string().max(4000).default(''),
    location: z.string().max(300).default(''),
    /** Adding attendees sends real invite emails — that's what gates approval. */
    attendees: z.array(z.string().email()).max(20).default([]),
  });

  register(
    registry,
    {
      name: 'calendar.create_event',
      description:
        "Create an event on the assistant's own calendar. With attendees it sends real invite emails (the usual way to put something on the owner's calendar: invite them).",
      inputSchema: createSchema,
      risk: (args) =>
        ((args as z.infer<typeof createSchema>).attendees?.length ?? 0) > 0
          ? 'approval'
          : 'autonomous',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const a = args as z.infer<typeof createSchema>;
        return `Create event "${a.summary}" ${a.start} and invite ${a.attendees.join(', ')}`;
      },
      idempotencyKey: (args, ctx) => {
        const a = args as z.infer<typeof createSchema>;
        return `cal-create-${ctx.taskId}-${a.summary}-${a.start}`;
      },
      execute: async (args) => {
        const event = await deps.client.api<{ id: string; htmlLink?: string }>(
          `${CAL}/calendars/primary/events?sendUpdates=all`,
          {
            method: 'POST',
            body: JSON.stringify({
              summary: args.summary,
              description: args.description || undefined,
              location: args.location || undefined,
              start: { dateTime: args.start },
              end: { dateTime: args.end },
              attendees: args.attendees.map((email) => ({ email })),
            }),
          },
        );
        return { eventId: event.id, link: event.htmlLink, invited: args.attendees };
      },
    },
    { outwardFacing: true },
  );

  register(
    registry,
    {
      name: 'calendar.search_events',
      description:
        "Search the assistant's own calendar by keyword (attendee, title, or location). Times are ISO 8601 with offset.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const params = new URLSearchParams({
          q: args.query,
          maxResults: String(args.maxResults),
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        if (args.timeMin) params.set('timeMin', args.timeMin);
        if (args.timeMax) params.set('timeMax', args.timeMax);
        const res = await deps.client.api<{
          items?: Array<{
            id: string;
            summary?: string;
            location?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            attendees?: Array<{ email: string; responseStatus?: string }>;
          }>;
        }>(`${CAL}/calendars/primary/events?${params.toString()}`);
        return {
          events: (res.items ?? []).map((e) => ({
            eventId: e.id,
            summary: e.summary ?? '',
            location: e.location ?? '',
            start: e.start?.dateTime ?? e.start?.date ?? '',
            end: e.end?.dateTime ?? e.end?.date ?? '',
            attendees: (e.attendees ?? []).map((a) => `${a.email} (${a.responseStatus ?? '?'})`),
          })),
        };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  const updateSchema = z
    .object({
      eventId: z.string().min(3).max(200),
      summary: z.string().min(1).max(200).optional(),
      start: z.string().datetime({ offset: true }).optional(),
      end: z.string().datetime({ offset: true }).optional(),
      location: z.string().max(300).optional(),
      description: z.string().max(4000).optional(),
      addAttendees: z.array(z.string().email()).max(20).optional(),
    })
    .refine(
      (u) =>
        u.summary !== undefined ||
        u.start !== undefined ||
        u.end !== undefined ||
        u.location !== undefined ||
        u.description !== undefined ||
        (u.addAttendees?.length ?? 0) > 0,
      { message: 'provide at least one field to change' },
    );

  register(
    registry,
    {
      name: 'calendar.update_event',
      description:
        "Reschedule or edit an existing event on the assistant's own calendar (new time, title, location, or added attendees). Attendees are notified.",
      inputSchema: updateSchema,
      // Conservative v1: always approval. The risk callback only sees the new
      // args, not whether the EXISTING event has attendees who'd be notified of a
      // reschedule, so a dynamic tier would under-gate that case. Revisit if it
      // proves noisy for solo events.
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        const changes = [
          a.start ? `move to ${a.start}` : '',
          a.summary ? `rename to "${a.summary}"` : '',
          a.location ? `at ${a.location}` : '',
          a.addAttendees?.length ? `invite ${a.addAttendees.join(', ')}` : '',
        ].filter(Boolean);
        return `Update calendar event ${a.eventId}: ${changes.join('; ') || 'edit details'}`;
      },
      execute: async (args) => {
        // Merge added attendees onto the existing set so the PATCH doesn't drop
        // current invitees (Calendar replaces the attendees array wholesale).
        const patch: Record<string, unknown> = {};
        if (args.summary !== undefined) patch.summary = args.summary;
        if (args.start !== undefined) patch.start = { dateTime: args.start };
        if (args.end !== undefined) patch.end = { dateTime: args.end };
        if (args.location !== undefined) patch.location = args.location;
        if (args.description !== undefined) patch.description = args.description;
        if (args.addAttendees?.length) {
          const existing = await deps.client.api<{
            attendees?: Array<{ email: string }>;
          }>(`${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}`);
          const emails = new Set((existing.attendees ?? []).map((a) => a.email.toLowerCase()));
          for (const email of args.addAttendees) emails.add(email.toLowerCase());
          patch.attendees = [...emails].map((email) => ({ email }));
        }
        const updated = await deps.client.api<{ id: string; htmlLink?: string }>(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=all`,
          { method: 'PATCH', body: JSON.stringify(patch) },
        );
        return { eventId: updated.id, link: updated.htmlLink, updated: true };
      },
    },
    { outwardFacing: true },
  );

  register(
    registry,
    {
      name: 'calendar.cancel_event',
      description:
        "Cancel an event on the assistant's calendar. If it has attendees they are notified — hence approval.",
      inputSchema: z.object({ eventId: z.string().min(3).max(200) }),
      // Conservative v1: cancellation always needs approval (attendee check
      // would need an async risk fn; revisit if it gets annoying).
      risk: 'approval',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => `Cancel calendar event ${(args as { eventId: string }).eventId}`,
      execute: async (args) => {
        await deps.client.api(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=all`,
          { method: 'DELETE' },
        );
        return { cancelled: args.eventId };
      },
    },
    { outwardFacing: true },
  );

  return registry;
}
