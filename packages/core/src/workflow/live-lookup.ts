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
