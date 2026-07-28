import type { ModelMessage } from 'ai';

/**
 * Default clip for a tool result before the model reasons over it. Read-heavy
 * tools get a larger, per-tool limit below: clipping a fetched page or a mail
 * thread to 8 KB paid for content the model never saw, which starved research
 * tasks and invited guessing. The checkpoint stays bounded because the full
 * result lives in its tool_calls row, which `tools.read_result` can page
 * through on demand.
 */
export const RESULT_CHAR_LIMIT = 8_000;
const RESULT_CHAR_LIMITS: Readonly<Record<string, number>> = {
  'web.fetch': 24_000,
  'gmail.read_thread': 24_000,
  'docs.get': 24_000,
  'drive.read': 24_000,
  'sheets.get_rows': 24_000,
  'documents.search': 16_000,
  'tools.read_result': 32_000,
};

export function resultCharLimit(toolName: string): number {
  return RESULT_CHAR_LIMITS[toolName] ?? RESULT_CHAR_LIMIT;
}

export const CONTEXT_WINDOW_LIMIT = 60;
/**
 * Estimated-token budget for the compacted tail. Bounding by message count
 * alone let 60 large results add up to hundreds of KB — enough to overflow a
 * fallback model's real context and to make a single step's cost reservation
 * exceed a task budget. Chars-per-token ≈ 3.5 for English prose and JSON.
 */
export const CONTEXT_TOKEN_BUDGET = 25_000;
const CHARS_PER_TOKEN = 3.5;
const CONTEXT_CHAR_BUDGET = CONTEXT_TOKEN_BUDGET * CHARS_PER_TOKEN;

function messageChars(message: ModelMessage | undefined): number {
  return message ? JSON.stringify(message).length : 0;
}

function truncateResult(toolName: string, result: unknown, dbToolCallId?: string): unknown {
  const json = JSON.stringify(result ?? null);
  const limit = resultCharLimit(toolName);
  // Round-trip through JSON: results straight from tools may hold Date
  // instances (drizzle rows) or undefined props, which fail the AI SDK's
  // ModelMessage schema on the NEXT step's validation (checkpointed windows
  // don't hit this — jsonb already serialized them, which is why retries
  // succeeded where first attempts crashed).
  if (json.length <= limit) return JSON.parse(json);
  return {
    truncated: true,
    // Only claim the remainder is reachable when this call has a durable row
    // the read tool can address; a false promise of retrievability is an
    // invitation to hallucinate a retrieval path.
    note: dbToolCallId
      ? `result truncated from ${json.length} chars; read more with tools.read_result({ toolCallId: "${dbToolCallId}", offset: ${limit} })`
      : `result truncated from ${json.length} chars; the remainder is not retrievable`,
    preview: json.slice(0, limit),
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: unknown,
  options?: { dbToolCallId?: string },
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: truncateResult(toolName, value, options?.dbToolCallId) },
      },
    ],
  } as ModelMessage;
}

/**
 * Stitch the terminal result for a tool call into the transcript exactly once.
 *
 * Older checkpoints may contain provisional `awaiting_owner_approval` or
 * `background_job_running` results. Replaying one of those beside the real
 * result is invalid for providers that require a one-to-one tool_use/result
 * pairing, so settling a call replaces every earlier result with the same id.
 */
export function replaceToolResultMessage(
  window: ModelMessage[],
  toolCallId: string,
  toolName: string,
  value: unknown,
  options?: { dbToolCallId?: string },
): void {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const message = window[index];
    if (message?.role !== 'tool' || !Array.isArray(message.content)) continue;
    const content = message.content.filter(
      (part) => !(part.type === 'tool-result' && part.toolCallId === toolCallId),
    );
    if (content.length === message.content.length) continue;
    if (content.length === 0) {
      window.splice(index, 1);
    } else {
      window[index] = { ...message, content } as ModelMessage;
    }
  }
  window.push(toolResultMessage(toolCallId, toolName, value, options));
}

/**
 * Drop-oldest compaction bounded by BOTH message count and estimated tokens.
 *
 * The slice must never begin on an orphaned tool-result — a `tool` message whose
 * originating tool-call (in an earlier assistant message) was dropped. Strict
 * providers (Azure, Anthropic) require one-to-one tool_use/tool_result pairing
 * and reject an unpaired leading tool-result, which dead-lettered resumed tasks.
 * A retained assistant tool-call is always safe: its result comes AFTER it, so it
 * is retained too. So it is sufficient to advance the cut past any leading `tool`
 * messages until the window starts on a real turn (or an assistant tool-call).
 *
 * The first user message (the original instruction) is PINNED: a long task must
 * not lose "what am I doing and why" to drop-oldest. Goal sessions re-seed the
 * instruction each run, but an adhoc/mission/email task has only this copy in
 * the window, and without it later steps drift once it ages out. Prepending a
 * lone user message never breaks pairing (it carries no tool-call).
 */
export function compact(window: ModelMessage[]): ModelMessage[] {
  const totalChars = window.reduce((sum, message) => sum + messageChars(message), 0);
  if (window.length <= CONTEXT_WINDOW_LIMIT && totalChars <= CONTEXT_CHAR_BUDGET) return window;

  const firstUserIndex = window.findIndex((m) => m.role === 'user');
  const pin = firstUserIndex >= 0 ? window[firstUserIndex] : undefined;

  // Leave room for the pinned instruction so the totals still respect both bounds.
  const tailMessageBudget = pin ? CONTEXT_WINDOW_LIMIT - 1 : CONTEXT_WINDOW_LIMIT;
  const tailCharBudget = Math.max(0, CONTEXT_CHAR_BUDGET - messageChars(pin));

  // Walk back from the newest message until either bound is spent. The newest
  // message is always kept, whatever its size — it is the turn being answered.
  let start = window.length;
  let chars = 0;
  while (start > 0 && window.length - start < tailMessageBudget) {
    const next = messageChars(window[start - 1]);
    if (window.length - start >= 1 && chars + next > tailCharBudget) break;
    chars += next;
    start -= 1;
  }
  while (start < window.length && window[start]?.role === 'tool') start += 1;
  const tail = window.slice(start);

  // If the instruction already survived inside the tail, return it unchanged.
  if (!pin || start <= firstUserIndex) return tail;
  return [pin, ...tail];
}

/** Latest direct owner wording, used only for deterministic artifact routing. */
export function latestUserText(window: ModelMessage[]): string | undefined {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}
