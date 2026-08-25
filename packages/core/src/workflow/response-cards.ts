import type { PersonalReadRequest } from './read-intent.js';
import type { ActionEvidence } from './response-contract.js';

type RecordValue = Record<string, unknown>;
type EventGroup = [RecordValue, ...RecordValue[]];

export interface ResponseCard {
  kind:
    | 'calendar-event'
    | 'weather'
    | 'reminder'
    | 'email-results'
    | 'document-results'
    | 'drive-results'
    | 'resource'
    | 'status';
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    : [];
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function succeeded(row: ActionEvidence): boolean {
  return row.status === 'succeeded' && row.fromCurrentTask !== false;
}

function details(
  entries: Array<[string, string | undefined]>,
): Array<{ label: string; value: string }> {
  return entries.flatMap(([label, value]) => (value ? [{ label, value }] : []));
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
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite))
    return string(a.start) === string(b.start);
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

function isVideoMeetingLink(link: RecordValue | undefined): boolean {
  if (string(link?.type) === 'video') return true;
  try {
    const host = new URL(string(link?.url)).hostname.toLowerCase();
    return ['zoom.us', 'meet.google.com', 'teams.microsoft.com', 'webex.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

/** Build UI data solely from successful calendar tool results; model prose is not an input. */
export function calendarResponseCards(
  evidence: ActionEvidence[],
  request?: PersonalReadRequest | null,
): ResponseCard[] {
  if (request?.kind !== 'calendar' && request?.kind !== 'calendar_email') return [];
  const events = evidence.flatMap((row) => {
    if (!succeeded(row) || !/^calendar\.(?:list_events|search_events)$/.test(row.toolName))
      return [];
    const result = record(row.result);
    return Array.isArray(result?.events)
      ? result.events.map(record).filter((event): event is RecordValue => !!event)
      : [];
  });
  const groups: EventGroup[] = [];
  for (const event of events) {
    const group = groups.find((candidate) => sameEvent(candidate[0], event));
    if (group) group.push(event);
    else groups.push([event]);
  }
  return groups
    .map((group) => {
      const event = group[0];
      const start = string(event.start);
      const end = string(event.end);
      const links = Array.isArray(event.links) ? event.links.map(record).filter(Boolean) : [];
      const calendarLink = links.find((link) => string(link?.type) === 'calendar');
      const meetingLink = links.find(isVideoMeetingLink);
      const calendars = [...new Set(group.map((entry) => string(entry.calendar)).filter(Boolean))];
      return {
        kind: 'calendar-event' as const,
        id: `calendar-${group.map((entry) => `${string(entry.calendarId)}:${string(entry.eventId)}`).join('|')}`,
        title: string(event.summary) || 'Untitled event',
        start,
        end,
        time: [formatTime(start, request?.timeZone), end ? formatTime(end, request?.timeZone) : '']
          .filter(Boolean)
          .join('–'),
        location: string(event.location),
        attendees: Array.isArray(event.attendees)
          ? event.attendees
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 3)
          : [],
        calendars,
        calendarLink: calendarLink
          ? { label: string(calendarLink.label) || 'Open event', url: string(calendarLink.url) }
          : undefined,
        meetingLink: meetingLink
          ? {
              label: string(meetingLink.label) || 'Join video meeting',
              url: string(meetingLink.url),
            }
          : undefined,
        // Retain the established field for older clients, but never point an
        // event affordance at the meeting itself.
        link: calendarLink
          ? { label: string(calendarLink.label) || 'Open event', url: string(calendarLink.url) }
          : undefined,
      };
    })
    .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)));
}

/** Ambient data is already trusted context, but only a tiny literal subset becomes a card. */
export function weatherResponseCards(ambient?: string): ResponseCard[] {
  if (!ambient) return [];
  const weather =
    /Weather there:\s*([^,]+),\s*(-?\d+)°C\s*\(today\s*(-?\d+)–(-?\d+)°C,\s*(\d+)% chance of rain, wind\s*(\d+) km\/h(?:, humidity\s*(\d+)%)?\)/i.exec(
      ambient,
    );
  if (!weather) return [];
  const [, condition = '', temperature = '', low = '', high = '', rain = '', wind = '', humidity] =
    weather;
  const location =
    /Owner's current location:\s*(?:near\s+)?([^,(\n.]+)/i.exec(ambient)?.[1]?.trim() ||
    'Right now';
  return [
    {
      kind: 'weather',
      id: `weather-${temperature}-${condition.toLowerCase()}`,
      location,
      condition,
      temperature: `${temperature}°C`,
      details: [
        { label: 'Today', value: `${low}–${high}°C` },
        { label: 'Wind', value: `${wind} km/h` },
        ...(humidity ? [{ label: 'Humidity', value: `${humidity}%` }] : []),
        { label: 'Rain chance', value: `${rain}%` },
      ],
    },
  ];
}

