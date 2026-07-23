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

describe('calendar.search_events', () => {
  it('searches the bot calendar by query and normalizes results', async () => {
    const api = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'evt-1',
          summary: 'Lunch with Sam',
          location: 'Cafe',
          start: { dateTime: '2026-07-24T12:00:00-07:00' },
          end: { dateTime: '2026-07-24T13:00:00-07:00' },
          attendees: [{ email: 'sam@example.com', responseStatus: 'accepted' }],
        },
      ],
    });
    const result = (await toolsWith(api)
      .get('calendar.search_events')
      ?.tool.execute({ query: 'Sam', maxResults: 20 }, {} as never)) as {
      events: Array<{ eventId: string; attendees: string[] }>;
    };
    expect(result.events[0]?.eventId).toBe('evt-1');
    expect(result.events[0]?.attendees).toEqual(['sam@example.com (accepted)']);
    const [url] = api.mock.calls[0] as [string];
    expect(url).toContain('q=Sam');
    expect(url).toContain('singleEvents=true');
  });

  it('reads as confidential untrusted content and stays autonomous', () => {
    const entry = toolsWith(vi.fn()).get('calendar.search_events');
    expect(entry?.tool.risk).toBe('autonomous');
    expect(entry?.flags).toMatchObject({ confidentialRead: true, returnsUntrustedContent: true });
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
      .mockResolvedValueOnce({ id: 'evt-1', htmlLink: 'https://cal.example/evt-1' }); // PATCH
    await toolsWith(api)
      .get('calendar.update_event')
      ?.tool.execute(
        { eventId: 'evt-1', start: '2026-07-24T16:00:00-07:00', addAttendees: ['new@example.com'] },
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
