import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerCalendarTools } from './calendar.js';
import type { GoogleClient } from './client.js';

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerCalendarTools(registry, {
    client: { api } as unknown as GoogleClient,
    botEmail: 'bot@example.com',
    ownerEmail: 'owner@example.com',
  });
  return registry;
}

const CALENDARS = [
  {
    id: 'bot@example.com',
    summary: 'Assistant',
    primary: true,
    accessRole: 'owner',
  },
  { id: 'owner@example.com', summary: 'Baldvin', accessRole: 'reader' },
  { id: 'work@example.com', summary: 'Work', accessRole: 'reader' },
];

function calendarIdIn(url: string): string {
  return decodeURIComponent(/calendars\/([^/]+)\/events/.exec(url)?.[1] ?? '');
}

/**
 * Mocks the calendarList lookup every read now makes, then serves events per
 * calendar. `events` maps a calendar id to its items; a calendar mapped to an
 * Error rejects, standing in for a revoked share.
 */
function apiFor(events: Record<string, unknown[] | Error>, calendars = CALENDARS) {
  return vi.fn(async (url: string) => {
    if (url.includes('/users/me/calendarList')) return { items: calendars };
    const id = calendarIdIn(url);
    const entry = events[id];
    if (entry instanceof Error) throw entry;
    return { items: entry ?? [] };
  });
}

function event(id: string, summary: string, start: string) {
  return { id, summary, start: { dateTime: start }, end: { dateTime: start } };
}

describe('calendar.list_events', () => {
  it('reads every shared calendar and merges them in chronological order', async () => {
    const api = apiFor({
      'bot@example.com': [event('b1', 'Bot task', '2026-07-24T15:00:00Z')],
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': [event('w1', 'Standup', '2026-07-24T12:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string; summary: string; calendar: string }>;
      calendarsSearched: string[];
    };

    // The owner's 09:00 sorts ahead of the bot's own 15:00 — a merged list has
    // to interleave calendars, not concatenate them.
    expect(result.events.map((e) => e.eventId)).toEqual(['o1', 'w1', 'b1']);
    expect(result.events.map((e) => e.calendar)).toEqual(['Baldvin', 'Work', 'Assistant']);
    expect(result.calendarsSearched).toEqual(['Assistant', 'Baldvin', 'Work']);
    expect(result).toMatchObject({ complete: true });
  });

  it('addresses each calendar by id rather than the hardcoded primary', async () => {
    const api = apiFor({});
    await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      );
    const requested = api.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/events'))
      .map(calendarIdIn);
    expect(requested).toEqual(['bot@example.com', 'owner@example.com', 'work@example.com']);
    expect(requested).not.toContain('primary');
  });

  it('still answers when one calendar fails, and names the one it could not read', async () => {
    const api = apiFor({
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': new Error('Google API 403 on work: forbidden'),
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
        },
        {} as never,
      )) as {
      events: Array<{ eventId: string }>;
      unavailable?: Array<{ calendar: string; reason: string }>;
    };
    expect(result.events.map((e) => e.eventId)).toEqual(['o1']);
    expect(result.unavailable).toEqual([
      { calendar: 'Work', reason: 'Google API 403 on work: forbidden' },
    ]);
    expect(result).toMatchObject({ complete: false });
  });

  it('fails instead of treating an empty calendar roster as an empty schedule', async () => {
    await expect(
      toolsWith(apiFor({}, []))
        .get('calendar.list_events')
        ?.tool.execute(
          {
            timeMin: '2026-08-17T00:00:00-07:00',
            timeMax: '2026-08-18T00:00:00-07:00',
          },
          {} as never,
        ),
    ).rejects.toThrow(/no readable calendars/i);
  });

  it('narrows to named calendars when asked, by name or by id', async () => {
    const api = apiFor({
      'owner@example.com': [event('o1', 'Dentist', '2026-07-24T09:00:00Z')],
      'work@example.com': [event('w1', 'Standup', '2026-07-24T12:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 20,
          calendarIds: ['Work'],
        },
        {} as never,
      )) as { events: Array<{ eventId: string }>; calendarsSearched: string[] };
    expect(result.calendarsSearched).toEqual(['Work']);
    expect(result.events.map((e) => e.eventId)).toEqual(['w1']);
  });

  it('trims the merged list to maxResults after sorting, not per calendar', async () => {
    const api = apiFor({
      'bot@example.com': [event('b1', 'Late', '2026-07-24T23:00:00Z')],
      'owner@example.com': [event('o1', 'Early', '2026-07-24T01:00:00Z')],
    });
    const result = (await toolsWith(api)
      .get('calendar.list_events')
      ?.tool.execute(
        {
          timeMin: '2026-07-24T00:00:00Z',
          timeMax: '2026-07-25T00:00:00Z',
          maxResults: 1,
        },
        {} as never,
      )) as { events: Array<{ eventId: string }>; complete: boolean };
    expect(result.events.map((e) => e.eventId)).toEqual(['o1']);
    expect(result.complete).toBe(false);
  });

  it('marks coverage partial when Google has another page of events', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) {
        return { items: [CALENDARS[0]] };
      }
      return {
        items: [event('b1', 'First match', '2026-07-24T09:00:00Z')],
        nextPageToken: 'another-page',
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Clay', maxResults: 20 }, {} as never)) as {
      complete: boolean;
      note?: string;
    };

    expect(result.complete).toBe(false);
    expect(result.note).toMatch(/additional matching events/i);
  });

  it('reads as confidential untrusted content and stays autonomous', () => {
    const entry = toolsWith(vi.fn()).get('calendar.list_events');
    expect(entry?.tool.risk).toBe('autonomous');
    expect(entry?.flags).toMatchObject({
      confidentialRead: true,
      returnsUntrustedContent: true,
    });
  });
});

