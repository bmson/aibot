/**
 * Guard facts that a model is about to commit to Google Workspace. This is
 * intentionally narrow: ordinary sheet headings and model-written summaries
 * remain free-form, while flight identifiers and calendar instants must be
 * present in the owner's request or a successful read in this task.
 */

export interface WriteGroundingResult {
  allowed: boolean;
  reason?: string;
}

const READ_TOOLS = new Set([
  'calendar.list_events',
  'calendar.search_events',
  'gmail.search',
  'gmail.read_thread',
  'drive.search',
  'drive.read',
  'docs.get',
  'web.search',
  'web.fetch',
]);

const AIRLINES: Array<[string, string[]]> = [
  ['UA', ['united']],
  ['AA', ['american airlines']],
  ['DL', ['delta', 'delta air lines']],
  ['KL', ['klm']],
  ['LH', ['lufthansa']],
  ['BA', ['british airways']],
  ['AF', ['air france']],
  ['AS', ['alaska airlines']],
  ['B6', ['jetblue']],
  ['EK', ['emirates']],
];

const FLIGHT_CONTEXT = /\b(?:flight|airline|itinerary|boarding|departure|arrival|airport)\b/i;
const SOURCE_GROUP_SEPARATOR = '\n\u001eSOURCE_GROUP\u001e\n';
const TIME_ZONE_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  PST: -8,
  PDT: -7,
  MST: -7,
  MDT: -6,
  CST: -6,
  CDT: -5,
  EST: -5,
  EDT: -4,
  CET: 1,
  CEST: 2,
};
const NOT_AIRPORT_CODE = new Set([
  'AM',
  'API',
  'CEO',
  'CFO',
  'COO',
  'CTO',
  'CSV',
  'ETA',
  'ETD',
  'PDF',
  'TBA',
  'TBD',
  'ARR',
  'CET',
  'CEST',
  'DEP',
  'EDT',
  'EST',
  'EUR',
  'GBP',
  'GMT',
  'KLM',
  'PDT',
  'PST',
  'UTC',
  'USD',
  'USA',
]);
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function evidenceChunks(value: unknown): string[] {
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === 'object');
    return objects.length > 0 ? objects.flatMap(evidenceChunks) : [JSON.stringify(value)];
  }
  const object = record(value);
  const childRecords = Object.values(object).filter(
    (item): item is unknown[] =>
      Array.isArray(item) && item.some((entry) => entry && typeof entry === 'object'),
  );
  if (childRecords.length > 0) return childRecords.flatMap(evidenceChunks);
  return [JSON.stringify(value)];
}

function sourceGroups(corpus: string): string[] {
  return corpus.split(SOURCE_GROUP_SEPARATOR).filter(Boolean);
}

/** Parsed instants from explicit ISO values and common month/day clock phrases. */
export function explicitWriteInstants(value: string, referenceAt = new Date()): number[] {
  return [...sourceInstants(value, referenceAt)];
}

/** Read only successful source results; assistant prose and failed actions are not evidence. */
export function writeGroundingCorpus(
  window: Array<{ role: string; content?: unknown }>,
  ownerText: string,
): string {
  const calls = new Map<string, string>();
  const callInputs = new Map<string, unknown>();
  const sources = [ownerText];
  for (const message of window) {
    if (!Array.isArray(message.content)) continue;
    for (const partValue of message.content) {
      const part = record(partValue);
      if (
        part.type === 'tool-call' &&
        typeof part.toolCallId === 'string' &&
        typeof part.toolName === 'string'
      ) {
        calls.set(part.toolCallId, part.toolName);
        callInputs.set(part.toolCallId, part.input);
      }
      if (part.type !== 'tool-result' || typeof part.toolCallId !== 'string') continue;
      const toolName =
        typeof part.toolName === 'string' ? part.toolName : calls.get(part.toolCallId);
      const output = record(part.output);
      const value = record(output.value);
      if (typeof value.error === 'string' || value.ok === false || value.complete === false)
        continue;
      if (toolName === 'calendar.create_event' && typeof value.eventId === 'string') {
        const input = callInputs.get(part.toolCallId);
        if (input !== undefined) sources.push(JSON.stringify(input));
        continue;
      }
      if (!toolName || !READ_TOOLS.has(toolName)) continue;
      // Truncated previews cannot establish that a missing flight detail was absent.
      if (value.truncated === true) continue;
      sources.push(...evidenceChunks(output.value));
    }
  }
  return sources.join(SOURCE_GROUP_SEPARATOR);
}

