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

/** Drop-oldest compaction (v1): the storage bound and the model context bound in one. */
export function compact(window: ModelMessage[]): ModelMessage[] {
  return window.length <= CONTEXT_WINDOW_LIMIT
    ? window
    : window.slice(window.length - CONTEXT_WINDOW_LIMIT);
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