/** Completed reminder results are concise enough to own their response surface. */
export function reminderResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  const reminders = new Map<string, ResponseCard>();
  const add = (value: RecordValue) => {
    const reminderId = string(value.reminderId);
    const title = string(value.text);
    if (!reminderId || !title) return;
    reminders.set(reminderId, {
      kind: 'reminder',
      id: `reminder-${reminderId}`,
      title,
      schedule: string(value.cron),
      nextFires: string(value.nextFires),
      enabled: value.enabled !== false,
    });
  };

  for (const row of evidence) {
    if (!succeeded(row)) continue;
    const result = record(row.result);
    if (!result) continue;
    if (row.toolName === 'reminder.create') add(result);
    if (row.toolName === 'reminder.list' && Array.isArray(result.reminders)) {
      result.reminders
        .map(record)
        .filter((reminder): reminder is RecordValue => !!reminder)
        .forEach(add);
    }
  }
  return [...reminders.values()];
}

/** Metadata-only inbox searches have a stable, complete structured representation. */
export function emailResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'gmail.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const messages = Array.isArray(result.results)
      ? result.results
          .map(record)
          .filter((message): message is RecordValue => !!message)
          .map((message, messageIndex) => ({
            id:
              string(message.messageId) ||
              string(message.threadId) ||
              `email-${index}-${messageIndex}`,
            sender: string(message.from),
            recipient: string(message.to),
            subject: string(message.subject) || 'No subject',
            date: string(message.date),
            snippet: string(message.snippet),
          }))
      : [];
    return [
      {
        kind: 'email-results' as const,
        id: `email-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Email results',
        query: string(args?.query),
        mailbox: string(result.mailboxSearched),
        complete: result.complete !== false,
        matchingMessagesEstimate: number(result.matchingMessagesEstimate),
        messages,
      },
    ];
  });
}

/** Filed-document search results are external content, but their provenance stays visible in the card. */
export function documentResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'documents.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const passages = Array.isArray(result.passages)
      ? result.passages
          .map(record)
          .filter((passage): passage is RecordValue => !!passage)
          .map((passage, passageIndex) => ({
            id: `passage-${index}-${passageIndex}`,
            document: string(passage.document) || 'Untitled document',
            source: string(passage.source),
            snippet: string(passage.snippet),
            similarity: number(passage.similarity),
          }))
      : [];
    return [
      {
        kind: 'document-results' as const,
        id: `document-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Document matches',
        query: string(args?.query),
        passages,
      },
    ];
  });
}

/** Drive search cards keep a result's useful metadata and open link together. */
export function driveResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'drive.search') return [];
    const result = record(row.result);
    if (!result) return [];
    const args = record(row.args);
    const files = Array.isArray(result.files)
      ? result.files
          .map(record)
          .filter((file): file is RecordValue => !!file)
          .map((file, fileIndex) => ({
            id: string(file.fileId) || `file-${index}-${fileIndex}`,
            name: string(file.name) || 'Untitled file',
            mimeType: string(file.mimeType),
            modifiedTime: string(file.modifiedTime),
            size: string(file.size) || (number(file.size) !== undefined ? String(file.size) : ''),
            url: string(file.url),
          }))
      : [];
    return [
      {
        kind: 'drive-results' as const,
        id: `drive-results-${index}-${string(args?.query) || 'search'}`,
        title: 'Drive files',
        query: string(args?.query),
        files,
      },
    ];
  });
}

/** Private artifacts deserve a direct, tappable result rather than a prose-only confirmation. */
export function resourceResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row)) return [];
    const result = record(row.result);
    const args = record(row.args);
    if (!result) return [];
    if (row.toolName === 'docs.create') {
      const title = string(result.title) || string(args?.title);
      if (!title) return [];
      return [
        {
          kind: 'resource' as const,
          id: `document-${string(result.documentId) || index}`,
          resourceType: 'document',
          title,
          subtitle: 'Google Doc created',
          details: details([['Shared with', string(result.sharedWith)]]),
          link: { label: 'Open document', url: string(result.url) },
        },
      ];
    }
    if (row.toolName === 'sheets.create') {
      const title = string(result.title) || string(args?.title);
      if (!title) return [];
      return [
        {
          kind: 'resource' as const,
          id: `spreadsheet-${string(result.spreadsheetId) || index}`,
          resourceType: 'spreadsheet',
          title,
          subtitle: 'Google Sheet created',
          details: details([['Shared with', string(result.sharedWith)]]),
          link: { label: 'Open spreadsheet', url: string(result.url) },
        },
      ];
    }
    return [];
  });
}

