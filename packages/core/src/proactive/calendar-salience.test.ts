import { describe, expect, it } from 'vitest';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import {
  describeSalience,
  SALIENCE_THRESHOLD,
  type SalienceContext,
  salientEvents,
  scoreCalendarEvent,
} from './calendar-salience.js';

const ctx: SalienceContext = {
  timeZone: 'Atlantic/Reykjavik',
  selfEmails: ['owner@example.com', 'assistant@example.com'],
};

/** Reykjavik sits at UTC year-round, so these ISO hours are also local hours. */
function event(over: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
  return {
    summary: 'Standup',
    start: '2026-03-04T10:00:00Z',
    end: '2026-03-04T10:30:00Z',
    calendar: 'Work',
    allDay: false,
    ...over,
  };
}

describe('scoreCalendarEvent', () => {
  it('scores an ordinary desk meeting as not worth interrupting for', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (accepted)', 'colleague@example.com (accepted)'] }),
      ctx,
    );
    expect(scored.score).toBeLessThan(SALIENCE_THRESHOLD);
    expect(scored.reasons).toEqual([]);
  });

  it('treats an unanswered invitation as the strongest single signal', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (needsAction)'] }),
      ctx,
    );
    expect(scored.score).toBeGreaterThanOrEqual(SALIENCE_THRESHOLD);
    expect(scored.reasons).toContain('you have not replied to the invitation');
  });

  it('does not read someone else’s pending RSVP as the owner’s', () => {
    const scored = scoreCalendarEvent(
      event({ attendees: ['owner@example.com (accepted)', 'someone@else.com (needsAction)'] }),
      ctx,
    );
    expect(scored.reasons).not.toContain('you have not replied to the invitation');
  });

  it('counts a physical location as travel but a video link as not', () => {
    const physical = scoreCalendarEvent(event({ location: 'Laugavegur 12, Reykjavik' }), ctx);
    expect(physical.reasons.some((r) => r.startsWith('it is at'))).toBe(true);

    const video = scoreCalendarEvent(
      event({ location: 'https://meet.google.com/abc-defg-hij' }),
      ctx,
    );
    expect(video.reasons.some((r) => r.startsWith('it is at'))).toBe(false);
  });

  it('flags events outside the usual hours at either end', () => {
    const early = scoreCalendarEvent(
      event({ start: '2026-03-04T06:00:00Z', end: '2026-03-04T06:30:00Z' }),
      ctx,
    );
    expect(early.reasons).toContain('it falls outside your usual hours');

    const late = scoreCalendarEvent(
      event({ start: '2026-03-04T18:30:00Z', end: '2026-03-04T20:00:00Z' }),
      ctx,
    );
    expect(late.reasons).toContain('it falls outside your usual hours');
  });

  it('recognises an outside organizer but not an in-house one', () => {
    const outside = scoreCalendarEvent(event({ organizer: 'Dr Ling <clinic@hospital.is>' }), ctx);
    expect(outside.reasons).toContain('clinic@hospital.is called it');

    const inside = scoreCalendarEvent(event({ organizer: 'owner@example.com' }), ctx);
    expect(inside.reasons.some((r) => r.endsWith('called it'))).toBe(false);
  });

  it('scores an all-day entry and a crowded meeting', () => {
    expect(scoreCalendarEvent(event({ allDay: true }), ctx).reasons).toContain(
      'it takes the whole day',
    );
    const crowded = scoreCalendarEvent(
      event({
        attendees: [
          'a@x.com (accepted)',
          'b@x.com (accepted)',
          'c@x.com (accepted)',
          'd@x.com (accepted)',
          'e@x.com (accepted)',
        ],
      }),
      ctx,
    );
    expect(crowded.reasons).toContain('5 people are on it');
  });

  it('survives events the provider left half-populated', () => {
    const scored = scoreCalendarEvent(
      { summary: '', start: 'not-a-date', end: '', calendar: '', allDay: false },
      ctx,
    );
    expect(Number.isFinite(scored.score)).toBe(true);
  });
});

describe('salientEvents', () => {
  it('keeps only what clears the bar, most salient first, soonest breaking ties', () => {
    const routine = event({ summary: 'Standup' });
    const flight = event({
      summary: 'Flight to Oslo',
      start: '2026-03-04T05:00:00Z',
      end: '2026-03-04T09:00:00Z',
      location: 'Keflavik Airport',
    });
    const later = event({
      summary: 'Dentist',
      start: '2026-03-04T17:00:00Z',
      end: '2026-03-04T21:00:00Z',
      location: 'Somewhere',
    });
    const earlier = event({
      summary: 'Optician',
      start: '2026-03-04T07:00:00Z',
      end: '2026-03-04T11:00:00Z',
      location: 'Somewhere else',
    });

    const found = salientEvents([routine, later, flight, earlier], ctx);
    expect(found.map((s) => s.event.summary)).not.toContain('Standup');
    // `later` and `earlier` score identically; the earlier one must come first.
    const summaries = found.map((s) => s.event.summary);
    expect(summaries.indexOf('Optician')).toBeLessThan(summaries.indexOf('Dentist'));
  });

  it('renders a line the digest can use verbatim', () => {
    const [scored] = salientEvents(
      [event({ attendees: ['owner@example.com (needsAction)'] })],
      ctx,
    );
    expect(scored).toBeDefined();
    expect(describeSalience(scored as NonNullable<typeof scored>)).toContain('Standup');
  });
});
