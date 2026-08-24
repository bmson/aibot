import type { PersonalReadRequest } from './read-intent.js';
import type { ActionEvidence } from './response-contract.js';

type RecordValue = Record<string, unknown>;

export interface ResponseCard {
  kind: 'calendar-event' | 'weather' | 'status';
  id: string;
  [key: string]: unknown;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:calendar|copy|duplicate)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function overlaps(a: RecordValue, b: RecordValue): boolean {
  const aStart = Date.parse(string(a.start));
  const aEnd = Date.parse(string(a.end));
  const bStart = Date.parse(string(b.start));
  const bEnd = Date.parse(string(b.end));
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return string(a.start) === string(b.start);
  return aStart < bEnd && bStart < aEnd;
}

function sameEvent(a: RecordValue, b: RecordValue): boolean {
  const title = normalizedTitle(string(a.summary));
  if (!title || title !== normalizedTitle(string(b.summary)) || !overlaps(a, b)) return false;
  const aLocation = string(a.location).toLowerCase();
  const bLocation = string(b.location).toLowerCase();
  return !aLocation || !bLocation || aLocation === bLocation;
}

function formatTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** Build UI data solely from successful calendar tool results; model prose is not an input. */
export function calendarResponseCards(
  evidence: ActionEvidence[],
  request?: PersonalReadRequest | null,
): ResponseCard[] {
  if (request?.kind !== 'calendar' && request?.kind !== 'calendar_email') return [];
  const events = evidence.flatMap((row) => {
    if (row.status !== 'succeeded' || !/^calendar\.(?:list_events|search_events)$/.test(row.toolName)) return [];
    const result = record(row.result);
    return Array.isArray(result?.events) ? result.events.map(record).filter((event): event is RecordValue => !!event) : [];
  });
  const groups: RecordValue[][] = [];
  for (const event of events) {
    const group = groups.find((candidate) => sameEvent(candidate[0]!, event));
    if (group) group.push(event);
    else groups.push([event]);
  }
  return groups
    .map((group) => {
      const event = group[0]!;
      const start = string(event.start);
      const end = string(event.end);
      const links = Array.isArray(event.links) ? event.links.map(record).filter(Boolean) : [];
      const bestLink = links.find((link) => string(link?.type) === 'video') ?? links[0];
      const calendars = [...new Set(group.map((entry) => string(entry.calendar)).filter(Boolean))];
      return {
        kind: 'calendar-event' as const,
        id: `calendar-${group.map((entry) => string(entry.calendarId) + ':' + string(entry.eventId)).join('|')}`,
        title: string(event.summary) || 'Untitled event',
        start,
        end,
        time: [formatTime(start, request?.timeZone), end ? formatTime(end, request?.timeZone) : ''].filter(Boolean).join('–'),
        location: string(event.location),
        attendees: Array.isArray(event.attendees) ? event.attendees.filter((value): value is string => typeof value === 'string').slice(0, 3) : [],
        calendars,
        link: bestLink ? { label: string(bestLink.label) || 'Open event', url: string(bestLink.url) } : undefined,
      };
    })
    .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)));
}

/** Ambient data is already trusted context, but only a tiny literal subset becomes a card. */
export function weatherResponseCards(ambient?: string): ResponseCard[] {
  if (!ambient) return [];
  const weather = /Weather there:\s*([^,]+),\s*(-?\d+)°C\s*\(today\s*(-?\d+)–(-?\d+)°C,\s*(\d+)% chance of rain, wind\s*(\d+) km\/h\)/i.exec(ambient);
  if (!weather) return [];
  const [, condition = '', temperature = '', low = '', high = '', rain = '', wind = ''] = weather;
  const location = /Owner's current location:\s*(?:near\s+)?([^,(\n.]+)/i.exec(ambient)?.[1]?.trim() || 'Right now';
  return [{
    kind: 'weather', id: `weather-${temperature}-${condition.toLowerCase()}`,
    location, condition, temperature: `${temperature}°C`, low: `${low}°C`, high: `${high}°C`,
    detail: `${rain}% rain chance · ${wind} km/h wind`,
  }];
}

export function responseCardsForFinal(input: {
  evidence: ActionEvidence[];
  readRequest?: PersonalReadRequest | null;
  ambient?: string;
  requestText?: string;
}): ResponseCard[] {
  const calendar = calendarResponseCards(input.evidence, input.readRequest);
  if (calendar.length > 0) return calendar;
  // Ambient weather is useful for a conversational/weather answer, but must
  // never appear as an unrelated second result below an empty calendar lookup.
  return input.readRequest || !/\b(?:weather|forecast|temperature|rain)\b/i.test(input.requestText ?? '')
    ? []
    : weatherResponseCards(input.ambient);
}