describe('calendar.list_calendars', () => {
  it('lists the shared calendars with the access the assistant has', async () => {
    const result = (await toolsWith(apiFor({}))
      .get('calendar.list_calendars')
      ?.tool.execute({}, {} as never)) as {
      calendars: Array<{
        id: string;
        name: string;
        primary: boolean;
        access: string;
      }>;
    };
    expect(result.calendars).toEqual([
      {
        id: 'bot@example.com',
        name: 'Assistant',
        primary: true,
        access: 'owner',
      },
      {
        id: 'owner@example.com',
        name: 'Baldvin',
        primary: false,
        access: 'reader',
      },
      {
        id: 'work@example.com',
        name: 'Work',
        primary: false,
        access: 'reader',
      },
    ]);
  });

  it('prefers the local name the owner gave a shared calendar', async () => {
    const api = apiFor({}, [
      {
        id: 'work@example.com',
        summary: 'work@example.com',
        accessRole: 'reader',
      },
    ]);
    // summaryOverride is what the owner renamed it to in their own UI.
    (api as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async () => ({
        items: [
          {
            id: 'work@example.com',
            summary: 'work@example.com',
            summaryOverride: 'Day job',
            accessRole: 'reader',
          },
        ],
      }),
    );
    const result = (await toolsWith(api)
      .get('calendar.list_calendars')
      ?.tool.execute({}, {} as never)) as {
      calendars: Array<{ name: string }>;
    };
    expect(result.calendars[0]?.name).toBe('Day job');
  });
});

describe('calendar.search_events', () => {
  it('searches every shared calendar and normalizes results', async () => {
    const api = apiFor({
      'owner@example.com': [
        {
          id: 'evt-1',
          summary: 'Lunch with Sam',
          location: 'Cafe',
          description: 'Join at https://meet.example.com/sam-room.',
          htmlLink: 'https://calendar.google.com/event?eid=evt-1',
          organizer: { email: 'sam@example.com', displayName: 'Sam' },
          start: { dateTime: '2026-07-24T12:00:00-07:00' },
          end: { dateTime: '2026-07-24T13:00:00-07:00' },
          attendees: [{ email: 'sam@example.com', responseStatus: 'accepted' }],
        },
      ],
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Sam', maxResults: 20 }, {} as never)) as {
      events: Array<{
        eventId: string;
        attendees: string[];
        calendar: string;
        organizer: string;
        links: Array<{ url: string }>;
      }>;
    };
    expect(result.events[0]?.eventId).toBe('evt-1');
    expect(result.events[0]?.attendees).toEqual(['sam@example.com (accepted)']);
    expect(result.events[0]?.calendar).toBe('Baldvin');
    expect(result.events[0]?.organizer).toBe('Sam <sam@example.com>');
    expect(result.events[0]?.links.map((link) => link.url)).toEqual([
      'https://calendar.google.com/event?eid=evt-1',
      'https://meet.example.com/sam-room',
    ]);

    const eventUrls = api.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('/events'));
    expect(eventUrls).toHaveLength(3); // one per shared calendar
    for (const url of eventUrls) {
      expect(url).toContain('q=Sam');
      expect(url).toContain('singleEvents=true');
    }
  });

  it('reads as confidential untrusted content and stays autonomous', () => {
    const entry = toolsWith(vi.fn()).get('calendar.search_events');
    expect(entry?.tool.risk).toBe('autonomous');
    expect(entry?.flags).toMatchObject({
      confidentialRead: true,
      returnsUntrustedContent: true,
    });
  });
});

