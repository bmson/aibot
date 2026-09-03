/**
 * The work behind an answer card, as a trail the card itself can carry.
 *
 * A composed card is assembled from tool results the owner never asked to see:
 * the mailbox search, the thread it opened, the confirmation it read. Rendering
 * each of those as its own card in the thread answered one question with three
 * surfaces, two of which were the assistant's homework. The runtime folds them
 * into this list instead — one line per call, in execution order — so the
 * provenance stays reachable from inside the card that used it.
 *
 * Nothing here is model-authored: every field is read off the durable tool
 * ledger, the same ledger the response contract checks the prose against.
 */
import type { ActionEvidence } from './response-contract.js';

export interface ResponseCardStep {
  /**
   * The dotted tool name. Clients name the step in their own user-facing
   * vocabulary — the web's `stepActionLabel` — and never show this.
   */
  tool: string;
  /** What came back, counted in the result's own units: "1 result". */
  count?: string;
  /** The query string or subject line this call worked on. */
  detail?: string;
  /** Set when the call did not succeed, so the row can say so. */
  failed?: boolean;
  /** Why it failed, clipped. Shown in place of the count. */
  error?: string;
}

const DETAIL_LIMIT = 160;
const ERROR_LIMIT = 120;
/**
 * The list scrolls inside the card rather than growing it, so a long trail
 * costs the reader nothing — but a payload rides on every message, so it stops
 * well before a runaway agentic session could bloat one.
 */
const STEP_LIMIT = 20;

/**
 * A call the owner could have watched happen. `proposed` and `executing` rows
 * are a step loop caught mid-stride and describe no completed work; counting
 * them would put a step in the trail that produced nothing.
 */
const PERFORMED = new Set(['succeeded', 'failed', 'denied']);

/** Result collections, with the noun each is counted in. */
const COLLECTIONS: Array<[field: string, singular: string, plural: string]> = [
  ['results', 'result', 'results'],
  ['messages', 'message', 'messages'],
  ['events', 'event', 'events'],
  ['files', 'file', 'files'],
  ['passages', 'passage', 'passages'],
  ['relationships', 'connection', 'connections'],
  ['reminders', 'reminder', 'reminders'],
  ['memories', 'memory', 'memories'],
  ['contacts', 'contact', 'contacts'],
  ['busy', 'busy block', 'busy blocks'],
  ['rows', 'row', 'rows'],
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

/** "1 result", "3 messages" — the first collection the result actually carries. */
function countOf(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  for (const [field, singular, plural] of COLLECTIONS) {
    const value = result[field];
    if (!Array.isArray(value)) continue;
    return `${value.length} ${value.length === 1 ? singular : plural}`;
  }
  return undefined;
}

/**
 * The one line that says WHICH search or message this was. Arguments come
 * first: they are what the owner would recognise, and they exist even when a
 * call came back empty.
 */
function detailOf(
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string | undefined {
  const firstMessage = Array.isArray(result?.messages) ? record(result.messages[0]) : undefined;
  const candidate =
    string(args?.query) ||
    string(result?.query) ||
    string(args?.subject) ||
    string(firstMessage?.subject) ||
    string(result?.subject) ||
    string(args?.title) ||
    string(result?.title) ||
    string(args?.text) ||
    string(args?.url) ||
    string(result?.url);
  return candidate ? clip(candidate, DETAIL_LIMIT) : undefined;
}

/**
 * The steps behind one turn's answer, oldest first.
 *
 * Only this task's ledger: rows carried forward from earlier turns in the same
 * conversation are context the contract may read, not work this answer did.
 */
export function responseCardSteps(evidence: ActionEvidence[]): ResponseCardStep[] {
  return evidence
    .filter((row) => row.fromCurrentTask !== false && PERFORMED.has(row.status))
    .toSorted((a, b) => (a.step ?? 0) - (b.step ?? 0))
    .slice(0, STEP_LIMIT)
    .map((row) => {
      const result = record(row.result);
      const args = record(row.args);
      const detail = detailOf(args, result);
      if (row.status === 'succeeded') {
        return {
          tool: row.toolName,
          ...(countOf(result) ? { count: countOf(result) } : {}),
          ...(detail ? { detail } : {}),
        };
      }
      const error = row.status === 'denied' ? 'Not approved' : clip(string(row.error), ERROR_LIMIT);
      return {
        tool: row.toolName,
        failed: true,
        ...(error ? { error } : {}),
        ...(detail ? { detail } : {}),
      };
    });
}