function normalized(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeCarrier(text: string): Set<string> {
  const source = normalized(text);
  const carriers = new Set<string>();
  for (const [code, names] of AIRLINES) {
    const flightCode = new RegExp(`\\b${code}\\s*\\d{1,4}\\b`, 'i').test(text);
    const namedCarrier = names.some((name) => {
      if (name === 'united') return /\bunited\b(?!\s+states\b)/i.test(source);
      if (name === 'alaska airlines') return /\balaska\s+airlines\b/i.test(source);
      return new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(source);
    });
    if (flightCode || namedCarrier) {
      carriers.add(code);
    }
  }
  return carriers;
}

function flightFacts(text: string): {
  airports: Set<string>;
  numbers: Set<string>;
  carriers: Set<string>;
} {
  const airports = new Set(
    (text.match(/\b[A-Z]{3}\b/g) ?? []).filter((code) => !NOT_AIRPORT_CODE.has(code)),
  );
  const numbers = new Set(
    (text.match(/\b(?:UA|AA|DL|KL|LH|BA|AF|AS|B6|EK)\s*\d{1,4}\b/gi) ?? []).map((value) =>
      value.replace(/\s+/g, '').toUpperCase(),
    ),
  );
  return { airports, numbers, carriers: normalizeCarrier(text) };
}

function epochForParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetHours: number,
): number {
  return Date.UTC(year, month - 1, day, hour - offsetHours, minute);
}

function sourceInstants(text: string, referenceAt: Date): Set<number> {
  const instants = new Set<number>();
  for (const match of text.matchAll(
    /\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/gi,
  )) {
    const value = Date.parse(match[1] ?? '');
    if (Number.isFinite(value)) instants.add(value);
  }

  const dates = [
    ...text.matchAll(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi,
    ),
  ];
  // An explicit zone is required: inventing a zone for a source clock would
  // make an unsupported calendar timestamp look grounded.
  const clocks = [
    ...text.matchAll(
      /\b(\d{1,2})(?::(\d{2}))?\s*(?:(a\.?m\.?|p\.?m\.?)\s*)?(UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CEST|CET)\b/gi,
    ),
  ];
  for (const clock of clocks) {
    const clockStart = clock.index;
    const clockEnd = clockStart + clock[0].length;
    const candidates = dates
      .flatMap((date) => {
        const dateStart = date.index;
        const dateEnd = dateStart + date[0].length;
        const left = dateEnd <= clockStart ? dateEnd : clockEnd;
        const right = dateEnd <= clockStart ? clockStart : dateStart;
        if (right < left || right - left > 50) return [];
        // A neighboring leg's date must not jump over another clock or date.
        if (clocks.some((other) => other !== clock && other.index >= left && other.index < right))
          return [];
        if (dates.some((other) => other !== date && other.index >= left && other.index < right))
          return [];
        if (/[;\n!?]/.test(text.slice(left, right))) return [];
        return [{ date, distance: right - left, before: dateEnd <= clockStart }];
      })
      .sort((a, b) => a.distance - b.distance || Number(b.before) - Number(a.before));
    // In adjacent date/time columns, a tie belongs to the preceding date.
    if (!candidates[0]) continue;
    const date = candidates[0].date;
    const month = MONTHS[(date[1] ?? '').toLowerCase()];
    if (!month) continue;
    const day = Number(date[2]);
    const year = Number(date[3] ?? referenceAt.getUTCFullYear());
    const rawHour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = (clock[3] ?? '').toLowerCase();
    const hour = meridiem ? (rawHour % 12) + (meridiem.startsWith('p') ? 12 : 0) : rawHour;
    const zone = (clock[4] ?? '').toUpperCase();
    const calendarDay = new Date(Date.UTC(year, month - 1, day));
    if (
      !month ||
      calendarDay.getUTCMonth() !== month - 1 ||
      calendarDay.getUTCDate() !== day ||
      rawHour > (meridiem ? 12 : 23) ||
      (meridiem && rawHour < 1) ||
      minute > 59
    )
      continue;
    instants.add(epochForParts(year, month, day, hour, minute, TIME_ZONE_OFFSETS[zone] ?? 0));
  }
  return instants;
}

function isFlightIntent(ownerText: string, input: UnknownRecord): boolean {
  return FLIGHT_CONTEXT.test(ownerText) || FLIGHT_CONTEXT.test(JSON.stringify(input));
}

function flightGroundingFailure(
  ownerText: string,
  input: UnknownRecord,
  corpus: string,
): string | undefined {
  if (!isFlightIntent(ownerText, input)) return undefined;
  const argsFacts = flightFacts(JSON.stringify(input));
  const sourceFacts = flightFacts(corpus);
  for (const airport of argsFacts.airports) {
    if (!sourceFacts.airports.has(airport))
      return `airport code ${airport} is not in the owner's request or a successful read result`;
  }
  for (const flightNumber of argsFacts.numbers) {
    if (!sourceFacts.numbers.has(flightNumber))
      return `flight number ${flightNumber} is not in the owner's request or a successful read result`;
  }
  for (const carrier of argsFacts.carriers) {
    if (!sourceFacts.carriers.has(carrier))
      return `airline ${carrier} is not in the owner's request or a successful read result`;
  }
  return undefined;
}

