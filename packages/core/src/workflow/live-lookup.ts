import {
  detectPersonalReadRequest,
  type ReadIntentMessage,
  readIntentText,
} from './read-intent.js';
import type { ActionEvidence } from './response-contract.js';

export type LiveLookup = { kind: 'weather' | 'web'; request: string };

const QUESTION = /^(?:how|what|who|when|where|will|is|are|any|do|does|should|can|could)\b/i;
const WEATHER = /\b(?:weather|forecast|temperature|rain|raining|snow|snowing)\b/i;
const SEARCH =
  /\b(?:look (?:it |that |this )up|search (?:the web|online|for)|check (?:the )?(?:score|wcore)|verify (?:it|that|this))\b/i;
const CURRENT = /\b(?:current|currently|latest|live|right now|today|tonight|tomorrow)\b/i;
const PUBLIC_FACT =
  /\b(?:president|prime minister|ceo|score|standings|weather|forecast|price|news|hiring|jobs?)\b/i;
const CORRECTION =
  /^(?:look it up|search the web|check (?:the )?(?:score|wcore)|run it|rub it|try again|check again)\b/i;

/** Routing alone grants no authority: every lookup still uses the dispatcher. */
export function detectLiveLookup(
  history: ReadonlyArray<ReadIntentMessage>,
): LiveLookup | undefined {
  const users = history.filter((m) => m.role === 'user').map(readIntentText);
  const request = users.at(-1)?.trim() ?? '';
  if (!request || /^(?:don't|do not|never)\b/i.test(request)) return undefined;
  if (/\b(?:password|passcode|wifi|wi-fi|API key)\b/i.test(request)) return undefined;
  const asks = QUESTION.test(request) || request.includes('?') || SEARCH.test(request);
  if (WEATHER.test(request) && asks) return { kind: 'weather', request };
  if (detectPersonalReadRequest(history)) return undefined;
  if (/\binvestigate\b[\s\S]*\b(?:team|club|company|match)\b/i.test(request))
    return { kind: 'web', request };
  if (SEARCH.test(request) || (asks && CURRENT.test(request) && PUBLIC_FACT.test(request))) {
    const previous = users.slice(-4, -1).findLast((text) => !CORRECTION.test(text));
    if (
      CORRECTION.test(request) &&
      previous &&
      detectPersonalReadRequest([{ role: 'user', content: previous }])
    )
      return undefined;
    return { kind: 'web', request: CORRECTION.test(request) && previous ? previous : request };
  }
  // An address supplied in answer to a weather clarification continues that
  // lookup; a city/address alone is not a standalone weather request.
  const previous = history.slice(0, -1).at(-1);
  if (
    previous?.role === 'assistant' &&
    /\b(?:provide|what|which|where|location|address)\b/i.test(readIntentText(previous)) &&
    WEATHER.test(readIntentText(previous)) &&
    !QUESTION.test(request)
  )
    return {
      kind: 'weather',
      request: `${users.at(-2) ?? 'Check the weather'}\nLocation: ${request}`,
    };
  if (CORRECTION.test(request)) {
    const prior = detectLiveLookup(history.slice(0, -1));
    if (prior) return prior;
  }
  if (
    /\b(?:find|recommend|where should|where can)\b/i.test(request) &&
    /\b(?:eat|restaurant|dining|apply|companies|hiring|jobs)\b/i.test(request)
  )
    return { kind: 'web', request };
  return undefined;
}

export function successfulLookup(row: ActionEvidence): boolean {
  const result = row.result as Record<string, unknown> | null;
  return (
    row.fromCurrentTask !== false &&
    row.status === 'succeeded' &&
    Boolean(result) &&
    Object.keys(result ?? {}).length > 0 &&
    !result?.error &&
    (row.toolName !== 'web.fetch' ||
      (typeof result?.text === 'string' && result.text.trim().length > 0)) &&
    result?.ok !== false &&
    !(typeof result?.status === 'number' && result.status >= 400)
  );
}

/** Search snippets are discovery, not a complete live-score or research read. */
export function nextLiveLookup(
  lookup: LiveLookup,
  evidence: ActionEvidence[],
): { toolName: string; input?: Record<string, unknown> } | undefined {
  const rows = evidence.filter((row) => row.fromCurrentTask !== false);
  if (lookup.kind === 'weather') {
    if (!rows.some((row) => row.toolName === 'weather.lookup'))
      return { toolName: 'weather.lookup' };
    return undefined;
  }
  const searches = rows.filter((row) => row.toolName === 'web.search');
  if (!searches.length && !rows.some((row) => row.toolName === 'web.fetch'))
    return { toolName: 'web.search', input: { query: lookup.request, count: 5 } };
  if (rows.some((row) => row.toolName === 'web.fetch')) return undefined;
  for (const row of searches.filter(successfulLookup)) {
    const results = (row.result as { results?: Array<{ url?: string }> }).results;
    const url = results?.find((item) => /^https?:\/\//i.test(item.url ?? ''))?.url;
    if (url) return { toolName: 'web.fetch', input: { url } };
  }
  return undefined;
}

/**
 * The text a live lookup actually retrieved, as one searchable corpus.
 *
 * Search *snippets* are deliberately included alongside fetched bodies: the
 * Giants case turned on a snippet figure ("7-3") that was a batted-ball stat
 * rather than the score, and a check that treated the snippet as unseen would
 * have called the right answer ungrounded.
 */
function retrievedCorpus(evidence: ActionEvidence[]): string {
  return evidence
    .filter(successfulLookup)
    .map((row) => {
      const result = row.result as Record<string, unknown> | null;
      const parts = [result?.text, result?.snippet, result?.summary, result?.title];
      const results = (result?.results as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of results) parts.push(item.snippet, item.title, item.description);
      // Weather adapters return numbers, not prose; stringify so a temperature
      // reading is searchable in the same corpus as fetched text.
      if (row.toolName === 'weather.lookup') parts.push(JSON.stringify(result));
      return parts.filter((part) => typeof part === 'string').join('\n');
    })
    .join('\n');
}

/** Digits only, so "5 - 4", "5–4" and "5-4" all compare equal. */
const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * A scoreline (`5-4`, `5–4`) or a temperature (`72°F`, `-3C`) in the draft.
 *
 * Narrow on purpose. A general "every number must appear in the source" rule
 * would fire on every figure the model legitimately derives — a count of list
 * items, "10-15 minutes", a date it computed from "tomorrow" — and a false
 * positive here replaces a correct answer with a refusal. These two shapes are
 * the ones the September audit actually got wrong, they are never arithmetic
 * the assistant should be doing itself, and they are exactly the claims an
 * owner cannot check without re-doing the lookup.
 */
const SCORE_FIGURE = /\b(\d{1,3})\s*[-–—]\s*(\d{1,3})\b/g;
const TEMPERATURE_FIGURE = /(-?\d{1,3})\s*°\s*[CF]?\b|\b(-?\d{1,3})\s*degrees\b/gi;
/** A request whose answer is a scoreline, so the score rule is worth running. */
const SCORE_REQUEST = /\b(?:score|final|beat|won|lost|standings)\b/i;
/** Dates and version-like runs are not scorelines. */
const DATE_LIKE = /\d{4}\s*[-–—]\s*\d{1,2}|\d{1,2}\s*[-–—]\s*\d{1,2}\s*[-–—]\s*\d{2,4}/;
/**
 * A unit right after the figure makes it a quantity, not a result: "10-15
 * minutes" is the assistant estimating, which it is entitled to do and which no
 * retrieved source would ever contain. Without this the rule refuses correct
 * answers, which is worse than the defect it exists to catch.
 */
const RANGE_UNIT =
  /^\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?|people|items?|percent|%|dollars?|euros?|miles?|kms?|km|degrees?)\b/i;

/**
 * A figure the answer asserts that the retrieved sources never contained.
 *
 * `liveLookupFailure` below proves a lookup *happened*; nothing proved the
 * answer matched it, which is how a stale training-data score reached the owner
 * over a successful fetch that said otherwise. This closes that specific gap
 * the way `groundReadDraft` closes it for calendar reads: compare the claim
 * against the literal evidence, and refuse rather than guess.
 */
export function ungroundedLiveFigure(
  lookup: LiveLookup,
  text: string,
  evidence: ActionEvidence[],
): string | undefined {
  const rows = evidence.filter((row) => row.fromCurrentTask !== false);
  const corpus = retrievedCorpus(rows);
  if (!corpus.trim()) return undefined;
  const corpusDigits = corpus.replace(/[^\d]+/g, ' ');

  if (lookup.kind === 'weather') {
    for (const match of text.matchAll(TEMPERATURE_FIGURE)) {
      const reading = match[1] ?? match[2];
      if (!reading) continue;
      if (!new RegExp(`(?:^|\\s)-?${digitsOf(reading)}(?:\\s|$)`).test(corpusDigits))
        return `The retrieved weather data does not contain ${reading}°, so I have not reported a temperature I cannot show you. The lookup needs to be retried.`;
    }
    return undefined;
  }

  if (!SCORE_REQUEST.test(lookup.request)) return undefined;
  for (const match of text.matchAll(SCORE_FIGURE)) {
    const [whole, left, right] = match;
    if (!left || !right || DATE_LIKE.test(whole)) continue;
    // The match may be the tail of a longer run the pattern cannot see from
    // the inside: `2026-09-07` offers up `09-07`, which is a date, not a
    // result. Judge by what sits either side of it.
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + whole.length);
    if (/[\d\-–—]\s*$/.test(before) || /^\s*[-–—]\s*\d/.test(after)) continue;
    if (RANGE_UNIT.test(after)) continue;
    // Accept either order: sources state a result home-first as often as not.
    const stated = new RegExp(`${left}\\s+${right}|${right}\\s+${left}`);
    if (!stated.test(corpusDigits))
      return `The sources I retrieved do not state ${left}-${right}, so I have not reported a result they do not support. The lookup needs to be retried.`;
  }
  return undefined;
}

export function liveLookupFailure(
  lookup: LiveLookup,
  evidence: ActionEvidence[],
): string | undefined {
  const names = lookup.kind === 'weather' ? ['weather.lookup'] : ['web.fetch'];
  const rows = evidence.filter(
    (row) => names.includes(row.toolName) && row.fromCurrentTask !== false,
  );
  if (rows.some(successfulLookup)) return undefined;
  return lookup.kind === 'weather'
    ? "I couldn't retrieve current weather data for this request, so I can't confirm temperatures or a forecast. Earlier weather replies are not a current reading."
    : "I couldn't retrieve live sources for this request, so I haven't verified the answer. The lookup needs to be retried.";
}
