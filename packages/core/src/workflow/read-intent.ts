/**
 * Deterministic routing for questions whose answer lives in the assistant's
 * Google accounts. These requests are deliberately not left to a cheap model
 * classifier: a false "conversation" or "clarify" verdict gives a tool-less
 * model room to invent a plausible calendar or inbox answer.
 */

export type PersonalReadKind = 'calendar' | 'email' | 'calendar_email';

export interface PersonalReadTimeWindow {
  timeMin: string;
  timeMax: string;
  label: string;
}

export interface PersonalReadRequest {
  kind: PersonalReadKind;
  /** Literal subject terms to bind into calendar/Gmail searches. */
  queryTerms: string[];
  /** First read tool the executor must call. */
  firstToolName:
    | 'calendar.list_events'
    | 'calendar.search_events'
    | 'calendar.availability'
    | 'gmail.search';
  /** A metadata-only Gmail hit is not enough to answer a detail question. */
  requiresThreadRead: boolean;
  /** Runtime-resolved range; the model never chooses the date window. */
  timeWindow?: PersonalReadTimeWindow;
  /** Gmail query derived from the owner's words, not model-proposed narrowing. */
  mailQuery?: string;
  /** Used only to render returned timestamps for the owner. */
  timeZone?: string;
  /** The owner is challenging a prior claim; prior prose remains hypothesis-only. */
  verification?: boolean;
}

export interface PersonalReadDetectionOptions {
  now?: Date;
  timeZone?: string;
}

export interface ReadIntentMessage {
  role: string;
  /** Core model messages store text in content; AI SDK UI messages use parts. */
  content?: unknown;
  parts?: unknown;
}

export interface ReadToolEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string | null;
}

const CALENDAR_SURFACE =
  /\b(?:calendars?|schedule|agenda|appointments?|events?|meetings?|interviews?|calls?|chats?|flights?|reservations?)\b/i;
const EMAIL_SURFACE = /\b(?:inbox|mailbox|e-?mails?|mail|messages?|threads?)\b/i;
const AVAILABILITY_SURFACE =
  /\b(?:availability|available|busy|conflicts?|free|open\s+(?:time|slots?))\b/i;
const CALENDAR_TIME_REFERENCE =
  /\b(?:today|tomorrow|weekends?|weeks?|months?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\d{2}-\d{2}-\d{2})\b/i;
const SCHEDULED_THING =
  /\b(interviews?|meetings?|appointments?|calls?|chats?|flights?|reservations?|bookings?|events?)\b/i;
const READ_OR_QUESTION =
  /\b(?:what|when|where|which|who|do i|did i|is there|are there|check|checked|look|find|found|search|searched|show|tell|review|reviewed|read|scan|open|pull up|bring up|see)\b/i;
const WHY_LOOKUP = /\bwhy\b/i;
const DAY_SCHEDULE =
  /\bwhat(?:(?:'|’)s| is)?\s+(?:happening|going on|coming up|planned|scheduled)\b|\bwhat\s+(?:am i|are we)\s+doing\b|\bwhat\s+do\s+i\s+have\s+(?:(?:on|this|next)\s+)?(?:today|tomorrow|week(?:end)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bwhat(?:(?:'|’)s| is)\s+on\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const VERIFY =
  /\b(?:are you sure|double[- ]check|verify|you checked|did you check|don(?:'|’)t see|do not see|not on my|why did you say|was that made up|made that up|is that real|actually there)\b/i;
const MUTATION_LEAD =
  /^\s*(?:(?:please|can you|could you|would you|i want you to)\s+)*(?:add|archive|block|book|cancel|create|delete|edit|forward|hold|invite|label|mark|move|reply|reschedule|schedule|send|update)\b/i;
const READ_THEN_MUTATION =
  /\b(?:and|then|also)\s+(?:add|archive|block|book|cancel|create|delete|edit|flag|forward|hold|invite|label|mark|move|reply|reschedule|schedule|send|update)\b/i;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MONTH_NUMBER: Record<string, number> = {
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

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function civilDateAt(instant: Date, timeZone: string): CivilDate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const date = { year: value('year'), month: value('month'), day: value('day') };
    if (date.year && date.month && date.day) return date;
  } catch {
    // Invalid or unavailable timezone data falls back to UTC below.
  }
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function civilWeekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Convert a civil midnight in `timeZone` to an exact UTC instant, including DST. */
function zonedMidnight(date: CivilDate, timeZone: string): string {
  const desired = Date.UTC(date.year, date.month - 1, date.day);
  let guess = desired;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(guess));
      const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      const observed = Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      );
      guess += desired - observed;
    }
  } catch {
    guess = desired;
  }
  return new Date(guess).toISOString();
}

