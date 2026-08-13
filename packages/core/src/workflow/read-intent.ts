/**
 * Deterministic routing for questions whose answer lives in the assistant's
 * Google accounts. These requests are deliberately not left to a cheap model
 * classifier: a false "conversation" or "clarify" verdict gives a tool-less
 * model room to invent a plausible calendar or inbox answer.
 */

export type PersonalReadKind = 'calendar' | 'email' | 'calendar_email';

export interface PersonalReadRequest {
  kind: PersonalReadKind;
  /** Literal subject terms to bind into calendar/Gmail searches. */
  queryTerms: string[];
  /** First read tool the executor must call. */
  firstToolName: 'calendar.list_events' | 'calendar.search_events' | 'gmail.search';
  /** A metadata-only Gmail hit is not enough to answer a detail question. */
  requiresThreadRead: boolean;
}

export interface ReadIntentMessage {
  role: string;
  content: unknown;
}

export interface ReadToolEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
}

const CALENDAR_SURFACE =
  /\b(?:calendars?|schedule|agenda|appointments?|events?|meetings?|interviews?|calls?|chats?|flights?|reservations?)\b/i;
const EMAIL_SURFACE = /\b(?:inbox|mailbox|e-?mails?|mail|messages?|threads?)\b/i;
const SCHEDULED_THING =
  /\b(interviews?|meetings?|appointments?|calls?|chats?|flights?|reservations?|bookings?|events?)\b/i;
const READ_OR_QUESTION =
  /\b(?:what|when|where|which|who|do i|did i|is there|are there|check|checked|look|find|found|search|searched|show|tell|review|reviewed|read|scan|open|pull up|bring up|see)\b/i;
