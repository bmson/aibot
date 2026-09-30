import { describe, expect, it } from 'vitest';
import {
  explicitWriteInstants,
  groundWorkspaceWrite,
  writeGroundingCorpus,
} from './write-grounding.js';

const createdAt = new Date('2026-01-01T12:00:00.000Z');
const flightRequest =
  'Put my United flight from SFO to BER on my calendar. It leaves Oct 9 at 9:15 AM PDT; arrival is 5:15 AM CEST on Oct 11.';

describe('workspace write grounding', () => {
  it('pairs each flight clock with its nearest date instead of a later leg date', () => {
    const parsed = explicitWriteInstants(
      '9:15 AM PDT on Oct 9, 2026; 5:15 AM CEST on Oct 11, 2026',
      createdAt,
    ).map((instant) => new Date(instant).toISOString());

    expect(parsed).toEqual(['2026-10-09T16:15:00.000Z', '2026-10-11T03:15:00.000Z']);
  });

  it('grounds split natural-language flight dates and times before calendar dispatch', () => {
    const input = {
      summary: 'United flight SFO to BER',
      start: '2026-10-09T09:15:00-07:00',
      end: '2026-10-11T05:15:00+02:00',
      description: '',
      location: 'SFO to BER',
      attendees: [],
    };

    expect(
      groundWorkspaceWrite('calendar.create_event', input, flightRequest, flightRequest, createdAt),
    ).toEqual({
      allowed: true,
    });
  });

  it('refuses a flight event with an invented return time before it reaches dispatch', () => {
    const input = {
      summary: 'United flight SFO to BER',
      start: '2026-10-09T09:15:00-07:00',
      end: '2026-10-11T13:15:00+02:00',
      description: '',
      location: 'SFO to BER',
      attendees: [],
    };

    expect(
      groundWorkspaceWrite('calendar.create_event', input, flightRequest, flightRequest, createdAt),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('end time'),
    });
  });

  it('fails closed when a flight write has no usable start and end timestamps', () => {
    expect(
      groundWorkspaceWrite(
        'calendar.create_event',
        { summary: 'United flight SFO to BER', start: 'not-a-time' },
        flightRequest,
        flightRequest,
        createdAt,
      ),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('incomplete') });
  });

  it('leaves an ordinary relative-date appointment to the existing date resolver', () => {
    expect(
      groundWorkspaceWrite(
        'calendar.create_event',
        {
          summary: 'Dentist',
          start: '2026-09-30T15:00:00-07:00',
          end: '2026-09-30T16:00:00-07:00',
        },
        'Schedule my dentist tomorrow at 3pm.',
        'Schedule my dentist tomorrow at 3pm.',
        createdAt,
      ),
    ).toEqual({ allowed: true });
  });

  it('allows ordinary owner-authored sheet headings and synthesized summaries', () => {
    const input = {
      title: 'Monthly household budget',
      sheetName: 'Overview',
      rows: [
        ['Category', 'Planned amount', 'Notes'],
        ['Housing', 1800, 'Review at month end'],
      ],
      headerRow: true,
    };
    expect(
      groundWorkspaceWrite(
        'sheets.create',
        input,
        'Create a spreadsheet for my monthly household budget.',
        'Create a spreadsheet for my monthly household budget.',
        createdAt,
      ),
    ).toEqual({ allowed: true });
  });

  it('checks flight identifiers in evidence-derived sheet rows without rejecting headers', () => {
    const ownerText = 'Make a spreadsheet from my flight itinerary.';
    const input = {
      title: 'Flight itinerary',
      sheetName: 'Flights',
      rows: [
        ['Airline', 'Flight', 'From', 'To'],
        ['KLM', 'UA 123', 'SFO', 'BER'],
      ],
      headerRow: true,
    };
    const corpus = `${ownerText} United flight UA 123 from SFO to BER leaves Oct 9, 2026 at 09:15 PDT and arrives Oct 11, 2026 at 05:15 CEST`;
    expect(
      groundWorkspaceWrite('sheets.create', input, ownerText, corpus, createdAt),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('airline'),
    });

    const grounded = {
      ...input,
      rows: [
        ['Airline', 'Flight', 'From', 'To'],
        ['United', 'UA 123', 'SFO', 'BER', 'Oct 9, 2026 09:15 PDT', 'Oct 11, 2026 05:15 CEST'],
      ],
    };
    expect(groundWorkspaceWrite('sheets.create', grounded, ownerText, corpus, createdAt)).toEqual({
      allowed: true,
    });

    const wrongTimes = {
      ...grounded,
      rows: [
        ['Airline', 'Flight', 'From', 'To', 'Departure', 'Arrival'],
        ['United', 'UA 123', 'SFO', 'BER', 'Oct 9, 2026 10:15 PDT', 'Oct 11, 2026 05:15 CEST'],
      ],
    };
    expect(
      groundWorkspaceWrite('sheets.create', wrongTimes, ownerText, corpus, createdAt),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('date or time'),
    });

    const arrivalWithoutDate = {
      ...grounded,
      rows: [
        ['Airline', 'Flight', 'From', 'To', 'Departure', 'Arrival'],
        ['United', 'UA 123', 'SFO', 'BER', 'Oct 9, 2026 09:15 PDT', '05:15 CEST (+2 days)'],
      ],
    };
    expect(
      groundWorkspaceWrite('sheets.create', arrivalWithoutDate, ownerText, corpus, createdAt),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('incomplete or ambiguous'),
    });

    const unitedStatesFooter = `${ownerText} United States routing office; SFO to BER`;
    expect(
      groundWorkspaceWrite(
        'sheets.create',
        {
          title: 'Flight itinerary',
          rows: [
            ['Airline', 'From', 'To'],
            ['United', 'SFO', 'BER'],
          ],
          headerRow: true,
        },
        ownerText,
        unitedStatesFooter,
        createdAt,
      ),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('airline') });
  });

  it('does not treat common itinerary acronyms as airport codes', () => {
    const ownerText = 'Create a sheet for my United flight from SFO to BER.';
    expect(
      groundWorkspaceWrite(
        'sheets.create',
        {
          title: 'Flight itinerary',
          headerRow: true,
          rows: [
            ['Airline', 'From', 'To', 'CEO', 'ETA'],
            ['United', 'SFO', 'BER', 'Passenger', 'TBD'],
          ],
        },
        ownerText,
        ownerText,
        createdAt,
      ),
    ).toEqual({ allowed: true });
  });

  it('builds grounding context from successful reads, excluding failed and assistant prose', () => {
    const window = [
      { role: 'assistant', content: [{ type: 'text', text: 'It is probably a United flight.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'ok', toolName: 'gmail.read_thread', input: {} },
          { type: 'tool-call', toolCallId: 'bad', toolName: 'gmail.read_thread', input: {} },
          {
            type: 'tool-call',
            toolCallId: 'event',
            toolName: 'calendar.create_event',
            input: { summary: 'United flight UA 123 SFO BER' },
          },
          {
            type: 'tool-call',
            toolCallId: 'failed-event',
            toolName: 'calendar.create_event',
            input: { summary: 'Invented flight KL 602' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'ok',
            toolName: 'gmail.read_thread',
            output: { type: 'json', value: { text: 'United UA 123 SFO BER' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'bad',
            toolName: 'gmail.read_thread',
            output: { type: 'json', value: { error: 'not found' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'event',
            toolName: 'calendar.create_event',
            output: { type: 'json', value: { eventId: 'evt-1' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'failed-event',
            toolName: 'calendar.create_event',
            output: { type: 'json', value: { error: 'rejected' } },
          },
        ],
      },
    ];
    const corpus = writeGroundingCorpus(window, 'Create an event from my flight email.');
    expect(corpus).toContain('United UA 123 SFO BER');
    expect(corpus).not.toContain('probably');
    expect(corpus).not.toContain('not found');
    expect(corpus).toContain('United flight UA 123 SFO BER');
    expect(corpus).not.toContain('Invented flight KL 602');
  });

  it('uses a verified calendar write as timing evidence for a later flight sheet in the same task', () => {
    const ownerText = 'Create a spreadsheet of this flight itinerary.';
    const window = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'created-flight',
            toolName: 'calendar.create_event',
            input: {
              summary: 'United flight UA 123 SFO to BER',
              start: '2026-10-09T09:15:00-07:00',
              end: '2026-10-11T05:15:00+02:00',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'created-flight',
            toolName: 'calendar.create_event',
            output: { type: 'json', value: { eventId: 'evt-created' } },
          },
        ],
      },
    ];
    const corpus = writeGroundingCorpus(window, ownerText);
    const rows = {
      title: 'Flight itinerary',
      headerRow: true,
      rows: [
        ['Airline', 'Flight', 'From', 'To', 'Departure', 'Arrival'],
        ['United', 'UA 123', 'SFO', 'BER', 'Oct 9, 2026 09:15 PDT', 'Oct 11, 2026 05:15 CEST'],
      ],
    };
    expect(groundWorkspaceWrite('sheets.create', rows, ownerText, corpus, createdAt)).toEqual({
      allowed: true,
    });
    const wrongTime = {
      ...rows,
      rows: [
        rows.rows[0],
        ['United', 'UA 123', 'SFO', 'BER', 'Oct 9, 2026 10:15 PDT', 'Oct 11, 2026 05:15 CEST'],
      ],
    };
    expect(
      groundWorkspaceWrite('sheets.create', wrongTime, ownerText, corpus, createdAt),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining('date or time') });
  });
});