function timeWindow(
  start: CivilDate,
  end: CivilDate,
  label: string,
  timeZone: string,
): PersonalReadTimeWindow {
  return {
    timeMin: zonedMidnight(start, timeZone),
    timeMax: zonedMidnight(end, timeZone),
    label,
  };
}

function resolveTimeWindow(
  text: string,
  kind: PersonalReadKind,
  hasNamedTerms: boolean,
  options: PersonalReadDetectionOptions,
): PersonalReadTimeWindow | undefined {
  if (!options.timeZone) return undefined;
  const timeZone = options.timeZone;
  const today = civilDateAt(options.now ?? new Date(), timeZone);
  const range = (start: CivilDate, days: number, label: string) =>
    timeWindow(start, addCivilDays(start, days), label, timeZone);

  const relativeCount = /\bnext\s+(\d{1,2})\s+(days?|weeks?)\b/i.exec(text);
  if (relativeCount) {
    const count = Math.max(1, Number(relativeCount[1]));
    const unit = relativeCount[2]?.toLowerCase() ?? 'days';
    const days = unit.startsWith('week') ? count * 7 : count;
    return range(today, days, `the next ${count} ${unit}`);
  }

  const isoDate = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoDate) {
    const start = {
      year: Number(isoDate[1]),
      month: Number(isoDate[2]),
      day: Number(isoDate[3]),
    };
    return range(start, 1, isoDate[0]);
  }

  const namedDate = new RegExp(
    `\\b(${Object.keys(MONTH_NUMBER).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,
    'i',
  ).exec(text);
  if (namedDate?.[1] && namedDate[2]) {
    const explicitYear = namedDate[3] ? Number(namedDate[3]) : undefined;
    let year = explicitYear ?? today.year;
    const month = MONTH_NUMBER[namedDate[1].toLowerCase()] as number;
    const day = Number(namedDate[2]);
    if (
      explicitYear === undefined &&
      Date.UTC(year, month - 1, day) < Date.UTC(today.year, today.month - 1, today.day)
    ) {
      year += 1;
    }
    const valid = new Date(Date.UTC(year, month - 1, day));
    if (
      valid.getUTCFullYear() === year &&
      valid.getUTCMonth() + 1 === month &&
      valid.getUTCDate() === day
    ) {
      return range({ year, month, day }, 1, namedDate[0]);
    }
  }

  if (/\btomorrow\b/i.test(text)) return range(addCivilDays(today, 1), 1, 'tomorrow');
  if (/\btoday\b/i.test(text)) return range(today, 1, 'today');

  const weekdayMatch = new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i').exec(text);
  if (weekdayMatch?.[2]) {
    const target = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase() as (typeof WEEKDAYS)[number]);
    let delta = (target - civilWeekday(today) + 7) % 7;
    if (weekdayMatch[1] && delta === 0) delta = 7;
    const start = addCivilDays(today, delta);
    return range(start, 1, weekdayMatch[0].toLowerCase());
  }

  const mondayOffset = (1 - civilWeekday(today) + 7) % 7;
  const currentMonday = addCivilDays(today, mondayOffset === 0 ? 0 : mondayOffset - 7);
  if (/\bnext\s+week(?:end)?\b/i.test(text)) {
    if (/weekend/i.test(text)) {
      const start = addCivilDays(currentMonday, 12);
      return range(start, 2, 'next weekend');
    }
    const start = addCivilDays(currentMonday, 7);
    return range(start, 7, 'next week');
  }
  if (/\b(?:this\s+)?weekend\b/i.test(text)) {
    const start = addCivilDays(currentMonday, 5);
    return range(start, 2, 'this weekend');
  }
  if (/\bthis\s+week\b/i.test(text)) return range(currentMonday, 7, 'this week');

  const firstOfMonth = { year: today.year, month: today.month, day: 1 };
  const nextMonth =
    today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
  const followingMonth =
    nextMonth.month === 12
      ? { year: nextMonth.year + 1, month: 1, day: 1 }
      : { year: nextMonth.year, month: nextMonth.month + 1, day: 1 };
  if (/\bnext\s+month\b/i.test(text)) {
    return timeWindow(nextMonth, followingMonth, 'next month', timeZone);
  }
  if (/\bthis\s+month\b/i.test(text)) {
    return timeWindow(firstOfMonth, nextMonth, 'this month', timeZone);
  }

  // A named appointment with no stated date gets a broad, deterministic range
  // around today. A generic schedule question defaults to the next seven days.
  return kind === 'calendar_email' || hasNamedTerms
    ? timeWindow(
        addCivilDays(today, -365),
        addCivilDays(today, 730),
        'one year back through two years ahead',
        timeZone,
      )
    : range(today, 7, 'the next 7 days');
}

function gmailQuery(text: string, terms: string[]): string {
  const parts = terms.length > 0 ? [terms.join(' ')] : [];
  if (/\binbox\b/i.test(text)) parts.push('in:inbox');
  if (terms.length === 0 && /\b(?:urgent|important)\b/i.test(text)) {
    parts.push('{is:starred is:important}');
  }
  if (/\b(?:new|unread)\b/i.test(text)) {
    if (!parts.includes('in:inbox')) parts.push('in:inbox');
    parts.push('is:unread');
  }
  const recentDays = /\b(?:last|past)\s+(\d{1,2})\s+days?\b/i.exec(text)?.[1];
  if (recentDays) parts.push(`newer_than:${Math.max(1, Number(recentDays))}d`);
  else if (/\b(?:last|past)\s+week\b/i.test(text)) parts.push('newer_than:7d');
  else if (/\b(?:last|past)\s+month\b/i.test(text)) parts.push('newer_than:30d');
  return parts.join(' ').trim() || '-in:spam -in:trash';
}

const QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'anything',
  'are',
  'at',
  'back',
  'check',
  'checked',
  'calendar',
  'calendars',
  'claimed',
  'confirmed',
  'did',
  'do',
  'does',
  'find',
  'found',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'looking',
  'me',
  'mentioned',
  'my',
  'next',
  'no',
  'not',
  'of',
  'on',
  'our',
  'please',
  'pm',
  'previously',
  'receive',
  'received',
  'said',
  'say',
  'says',
  'search',
  'searched',
  'saw',
  'send',
  'sent',
  'show',
  'source',
  'system',
  'the',
  'this',
  'time',
  'to',
  'up',
  'was',
  'what',
  'when',
  'where',
  'which',
  'why',
  'you',
  'your',
]);

const QUERY_MODIFIERS = new Set([
  'behavioral',
  'coding',
  'coffee',
  'engineer',
  'final',
  'first',
  'initial',
  'manager',
  'monday',
  'onsite',
  'panel',
  'phone',
  'product',
  'recruiter',
  'round',
  'saturday',
  'scheduled',
  'screen',
  'screening',
  'second',
  'software',
  'sunday',
  'team',
  'technical',
  'thursday',
  'today',
  'tomorrow',
  'tuesday',
  'upcoming',
  'urgent',
  'video',
  'virtual',
  'wednesday',
  'week',
  'yesterday',
]);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function messageText(message: ReadIntentMessage | undefined): string {
  if (!message) return '';
  return contentText(message.content ?? message.parts);
}

function queryTerms(text: string): string[] {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’-]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/(?:['’]s)$/i, ''))
      .filter(
        (word) =>
          word.length > 1 &&
          !/^\d+$/.test(word) &&
          !QUERY_STOP_WORDS.has(word) &&
          !QUERY_MODIFIERS.has(word) &&
          MONTH_NUMBER[word] === undefined &&
          !SCHEDULED_THING.test(word),
      );

  const nounMatches = [...text.matchAll(new RegExp(SCHEDULED_THING.source, 'gi'))];
  const firstNoun = nounMatches[0];
  if (!firstNoun?.[1] || firstNoun.index === undefined) return [];
  for (const nounMatch of nounMatches) {
    if (!nounMatch[1] || nounMatch.index === undefined) continue;
    const after = text.slice(
      nounMatch.index + nounMatch[0].length,
      nounMatch.index + nounMatch[0].length + 120,
    );
    const related =
      /^\s*(?:(?:is|was|will be)\s+)?(?:with|at|for|from|to|about)\s+([^\n.!?;]+)/i.exec(
        after,
      )?.[1];
    const rawBefore = text.slice(Math.max(0, nounMatch.index - 120), nounMatch.index);
    const clauseStart = Math.max(
      rawBefore.lastIndexOf('\n'),
      rawBefore.lastIndexOf('.'),
      rawBefore.lastIndexOf('!'),
      rawBefore.lastIndexOf('?'),
      rawBefore.lastIndexOf(';'),
      rawBefore.lastIndexOf(':'),
    );
    const before = rawBefore.slice(clauseStart + 1);
    const specific = related ? words(related).slice(0, 2) : words(before).slice(-2);
    if (specific.length > 0) return [...new Set(specific)];
  }

  // Search on the named entity when one is present. Adding generic words such
  // as "interview", "upcoming", or "technical" makes Gmail's default AND
  // semantics miss otherwise-correct messages. Fall back to the appointment
  // noun only when the owner gave no distinguishing term.
  return [firstNoun[1].toLowerCase()];
}

function emailQueryTerms(text: string): string[] {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’-]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/(?:['’]s)$/i, ''))
      .filter(
        (word) =>
          word.length > 1 &&
          !QUERY_STOP_WORDS.has(word) &&
          !QUERY_MODIFIERS.has(word) &&
          !EMAIL_SURFACE.test(word) &&
          !/^(?:already|company|days?|important|job|last|latest|mention(?:ed)?|months?|new|position|recent|role|something|unread|weeks?)$/.test(
            word,
          ),
      );
  const related =
    /\b(?:about|concerning|for|from|regarding|with)\s+(.+?)(?=\s+(?:and|but|that|which|who)\b|[?.,;!]|$)/i.exec(
      text,
    )?.[1];
  const candidates = words(related ?? text);
  return [...new Set(candidates.slice(0, 2))];
}

/**
 * Identify private account lookups from the latest owner turn. Recent context
 * is used only for terse verification follow-ups such as "are you sure?".
 */
export function detectPersonalReadRequest(
  messages: ReadonlyArray<ReadIntentMessage>,
  options: PersonalReadDetectionOptions = {},
): PersonalReadRequest | null {
  let latestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex === -1) return null;
  const latest = messageText(messages[latestIndex]).trim();
  if (
    !latest ||
    /^\s*i\s+(?:read|checked|reviewed|looked|searched|scanned|opened)\b/i.test(latest) ||
    READ_THEN_MUTATION.test(latest) ||
    (MUTATION_LEAD.test(latest) && !/\b(?:check|find|search|look|show)\b/i.test(latest))
  ) {
    return null;
  }

  const recentContext = messages
    .slice(Math.max(0, latestIndex - 4), latestIndex)
    .map(messageText)
    .join('\n');
  const verification = VERIFY.test(latest);
  // A terse correction such as "was that made up?" carries no subject of its
  // own. Reuse the prior assistant claim only as a search hypothesis — never as
  // answer evidence — so the runtime can actually verify the named item.
  const contextualQuery = verification && queryTerms(latest).length === 0;
  const hypothesis = contextualQuery ? recentContext : latest;
  let terms = queryTerms(hypothesis);
  const scheduledNoun = SCHEDULED_THING.exec(hypothesis)?.[1]?.toLowerCase();
  const genericScheduleList = Boolean(
    scheduledNoun?.endsWith('s') &&
      terms.length === 1 &&
      terms[0] === scheduledNoun &&
      /\b(?:all|are my|do i have|find|list|show|what|which)\b/i.test(latest),
  );
  if (genericScheduleList) terms = [];
  const whyLookup =
    WHY_LOOKUP.test(latest) &&
    /\b(?:my|our|you said|said i|i had|i have|calendar|schedule)\b/i.test(latest);
  const personalSchedule =
    /\b(?:my|our|the|this|that|do i|did i|is there|are there)\b/i.test(latest) ||
    terms.some((term) => !SCHEDULED_THING.test(term));
  const namedSchedule =
    !genericScheduleList &&
    (SCHEDULED_THING.test(latest) || (verification && SCHEDULED_THING.test(recentContext))) &&
    personalSchedule &&
    (READ_OR_QUESTION.test(latest) || verification || whyLookup);
  const daySchedule = DAY_SCHEDULE.test(latest);
  const calendar =
    daySchedule ||
    namedSchedule ||
    (CALENDAR_SURFACE.test(latest) &&
      (READ_OR_QUESTION.test(latest) || verification || whyLookup)) ||
    (verification && CALENDAR_SURFACE.test(recentContext));
  const email =
    (EMAIL_SURFACE.test(latest) && (READ_OR_QUESTION.test(latest) || verification)) ||
    (verification && EMAIL_SURFACE.test(recentContext));
  const availability =
    AVAILABILITY_SURFACE.test(latest) &&
    !namedSchedule &&
    (!EMAIL_SURFACE.test(latest) ||
      CALENDAR_SURFACE.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest)) &&
    (/\b(?:am i|are|check|do i|find|is|show|what|when|which)\b/i.test(latest) ||
      CALENDAR_TIME_REFERENCE.test(latest));

  if (!calendar && !email && !availability) return null;
  if (terms.length === 0 && email) terms = emailQueryTerms(hypothesis);

  // Named appointments are commonly confirmed in email before (or instead of)
  // appearing on a calendar. Search both configured sources without asking the
  // owner which provider/account contains the answer.
  const kind: PersonalReadKind =
    availability
      ? 'calendar'
      : namedSchedule || (calendar && email)
        ? 'calendar_email'
        : email
          ? 'email'
          : 'calendar';
  const firstToolName =
    availability
      ? 'calendar.availability'
      : kind === 'email'
        ? 'gmail.search'
        : kind === 'calendar_email' || terms.length > 0
          ? 'calendar.search_events'
          : 'calendar.list_events';

  const request: PersonalReadRequest = {
    kind,
    queryTerms: terms,
    firstToolName,
    requiresThreadRead:
      kind === 'calendar_email' ||
      (kind === 'email' &&
        (verification ||
          /\b(?:when|where|what time|details?|what does|what did)\b/i.test(latest))),
  };
  if (kind !== 'email') {
    request.timeWindow = resolveTimeWindow(
      contextualQuery ? `${latest}\n${recentContext}` : latest,
      kind,
      terms.length > 0,
      options,
    );
  }
  if (kind !== 'calendar') {
    request.mailQuery = gmailQuery(hypothesis, terms);
  }
  if (options.timeZone) request.timeZone = options.timeZone;
  if (verification) request.verification = true;
  return request;
}

function succeeded(row: ReadToolEvidence): boolean {
  if (row.status !== 'succeeded') return false;
  if (!row.result || typeof row.result !== 'object') return true;
  const result = row.result as Record<string, unknown>;
  return result.ok !== false && !(typeof result.status === 'number' && result.status >= 400);
}

function attempts(evidence: ReadonlyArray<ReadToolEvidence>, toolName: string): number {
  return evidence.filter((row) => row.toolName === toolName).length;
}

function argsRecord(row: ReadToolEvidence): Record<string, unknown> | undefined {
  return row.args && typeof row.args === 'object' && !Array.isArray(row.args)
    ? (row.args as Record<string, unknown>)
    : undefined;
}

function queryIncludes(query: unknown, terms: string[]): boolean {
  if (terms.length === 0) return true;
  if (typeof query !== 'string') return false;
  const lower = query.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function matchingCalendarRead(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== request.firstToolName) return false;
  const args = argsRecord(row);
  if (Array.isArray(args?.calendarIds) && args.calendarIds.length > 0) return false;
  if (
    row.toolName === 'calendar.search_events' &&
    !queryIncludes(args?.query, request.queryTerms)
  ) {
    return false;
  }
  return (
    !request.timeWindow ||
    (args?.timeMin === request.timeWindow.timeMin && args?.timeMax === request.timeWindow.timeMax)
  );
}

function matchingGmailSearch(row: ReadToolEvidence, request: PersonalReadRequest): boolean {
  if (!succeeded(row) || row.toolName !== 'gmail.search') return false;
  const query = argsRecord(row)?.query;
  return request.mailQuery
    ? typeof query === 'string' && query.trim().toLowerCase() === request.mailQuery.toLowerCase()
    : queryIncludes(query, request.queryTerms);
}

export function gmailSearchThreadIds(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  const ids: string[] = [];
  for (const row of evidence) {
    if (
      !succeeded(row) ||
      row.toolName !== 'gmail.search' ||
      !row.result ||
      (request && !matchingGmailSearch(row, request))
    ) {
      continue;
    }
    const results = (row.result as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const id = (result as { threadId?: unknown }).threadId;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

export const MAX_GMAIL_THREADS_TO_READ = 3;

export function gmailThreadIdsToRead(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request?: PersonalReadRequest,
): string[] {
  return gmailSearchThreadIds(evidence, request).slice(0, MAX_GMAIL_THREADS_TO_READ);
}

function gmailReadThreadIds(evidence: ReadonlyArray<ReadToolEvidence>): string[] {
  return evidence
    .filter((row) => succeeded(row) && row.toolName === 'gmail.read_thread')
    .map((row) =>
      row.args && typeof row.args === 'object'
        ? (row.args as { threadId?: unknown }).threadId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
}

function gmailThreadAttempts(evidence: ReadonlyArray<ReadToolEvidence>, threadId: string): number {
  return evidence.filter(
    (row) =>
      row.toolName === 'gmail.read_thread' &&
      row.args &&
      typeof row.args === 'object' &&
      (row.args as { threadId?: unknown }).threadId === threadId,
  ).length;
}

function nextGmailThreadId(
  evidence: ReadonlyArray<ReadToolEvidence>,
  request: PersonalReadRequest,
): string | undefined {
  const targets = gmailThreadIdsToRead(evidence, request);
  const completed = new Set(gmailReadThreadIds(evidence));
  // Retry one isolated thread once. When several messages matched, inspect each
  // once so one broken thread cannot consume the whole task budget.
  const attemptsPerThread = targets.length === 1 ? 2 : 1;
  return targets.find(
    (threadId) =>
      !completed.has(threadId) && gmailThreadAttempts(evidence, threadId) < attemptsPerThread,
  );
}

/**
 * Return the next read that must happen before a personal-data answer may be
 * drafted. Source retries are bounded; the response contract then publishes
 * an honest coverage gap instead of looping or guessing.
 */
export function nextRequiredReadTool(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  const calendarSucceeded = evidence.some((row) => matchingCalendarRead(row, request));
  if (request.kind !== 'email' && !calendarSucceeded) {
    if (attempts(evidence, request.firstToolName) < 2) return request.firstToolName;
  }

  const gmailSearchSucceeded = evidence.some((row) => matchingGmailSearch(row, request));
  if (request.kind !== 'calendar' && !gmailSearchSucceeded) {
    if (attempts(evidence, 'gmail.search') < 2) return 'gmail.search';
    return undefined;
  }

  if (request.requiresThreadRead && gmailThreadIdsToRead(evidence, request).length > 0) {
    return nextGmailThreadId(evidence, request) ? 'gmail.read_thread' : undefined;
  }
  return undefined;
}

/** Runtime-owned bindings for a forced private read. */
export function groundReadToolInput(
  request: PersonalReadRequest,
  toolName: string,
  input: Record<string, unknown>,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Record<string, unknown> {
  if (toolName === 'calendar.list_events') {
    const { calendarIds: _ignored, ...allCalendars } = input;
    return {
      ...allCalendars,
      ...(request.timeWindow
        ? { timeMin: request.timeWindow.timeMin, timeMax: request.timeWindow.timeMax }
        : {}),
      maxResults: 50,
    };
  }
  if (toolName === 'calendar.search_events') {
    const { calendarIds: _ignored, ...allCalendars } = input;
    return {
      ...allCalendars,
      ...(request.timeWindow
        ? { timeMin: request.timeWindow.timeMin, timeMax: request.timeWindow.timeMax }
        : {}),
      ...(request.queryTerms.length > 0 ? { query: request.queryTerms.join(' ') } : {}),
      maxResults: 50,
    };
  }
  if (toolName === 'calendar.availability') {
    return request.timeWindow
      ? { timeMin: request.timeWindow.timeMin, timeMax: request.timeWindow.timeMax }
      : input;
  }
  if (toolName === 'gmail.search') {
    return {
      ...input,
      query: request.mailQuery || request.queryTerms.join(' ') || '-in:spam -in:trash',
      maxResults: 20,
    };
  }
  if (toolName === 'gmail.read_thread') {
    const target =
      nextGmailThreadId(evidence, request) ?? gmailThreadIdsToRead(evidence, request)[0];
    if (target) return { ...input, threadId: target };
  }
  return input;
}

/** Build exact forced-read arguments without asking a model to invent them. */
export function buildReadToolInput(
  request: PersonalReadRequest,
  toolName: string,
  evidence: ReadonlyArray<ReadToolEvidence>,
): Record<string, unknown> | null {
  if (toolName === 'calendar.list_events' && !request.timeWindow) return null;
  if (toolName === 'calendar.search_events' && request.queryTerms.length === 0) return null;
  if (toolName === 'calendar.availability' && !request.timeWindow) return null;
  if (toolName === 'gmail.read_thread' && !nextGmailThreadId(evidence, request)) return null;
  return groundReadToolInput(request, toolName, {}, evidence);
}