const WHY_LOOKUP = /\bwhy\b/i;
const DAY_SCHEDULE =
  /\bwhat(?:(?:'|’)s| is)?\s+(?:happening|going on|coming up|planned|scheduled)\b|\bwhat\s+(?:am i|are we)\s+doing\b|\bwhat\s+do\s+i\s+have\s+(?:today|tomorrow|this|next|on)\b/i;
const VERIFY =
  /\b(?:are you sure|double[- ]check|verify|you checked|did you check|don(?:'|’)t see|do not see|not on my|why did you say|was that made up|made that up|is that real|actually there)\b/i;
const MUTATION_LEAD =
  /^\s*(?:(?:please|can you|could you|would you|i want you to)\s+)*(?:add|create|schedule|book|invite|cancel|delete|reschedule|move|update|edit|send|reply|forward|archive|label|mark)\b/i;

const QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'are',
  'at',
  'check',
  'did',
  'do',
  'does',
  'find',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'next',
  'of',
  'on',
  'our',
  'please',
  'said',
  'search',
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
  'video',
  'virtual',
  'wednesday',
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

function queryTerms(text: string): string[] {
  const nounMatch = SCHEDULED_THING.exec(text);
  if (!nounMatch?.[1]) return [];
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9'’-]+/g, ' ')
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 1 &&
          !QUERY_STOP_WORDS.has(word) &&
          !QUERY_MODIFIERS.has(word) &&
          !SCHEDULED_THING.test(word),
      );
  const after = text.slice(nounMatch.index + nounMatch[0].length);
  const related = /^\s*(?:with|at|for|from|to|about)\s+(.+)$/i.exec(after)?.[1];
  const specific = related
    ? words(related).slice(0, 2)
    : words(text.slice(0, nounMatch.index)).slice(-2);

  // Search on the named entity when one is present. Adding generic words such
  // as "interview", "upcoming", or "technical" makes Gmail's default AND
  // semantics miss otherwise-correct messages. Fall back to the appointment
  // noun only when the owner gave no distinguishing term.
  return [...new Set(specific.length > 0 ? specific : [nounMatch[1].toLowerCase()])];
}

/**
 * Identify private account lookups from the latest owner turn. Recent context
 * is used only for terse verification follow-ups such as "are you sure?".
 */
export function detectPersonalReadRequest(
  messages: ReadonlyArray<ReadIntentMessage>,
): PersonalReadRequest | null {
  let latestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex === -1) return null;
  const latest = contentText(messages[latestIndex]?.content).trim();
  if (
    !latest ||
    /^\s*i\s+(?:read|checked|reviewed|looked|searched|scanned|opened)\b/i.test(latest) ||
    (MUTATION_LEAD.test(latest) && !/\b(?:check|find|search|look|show)\b/i.test(latest))
  ) {
    return null;
  }

  const recentContext = messages
    .slice(Math.max(0, latestIndex - 4), latestIndex)
    .map((message) => contentText(message.content))
    .join('\n');
  const verification = VERIFY.test(latest);
  const terms = queryTerms(latest);
  const whyLookup =
    WHY_LOOKUP.test(latest) &&
    /\b(?:my|our|you said|said i|i had|i have|calendar|schedule)\b/i.test(latest);
  const personalSchedule =
    /\b(?:my|our|the|this|that|do i|did i|is there|are there)\b/i.test(latest) ||
    terms.some((term) => !SCHEDULED_THING.test(term));
  const namedSchedule =
    SCHEDULED_THING.test(latest) &&
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

  if (!calendar && !email) return null;

  // Named appointments are commonly confirmed in email before (or instead of)
  // appearing on a calendar. Search both configured sources without asking the
  // owner which provider/account contains the answer.
  const kind: PersonalReadKind =
    namedSchedule || (calendar && email) ? 'calendar_email' : email ? 'email' : 'calendar';
  const firstToolName =
    kind === 'email'
      ? 'gmail.search'
      : kind === 'calendar_email' || terms.length > 0
        ? 'calendar.search_events'
        : 'calendar.list_events';

  return {
    kind,
    queryTerms: terms,
    firstToolName,
    requiresThreadRead:
      kind === 'calendar_email' ||
      (kind === 'email' &&
        /\b(?:when|where|what time|details?|what does|what did)\b/i.test(latest)),
  };
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

function gmailSearchThreadIds(evidence: ReadonlyArray<ReadToolEvidence>): string[] {
  const ids: string[] = [];
  for (const row of evidence) {
    if (!succeeded(row) || row.toolName !== 'gmail.search' || !row.result) continue;
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

/**
 * Return the next read that must happen before a personal-data answer may be
 * drafted. Two failed attempts are enough; the response contract will then
 * publish an honest inability instead of looping or guessing.
 */
export function nextRequiredReadTool(
  request: PersonalReadRequest,
  evidence: ReadonlyArray<ReadToolEvidence>,
): string | undefined {
  const calendarSucceeded = evidence.some(
    (row) =>
      succeeded(row) &&
      (row.toolName === 'calendar.list_events' || row.toolName === 'calendar.search_events'),
  );
  if (request.kind !== 'email' && !calendarSucceeded) {
    return attempts(evidence, request.firstToolName) < 2 ? request.firstToolName : undefined;
  }

  const gmailSearchSucceeded = evidence.some(
    (row) => succeeded(row) && row.toolName === 'gmail.search',
  );
  if (request.kind !== 'calendar' && !gmailSearchSucceeded) {
    return attempts(evidence, 'gmail.search') < 2 ? 'gmail.search' : undefined;
  }

  const threadIds = gmailSearchThreadIds(evidence);
  const readThreadIds = new Set(gmailReadThreadIds(evidence));
  const threadReadSucceeded = threadIds.some((id) => readThreadIds.has(id));
  if (request.requiresThreadRead && threadIds.length > 0 && !threadReadSucceeded) {
    return attempts(evidence, 'gmail.read_thread') < 2 ? 'gmail.read_thread' : undefined;
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
    return allCalendars;
  }
  if (toolName === 'calendar.search_events') {
    const { calendarIds: _ignored, ...allCalendars } = input;
    return request.queryTerms.length > 0
      ? { ...allCalendars, query: request.queryTerms.join(' ') }
      : allCalendars;
  }
  if (toolName === 'gmail.search' && request.queryTerms.length > 0) {
    return { ...input, query: request.queryTerms.join(' ') };
  }
  if (toolName === 'gmail.read_thread') {
    const ids = gmailSearchThreadIds(evidence);
    const requested = typeof input.threadId === 'string' ? input.threadId : '';
    if (ids.length > 0 && !ids.includes(requested)) return { ...input, threadId: ids[0] };
  }
  return input;
}
