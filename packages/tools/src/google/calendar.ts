import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { GoogleClient } from './client.js';

const CAL = 'https://www.googleapis.com/calendar/v3';

/**
 * How many calendars a single read will fan out across. A Google account
 * typically carries a handful, but subscribed holiday/birthday calendars can
 * push the list up, and every extra calendar is another HTTP round trip.
 */
const MAX_CALENDAR_FANOUT = 50;

/** freeBusy accepts at most 50 items per request. */
const MAX_FREEBUSY_ITEMS = 50;

export interface CalendarToolDeps {
  client: GoogleClient;
  botEmail: string;
  ownerEmail: string;
}

interface CalendarEntry {
  id: string;
  name: string;
  primary: boolean;
  accessRole: string;
}

interface RawEvent {
  id: string;
  iCalUID?: string;
  recurringEventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  organizer?: { email?: string; displayName?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; responseStatus?: string }>;
}

function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>'"`]+/gi) ?? []).map((url) =>
    url.replace(/[.,;:!?)\]]+$/, ''),
  );
}

function isVideoConferenceURL(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'webex.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/**
 * Every calendar this account can read — its own plus any the owner (or anyone
 * else) has shared with it. `calendar.readonly` already covers shared
 * calendars; before this the tools only ever addressed `calendars/primary`, so
 * a calendar shared with the bot was invisible no matter how it was shared.
 */
async function fetchCalendars(client: GoogleClient): Promise<CalendarEntry[]> {
  const res = await client.api<{
    items?: Array<{
      id?: string;
      summary?: string;
      summaryOverride?: string;
      primary?: boolean;
      accessRole?: string;
      deleted?: boolean;
    }>;
  }>(`${CAL}/users/me/calendarList?minAccessRole=reader&maxResults=250&showDeleted=false`);
  return (res.items ?? [])
    .filter((c): c is typeof c & { id: string } => Boolean(c.id) && c.deleted !== true)
    .map((c) => ({
      id: c.id,
      // summaryOverride is the name the owner gave it locally; prefer it.
      name: c.summaryOverride || c.summary || c.id,
      primary: c.primary === true,
      accessRole: c.accessRole ?? 'reader',
    }));
}

function startedAt(event: { start: string }): number {
  const ms = Date.parse(event.start);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function normalizeEvent(raw: RawEvent, calendar: CalendarEntry) {
  const links: Array<{ type: string; label: string; url: string }> = [];
  const addLink = (type: string, label: string, url?: string) => {
    if (!url || !/^https?:\/\//i.test(url) || links.some((link) => link.url === url)) return;
    links.push({ type, label, url });
  };
  addLink('calendar', 'Open in Google Calendar', raw.htmlLink);
  addLink('video', 'Video meeting', raw.hangoutLink);
  for (const entry of raw.conferenceData?.entryPoints ?? []) {
    addLink(entry.entryPointType ?? 'conference', entry.label ?? 'Conference link', entry.uri);
  }
  for (const url of urlsIn(raw.location ?? '')) {
    addLink(
      isVideoConferenceURL(url) ? 'video' : 'location',
      isVideoConferenceURL(url) ? 'Video meeting' : 'Location link',
      url,
    );
  }
  for (const url of urlsIn(raw.description ?? '')) addLink('description', 'Event link', url);

  return {
    eventId: raw.id,
    iCalUID: raw.iCalUID,
    recurringEventId: raw.recurringEventId,
    // Which calendar this came from — without it a merged list can't say
    // whether something is on the work calendar or the family one.
    calendar: calendar.name,
    calendarId: calendar.id,
    summary: raw.summary ?? '',
    location: raw.location ?? '',
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    organizer: raw.organizer?.email
      ? raw.organizer.displayName
        ? `${raw.organizer.displayName} <${raw.organizer.email}>`
        : raw.organizer.email
      : '',
    allDay: Boolean(raw.start?.date && !raw.start.dateTime),
    attendees: (raw.attendees ?? []).map((a) => `${a.email} (${a.responseStatus ?? '?'})`),
    links,
  };
}

/**
 * Read across several calendars at once and merge the results into one
 * chronological list.
 *
 * A single calendar failing (revoked share, transient 5xx) must not blank the
 * whole answer, so failures are collected per calendar and returned alongside
 * the events rather than thrown — the caller can then say what it did and
 * didn't see instead of silently under-reporting.
 */
async function collectEvents(
  deps: CalendarToolDeps,
  opts: {
    calendarIds?: string[];
    maxResults: number;
    query: (calendarId: string) => string;
  },
) {
  const available = await fetchCalendars(deps.client);
  const requested = opts.calendarIds?.length
    ? available.filter(
        (c) => opts.calendarIds?.includes(c.id) || opts.calendarIds?.includes(c.name),
      )
    : available;
  if (requested.length === 0) {
    throw new Error(
      opts.calendarIds?.length
        ? 'none of the requested calendars are readable by the assistant'
        : 'the assistant account returned no readable calendars',
    );
  }
  const targets = requested.slice(0, MAX_CALENDAR_FANOUT);

  const settled = await Promise.allSettled(
    targets.map(async (calendar) => {
      const res = await deps.client.api<{
        items?: RawEvent[];
        nextPageToken?: string;
      }>(opts.query(calendar.id));
      return {
        events: (res.items ?? []).map((raw) => normalizeEvent(raw, calendar)),
        truncated: Boolean(res.nextPageToken),
      };
    }),
  );

  const events: ReturnType<typeof normalizeEvent>[] = [];
  const unavailable: Array<{ calendar: string; reason: string }> = [];
  const truncatedCalendars: string[] = [];
  settled.forEach((result, index) => {
    const calendar = targets[index];
    if (!calendar) return;
    if (result.status === 'fulfilled') {
      events.push(...result.value.events);
      if (result.value.truncated) truncatedCalendars.push(calendar.name);
    } else
      unavailable.push({
        calendar: calendar.name,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
  });
  events.sort((a, b) => startedAt(a) - startedAt(b));
  const mergedTruncated = events.length > opts.maxResults;
  const notes: string[] = [];
  if (truncatedCalendars.length > 0) {
    notes.push(`Google reported additional matching events on: ${truncatedCalendars.join(', ')}.`);
  }
  if (mergedTruncated) {
    notes.push(`Returned the first ${opts.maxResults} events after merging all calendar results.`);
  }
  if (requested.length > targets.length) {
    notes.push(`Searched the first ${targets.length} of ${requested.length} calendars.`);
  }

  return {
    events: events.slice(0, opts.maxResults),
    calendarsSearched: targets.map((c) => c.name),
    complete:
      unavailable.length === 0 &&
      requested.length === targets.length &&
      truncatedCalendars.length === 0 &&
      !mergedTruncated,
    ...(unavailable.length > 0 ? { unavailable } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/**
 * The calendar read for NON-tool callers — the daily briefing's code job
 * composes from structured inputs and holds no tools, so it reaches the same
 * fan-out and merge through here. Only the client is used, hence the bare
 * deps. The result carries event content verbatim from Google; callers treat
 * it as data, never instructions.
 */
/**
 * Refuse an "owner only" write whose event turns out to have attendees.
 *
 * This is the enforcement half of the `ownerOnly` argument: the declared flag
 * buys the autonomous tier, and this fetch is what makes the claim true. It
 * throws rather than silently downgrading to an approval, because by the time
 * execute runs the risk decision is already made — failing loudly is the only
 * honest outcome, and it tells the model exactly how to retry.
 */
async function assertNoAttendees(
  deps: CalendarToolDeps,
  eventId: string,
  action: 'update' | 'cancel',
): Promise<void> {
  const event = await deps.client.api<{ attendees?: Array<{ email: string }> }>(
    `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
  const attendees = event.attendees ?? [];
  if (attendees.length > 0) {
    throw new Error(
      `Cannot ${action} event ${eventId} as owner-only: it has ${attendees.length} attendee(s) ` +
        `who would be notified. Retry without ownerOnly so the owner can approve it.`,
    );
  }
}

export async function listEventsInWindow(
  client: GoogleClient,
  opts: { timeMin: Date; timeMax: Date; maxResults?: number },
) {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 20, 1), 50);
  return collectEvents(
    { client, botEmail: '', ownerEmail: '' },
    {
      maxResults,
      query: (calendarId) => {
        const params = new URLSearchParams({
          timeMin: opts.timeMin.toISOString(),
          timeMax: opts.timeMax.toISOString(),
          maxResults: String(maxResults),
          singleEvents: 'true',
          orderBy: 'startTime',
        });
        return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      },
    },
  );
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
        'Check when the owner is free or busy. Covers every calendar shared with the assistant, plus its own. Times are ISO 8601 with offset.',
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 300,
      execute: async (args) => {
        // Ask about every calendar this account can see, not just the bot's own
        // and the owner's address: a busy block on a shared "Work" calendar is
        // exactly as blocking as one on the owner's primary.
        let calendarRosterComplete = true;
        const available = await fetchCalendars(deps.client).catch(() => {
          calendarRosterComplete = false;
          return [] as CalendarEntry[];
        });
        const ids = new Set<string>([deps.botEmail, deps.ownerEmail]);
        for (const calendar of available) ids.add(calendar.id);
        const items = [...ids].slice(0, MAX_FREEBUSY_ITEMS).map((id) => ({ id }));
        const nameFor = new Map(available.map((c) => [c.id, c.name]));

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
            items,
          }),
        });

        const calendars = res.calendars ?? {};
        const busy: Array<{ start: string; end: string; calendar: string }> = [];
        const unavailable: string[] = [];
        for (const { id } of items) {
          const entry = calendars[id];
          const label = nameFor.get(id) ?? id;
          if (!entry || (Array.isArray(entry.errors) && entry.errors.length > 0)) {
            unavailable.push(label);
            continue;
          }
          for (const slot of entry.busy ?? []) busy.push({ ...slot, calendar: label });
        }
        busy.sort((a, b) => startedAt(a) - startedAt(b));

        const complete =
          calendarRosterComplete && ids.size === items.length && unavailable.length === 0;
        const coverageNotes: string[] = [];
        if (!calendarRosterComplete) {
          coverageNotes.push('The readable calendar list could not be loaded.');
        }
        if (ids.size > items.length) {
          coverageNotes.push(`Checked the first ${items.length} of ${ids.size} calendars.`);
        }
        if (unavailable.length > 0) {
          coverageNotes.push('Some calendars did not return free/busy data.');
        }

        return {
          busy,
          calendarsChecked: items.map(({ id }) => nameFor.get(id) ?? id),
          complete,
          ...(unavailable.length > 0 ? { unavailable } : {}),
          ...(coverageNotes.length > 0 ? { note: coverageNotes.join(' ') } : {}),
        };
      },
    },
    // Free/busy is time ranges and owner-chosen calendar labels — no
    // third-party-authored prose — so checking availability does not taint the
    // session the way reading event bodies (external invites) does.
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'calendar.list_calendars',
      description:
        'List every calendar the assistant can read — its own and any shared with it. Use this to find out which calendars exist before reading a specific one.',
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 300,
      execute: async () => {
        const calendars = await fetchCalendars(deps.client);
        return {
          calendars: calendars.map((c) => ({
            id: c.id,
            name: c.name,
            primary: c.primary,
            // reader = shared read-only; owner/writer = the bot can edit it.
            access: c.accessRole,
          })),
        };
      },
    },
    // The roster of calendars the owner subscribed to is owner-curated
    // metadata, not third-party content; listing it must not strip the owner
    // card mid-task.
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'calendar.list_events',
      description:
        'List events in a time range across every calendar the assistant can read: its own plus all shared calendars. This is the default for "what is happening Monday" and "what\'s on my calendar". Do not ask which calendar or provider; omit calendarIds to read them all. Results include literal organizer, attendee, location, and event/meeting links when Google returned them, plus whether coverage was complete.',
      inputSchema: z.object({
        timeMin: z.string().datetime({ offset: true }),
        timeMax: z.string().datetime({ offset: true }),
        maxResults: z.number().int().min(1).max(50).default(20),
        /** Names or ids from calendar.list_calendars. Omit to read every one. */
        calendarIds: z.array(z.string().min(1).max(200)).max(25).optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) =>
        collectEvents(deps, {
          calendarIds: args.calendarIds,
          maxResults: args.maxResults,
          query: (calendarId) => {
            const params = new URLSearchParams({
              timeMin: args.timeMin,
              timeMax: args.timeMax,
              // Fetch a full page per calendar; the merged list is trimmed to
              // maxResults after sorting, so a busy calendar can't crowd out an
              // earlier event on a quieter one.
              maxResults: String(args.maxResults),
              singleEvents: 'true',
              orderBy: 'startTime',
            });
            return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
          },
        }),
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
        return {
          eventId: event.id,
          link: event.htmlLink,
          invited: args.attendees,
        };
      },
    },
    {
      outwardFacing: true,
      /**
       * An event with NO attendees is written to the owner's own calendar and
       * nothing else happens: no invitation is addressed, no third party is told,
       * nothing leaves the account. That makes it owner-visible in exactly the
       * sense `owner.notify` is — the same reasoning, applied to the calendar
       * instead of the dashboard — so it stays autonomous when untrusted content
       * is in the session. The moment there is an attendee, `sendUpdates=all`
       * mails them, and the call is gated like any other outward action.
       *
       * This is a deliberate, narrow widening of the anticipation-layer rule
       * that untrusted content may inform the owner but never author an outward
       * action (docs/anticipation-layer.md): it lets forwarded mail put a date on
       * the owner's calendar without an approval tap. It is confined to this one
       * argument shape on purpose — extending it to anything with a third-party
       * sink would be a redesign, not an increment.
       *
       * `outwardFacing` stays set: it is what keeps the tool out of an untrusted
       * sender's registry entirely, which is a separate protection from this one.
       */
      ownerVisibleOnly: (args) =>
        ((args as z.infer<typeof createSchema>).attendees?.length ?? 0) === 0,
    },
  );

  register(
    registry,
    {
      name: 'calendar.search_events',
      description:
        'Search by keyword (attendee, title, location, or description) across every calendar the assistant can read: its own plus all shared calendars. Do not ask which calendar or provider; omit calendarIds to search them all. Results include literal organizer, attendee, location, and event/meeting links when Google returned them, plus calendar identity, coverage, and ISO 8601 times.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
        /** Names or ids from calendar.list_calendars. Omit to search every one. */
        calendarIds: z.array(z.string().min(1).max(200)).max(25).optional(),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) =>
        collectEvents(deps, {
          calendarIds: args.calendarIds,
          maxResults: args.maxResults,
          query: (calendarId) => {
            const params = new URLSearchParams({
              q: args.query,
              maxResults: String(args.maxResults),
              singleEvents: 'true',
              orderBy: 'startTime',
            });
            if (args.timeMin) params.set('timeMin', args.timeMin);
            if (args.timeMax) params.set('timeMax', args.timeMax);
            return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
          },
        }),
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
      /**
       * "This event is mine alone — nobody gets mailed about the change."
       *
       * The claim, not the check. `risk` is synchronous and sees only these
       * args, never the stored event, so a caller could assert this about an
       * event that does in fact have attendees. Execute therefore fetches the
       * event and refuses outright when it finds any — the assertion buys the
       * autonomous tier, the fetch is what makes it true.
       */
      ownerOnly: z.boolean().optional(),
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
      /**
       * Approval by default, because the risk callback sees only the new args
       * and not whether the EXISTING event has attendees who would be mailed
       * about a reschedule — a dynamic tier alone would under-gate that.
       *
       * `ownerOnly: true` is the caller stating there are none, which earns the
       * autonomous tier here and is then *verified* against the stored event in
       * execute. Adding an attendee in the same call contradicts the claim
       * outright, so that combination stays gated no matter what was asserted.
       * Editing an appointment on one's own calendar is reversible and reaches
       * nobody — the same reasoning `create_event` already applies below.
       */
      risk: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        return a.ownerOnly === true && (a.addAttendees?.length ?? 0) === 0
          ? 'autonomous'
          : 'approval';
      },
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
        // Verify the owner-only claim before acting on it. An event with
        // attendees would mail every one of them about the change, which is
        // exactly the outward action the autonomous tier must not cover — so a
        // wrong claim fails loudly rather than quietly notifying people.
        if (args.ownerOnly) await assertNoAttendees(deps, args.eventId, 'update');
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
        const updated = await deps.client.api<{
          id: string;
          htmlLink?: string;
        }>(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=${
            args.ownerOnly ? 'none' : 'all'
          }`,
          {
            method: 'PATCH',
            body: JSON.stringify(patch),
          },
        );
        return { eventId: updated.id, link: updated.htmlLink, updated: true };
      },
    },
    {
      outwardFacing: true,
      /**
       * Same reasoning as `create_event`'s flag below, applied to an edit: an
       * owner-only change mails nobody, so it stays autonomous when untrusted
       * content is in the session. `ownerVisibleOnlyFor` fails closed on an
       * argument shape it cannot read, and execute still verifies the claim
       * against the stored event, so a false assertion cannot slip a
       * third-party notification through this gate.
       */
      ownerVisibleOnly: (args) => {
        const a = args as z.infer<typeof updateSchema>;
        return a.ownerOnly === true && (a.addAttendees?.length ?? 0) === 0;
      },
    },
  );

  register(
    registry,
    {
      name: 'calendar.cancel_event',
      description:
        "Cancel an event on the assistant's calendar. If it has attendees they are notified — hence approval. Set ownerOnly=true for an event with no attendees (a private appointment); the call is refused if the event turns out to have any.",
      inputSchema: z.object({
        eventId: z.string().min(3).max(200),
        /** See `updateSchema.ownerOnly`: the claim, verified in execute. */
        ownerOnly: z.boolean().optional(),
      }),
      /**
       * Approval by default: cancelling an event with attendees mails all of
       * them. `ownerOnly: true` claims there are none, which is verified
       * against the stored event before anything is deleted — the async check
       * the original "revisit if it gets annoying" note was waiting for, done
       * in execute because the risk callback cannot await.
       */
      risk: (args) =>
        (args as { ownerOnly?: boolean }).ownerOnly === true ? 'autonomous' : 'approval',
      acceptsUntrustedInput: false,
      approvalSummary: (args) => `Cancel calendar event ${(args as { eventId: string }).eventId}`,
      execute: async (args) => {
        if (args.ownerOnly) await assertNoAttendees(deps, args.eventId, 'cancel');
        await deps.client.api(
          `${CAL}/calendars/primary/events/${encodeURIComponent(args.eventId)}?sendUpdates=${
            args.ownerOnly ? 'none' : 'all'
          }`,
          { method: 'DELETE' },
        );
        return { cancelled: args.eventId };
      },
    },
    {
      outwardFacing: true,
      /** See `update_event`: verified in execute, so the claim cannot lie. */
      ownerVisibleOnly: (args) => (args as { ownerOnly?: boolean }).ownerOnly === true,
    },
  );

  return registry;
}
