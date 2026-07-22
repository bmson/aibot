import type { ModelMessage } from 'ai';

// A fetched page or read document is clipped to this before the model reasons
// over it; 4000 chars starved complex tasks. Both models in use have ample
// context (deepseek 64k+, Claude 200k), so the larger window is affordable and
// the checkpoint stays small because most tool results are far under the cap.
export const RESULT_CHAR_LIMIT = 8000;
export const CONTEXT_WINDOW_LIMIT = 60;

function truncateResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null);
  // Round-trip through JSON: results straight from tools may hold Date
  // instances (drizzle rows) or undefined props, which fail the AI SDK's
  // ModelMessage schema on the NEXT step's validation (checkpointed windows
  // don't hit this — jsonb already serialized them, which is why retries
  // succeeded where first attempts crashed).
  if (json.length <= RESULT_CHAR_LIMIT) return JSON.parse(json);
  return {
    truncated: true,
    note: `result truncated from ${json.length} chars; full result stored in tool_calls`,
    preview: json.slice(0, RESULT_CHAR_LIMIT),
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: unknown,
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: truncateResult(value) },
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
  window.push(toolResultMessage(toolCallId, toolName, value));
}

/**
 * Drop-oldest compaction: the storage bound and the model context bound in one.
 *
 * The slice must never begin on an orphaned tool-result — a `tool` message whose
 * originating tool-call (in an earlier assistant message) was dropped. Strict
 * providers (Azure, Anthropic) require one-to-one tool_use/tool_result pairing
 * and reject an unpaired leading tool-result, which dead-lettered resumed tasks.
 * A retained assistant tool-call is always safe: its result comes AFTER it, so it
 * is retained too. So it is sufficient to advance the cut past any leading `tool`
 * messages until the window starts on a real turn (or an assistant tool-call).
 */
export function compact(window: ModelMessage[]): ModelMessage[] {
  if (window.length <= CONTEXT_WINDOW_LIMIT) return window;
  let start = window.length - CONTEXT_WINDOW_LIMIT;
  while (start < window.length && window[start]?.role === 'tool') start += 1;
  return window.slice(start);
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