function readCalendarInstants(input: UnknownRecord): number[] {
  return ['start', 'end'].flatMap((key) => {
    const value = input[key];
    if (typeof value !== 'string') return [];
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) ? [epoch] : [];
  });
}

function sheetFlightTimeFailure(
  input: UnknownRecord,
  corpus: string,
  referenceAt: Date,
): string | undefined {
  if (!Array.isArray(input.rows)) return undefined;
  const rows = input.rows as unknown[];
  const firstDataRow = input.headerRow === true ? 1 : 0;
  const groups = sourceGroups(corpus);
  for (const row of rows.slice(firstDataRow)) {
    if (!Array.isArray(row)) continue;
    const rowText = row.filter((cell): cell is string => typeof cell === 'string').join(' ');
    const instants = sourceInstants(rowText, referenceAt);
    const withoutIsoInstants = rowText.replace(
      /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/gi,
      ' ',
    );
    const clockCount =
      [
        ...withoutIsoInstants.matchAll(
          /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|UTC|GMT|PST|PDT|MST|MDT|CST|CDT|EST|EDT|CEST|CET)\b|\b\d{1,2}:\d{2}\b/gi,
        ),
      ].length + [...rowText.matchAll(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/gi)].length;
    if (clockCount > 0 && instants.size !== clockCount) {
      return 'a flight date or time in the spreadsheet is incomplete or ambiguous';
    }
    const rowFacts = flightFacts(rowText);
    const groundedTogether = [...instants].every((instant) =>
      groups.some((group) => {
        const groupInstants = sourceInstants(group, referenceAt);
        const groupFacts = flightFacts(group);
        return (
          groupInstants.has(instant) &&
          [...rowFacts.airports].every((fact) => groupFacts.airports.has(fact)) &&
          [...rowFacts.numbers].every((fact) => groupFacts.numbers.has(fact)) &&
          [...rowFacts.carriers].every((fact) => groupFacts.carriers.has(fact))
        );
      }),
    );
    if (clockCount > 0 && !groundedTogether) {
      return "a flight date or time in the spreadsheet is not supported by the owner's request or a successful read result";
    }
  }
  return undefined;
}

/**
 * Verify only consequential flight facts and flight calendar instants.
 * Free-form sheet titles, headings, prose, summaries, and ordinary calendar
 * appointment times are deliberately left to their existing paths.
 */
export function groundWorkspaceWrite(
  toolName: string,
  value: unknown,
  ownerText: string,
  corpus: string,
  referenceAt = new Date(),
): WriteGroundingResult {
  if (toolName !== 'calendar.create_event' && toolName !== 'sheets.create')
    return { allowed: true };
  const input = record(value);
  const flightFailure = flightGroundingFailure(ownerText, input, corpus);
  if (flightFailure) return { allowed: false, reason: flightFailure };

  if (toolName === 'sheets.create' && isFlightIntent(ownerText, input)) {
    const timeFailure = sheetFlightTimeFailure(input, corpus, referenceAt);
    if (timeFailure) return { allowed: false, reason: timeFailure };
  }

  if (toolName === 'calendar.create_event') {
    if (!isFlightIntent(ownerText, input)) return { allowed: true };
    const expected = readCalendarInstants(input);
    if (expected.length !== 2) {
      return { allowed: false, reason: 'flight calendar start and end times are incomplete' };
    }
    const start = expected[0];
    const end = expected[1];
    if (start === undefined || end === undefined || end <= start) {
      return { allowed: false, reason: 'flight calendar times are invalid or out of order' };
    }
    const inputFacts = flightFacts(JSON.stringify(input));
    const groundedTogether = sourceGroups(corpus).some((group) => {
      const groupInstants = sourceInstants(group, referenceAt);
      const groupFacts = flightFacts(group);
      return (
        groupInstants.has(start) &&
        groupInstants.has(end) &&
        [...inputFacts.airports].every((fact) => groupFacts.airports.has(fact)) &&
        [...inputFacts.numbers].every((fact) => groupFacts.numbers.has(fact)) &&
        [...inputFacts.carriers].every((fact) => groupFacts.carriers.has(fact))
      );
    });
    if (!groundedTogether) {
      const all = new Set(
        sourceGroups(corpus).flatMap((group) => [...sourceInstants(group, referenceAt)]),
      );
      const missing = !all.has(start) ? 'start' : 'end';
      return {
        allowed: false,
        reason: `flight calendar ${missing} time is not supported with the flight details by one owner request or successful source result`,
      };
    }
  }
  return { allowed: true };
}