describe('calendar.availability', () => {
  it('asks free/busy about every shared calendar, not just the bot and owner', async () => {
    // Typed with the init argument so the POST body can be asserted on.
    const api = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': {
            busy: [{ start: '2026-07-24T09:00:00Z', end: '2026-07-24T10:00:00Z' }],
          },
          'work@example.com': {
            busy: [{ start: '2026-07-24T08:00:00Z', end: '2026-07-24T08:30:00Z' }],
          },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as {
      busy: Array<{ calendar: string; start: string }>;
      calendarsChecked: string[];
    };

    const freeBusyCall = api.mock.calls.find(([url]) => String(url).includes('/freeBusy'));
    expect(freeBusyCall).toBeDefined();
    const body = JSON.parse(String((freeBusyCall?.[1] as RequestInit | undefined)?.body));
    expect(body.items).toEqual([
      { id: 'bot@example.com' },
      { id: 'owner@example.com' },
      { id: 'work@example.com' },
    ]);
    // Merged and sorted, each block labelled with the calendar it came from.
    expect(result.busy.map((b) => b.calendar)).toEqual(['Work', 'Baldvin']);
    expect(result.calendarsChecked).toContain('Work');
    expect(result).toMatchObject({ complete: true });
  });

  it('names calendars that have not shared free/busy instead of reporting them free', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { errors: [{ reason: 'notFound' }] },
          'work@example.com': { busy: [] },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; unavailable?: string[] };
    expect(result.unavailable).toEqual(['Baldvin']);
    expect(result.complete).toBe(false);
  });

  it('treats an omitted free/busy calendar response as unavailable, not free', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) return { items: CALENDARS };
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { busy: [] },
          // Google omitted work@example.com entirely.
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; unavailable?: string[] };
    expect(result).toMatchObject({ complete: false, unavailable: ['Work'] });
  });

  it('does not claim complete coverage when the shared-calendar roster fails', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/users/me/calendarList')) throw new Error('calendar list unavailable');
      return {
        calendars: {
          'bot@example.com': { busy: [] },
          'owner@example.com': { busy: [] },
        },
      };
    });
    const result = (await toolsWith(api)
      .get('calendar.availability')
      ?.tool.execute(
        { timeMin: '2026-07-24T00:00:00Z', timeMax: '2026-07-25T00:00:00Z' },
        {} as never,
      )) as { complete: boolean; note?: string };
    expect(result.complete).toBe(false);
    expect(result.note).toMatch(/calendar list could not be loaded/i);
  });
});

describe('calendar.update_event', () => {
  it('always needs approval and summarizes the change', () => {
    const entry = toolsWith(vi.fn()).get('calendar.update_event');
    expect(entry?.tool.risk).toBe('approval');
    expect(entry?.flags).toMatchObject({ outwardFacing: true });
    const summary = entry?.tool.approvalSummary?.({
      eventId: 'evt-1',
      start: '2026-07-24T16:00:00-07:00',
    });
    expect(summary).toContain('evt-1');
    expect(summary).toContain('move to');
  });

  it('PATCHes only the changed fields and merges added attendees onto existing ones', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ attendees: [{ email: 'existing@example.com' }] }) // GET existing
      .mockResolvedValueOnce({
        id: 'evt-1',
        htmlLink: 'https://cal.example/evt-1',
      }); // PATCH
    await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        {
          eventId: 'evt-1',
          start: '2026-07-24T16:00:00-07:00',
          addAttendees: ['new@example.com'],
        },
        {} as never,
      );
    const [patchUrl, patchInit] = api.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toContain('/events/evt-1');
    expect(patchUrl).toContain('sendUpdates=all');
    const body = JSON.parse(String(patchInit.body));
    expect(body.start).toEqual({ dateTime: '2026-07-24T16:00:00-07:00' });
    expect(body.summary).toBeUndefined(); // untouched fields aren't sent
    expect(body.attendees).toEqual([
      { email: 'existing@example.com' },
      { email: 'new@example.com' },
    ]);
  });

  it('rejects an update with no fields to change', () => {
    const schema = toolsWith(vi.fn()).get('calendar.update_event')?.tool.inputSchema;
    expect(schema?.safeParse({ eventId: 'evt-1' }).success).toBe(false);
  });
});