/** Writes that have no browseable artifact still receive a factual completion card. */
export function statusResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row)) return [];
    const result = record(row.result);
    const args = record(row.args);
    if (!result) return [];
    if (row.toolName === 'reminder.cancel' && result.cancelled === true) {
      return [
        {
          kind: 'status' as const,
          id: `reminder-cancelled-${string(result.reminderId) || index}`,
          title: 'Reminder cancelled',
          detail: 'This recurring reminder will no longer run.',
          symbol: 'bell.slash.fill',
        },
      ];
    }
    if (row.toolName === 'gmail.create_draft') {
      return [
        {
          kind: 'status' as const,
          id: `email-draft-${string(result.draftId) || index}`,
          title: 'Email draft ready',
          detail: string(result.subject) || string(args?.subject),
          symbol: 'envelope.badge.fill',
          details: details([['To', strings(result.to).join(', ') || strings(args?.to).join(', ')]]),
        },
      ];
    }
    if (row.toolName === 'gmail.send') {
      return [
        {
          kind: 'status' as const,
          id: `email-sent-${string(result.messageId) || index}`,
          title: 'Email sent',
          detail: string(args?.subject),
          symbol: 'paperplane.fill',
          details: details([['To', strings(result.to).join(', ') || strings(args?.to).join(', ')]]),
        },
      ];
    }
    if (row.toolName === 'calendar.update_event' && result.updated === true) {
      return [
        {
          kind: 'status' as const,
          id: `calendar-updated-${string(result.eventId) || index}`,
          title: 'Calendar event updated',
          detail: string(args?.summary) || 'The event details were updated.',
          symbol: 'calendar.badge.checkmark',
          details: details([
            ['Time', string(args?.start)],
            ['Location', string(args?.location)],
            ['Invited', strings(args?.addAttendees).join(', ')],
          ]),
        },
      ];
    }
    if (row.toolName === 'calendar.cancel_event' && string(result.cancelled)) {
      return [
        {
          kind: 'status' as const,
          id: `calendar-cancelled-${string(result.cancelled)}`,
          title: 'Calendar event cancelled',
          detail: 'The event was removed from the calendar.',
          symbol: 'calendar.badge.minus',
        },
      ];
    }
    return [];
  });
}

/** Event creation returns an id and link while its executed inputs contain the complete event. */
export function calendarWriteResponseCards(evidence: ActionEvidence[]): ResponseCard[] {
  return evidence.flatMap((row, index) => {
    if (!succeeded(row) || row.toolName !== 'calendar.create_event') return [];
    const result = record(row.result);
    const args = record(row.args);
    const title = string(args?.summary);
    const start = string(args?.start);
    if (!result || !title || !start) return [];
    const end = string(args?.end);
    return [
      {
        kind: 'calendar-event' as const,
        id: `calendar-${string(result.eventId) || index}`,
        title,
        start,
        end,
        time: [formatTime(start), end ? formatTime(end) : ''].filter(Boolean).join('–'),
        location: string(args?.location),
        attendees: strings(result.invited).length
          ? strings(result.invited)
          : strings(args?.attendees),
        calendars: [],
        calendarLink: string(result.link)
          ? { label: 'Open event', url: string(result.link) }
          : undefined,
        link: string(result.link) ? { label: 'Open event', url: string(result.link) } : undefined,
      },
    ];
  });
}

export function responseCardsForFinal(input: {
  evidence: ActionEvidence[];
  readRequest?: PersonalReadRequest | null;
  ambient?: string;
  requestText?: string;
}): ResponseCard[] {
  const cards = [
    ...resourceResponseCards(input.evidence),
    ...statusResponseCards(input.evidence),
    ...calendarWriteResponseCards(input.evidence),
    ...reminderResponseCards(input.evidence),
    ...calendarResponseCards(input.evidence, input.readRequest),
    ...emailResponseCards(input.evidence),
    ...documentResponseCards(input.evidence),
    ...driveResponseCards(input.evidence),
  ];
  if (cards.length > 0) return cards;
  // Ambient weather is useful for a conversational/weather answer, but must
  // never appear as an unrelated result below a tool-backed response.
  return input.readRequest ||
    !/\b(?:weather|forecast|temperature|rain)\b/i.test(input.requestText ?? '')
    ? []
    : weatherResponseCards(input.ambient);
}
