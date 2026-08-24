import { describe, expect, it } from 'vitest';
import { calendarResponseCards, weatherResponseCards } from './response-cards.js';

const request = {
  kind: 'calendar' as const,
  timeZone: 'America/Los_Angeles',
  queryTerms: [],
  firstToolName: 'calendar.list_events' as const,
  requiresThreadRead: false,
};

describe('response cards', () => {
  it('merges obvious cross-calendar twins but keeps distinct appointments', () => {
    const result = calendarResponseCards(
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: {
            events: [
              {
                eventId: 'family',
                calendarId: 'family',
                calendar: 'Family',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'work',
                calendarId: 'work',
                calendar: 'Work',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'soccer',
                calendarId: 'family',
                calendar: 'Family',
                summary: 'Soccer',
                location: 'PayPal Park',
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
            ],
          },
        },
      ],
      request,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.calendars).toEqual(['Family', 'Work']);
  });

  it('turns the fresh ambient weather block into a compact card', () => {
    expect(
      weatherResponseCards(
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h, humidity 70%).",
      ),
    ).toMatchObject([
      {
        kind: 'weather',
        location: 'San Francisco',
        temperature: '18°C',
        details: [
          { label: 'Today', value: '17–19°C' },
          { label: 'Wind', value: '18 km/h' },
          { label: 'Humidity', value: '70%' },
          { label: 'Rain chance', value: '2%' },
        ],
      },
    ]);
  });
});
