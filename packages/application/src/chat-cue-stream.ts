import type { Cue, CueScanner } from '@assistant/core/chat-cues';

/**
 * The minimal chunk shape the pump needs. The real parts come from
 * `toUIMessageStream` and go back out through `writer.write`; typing them
 * loosely here keeps the pump testable without replaying the AI SDK's full
 * generic chunk union (the call site casts once, matching the existing
 * hand-pump precedent in chat-turn.ts).
 */
export type StreamChunk = { type: string } & Record<string, unknown>;

function cueChunk(cue: Cue): StreamChunk {
  return cue.kind === 'face'
    ? { type: 'data-face', data: { state: cue.state } }
    : cue.kind === 'theme'
      ? { type: 'data-theme', data: { name: cue.name } }
      : { type: 'data-chips', data: { labels: cue.labels } };
}

/**
 * Hand-pump a model UI-message stream while stripping companion cue tags.
 *
 * Text deltas pass through the scanner, so a tag split across arbitrary chunk
 * boundaries is still caught; each completed cue is written immediately as a
 * non-transient `data-*` chunk (no `id`, so every cue appends its own message
 * part), which is what lets the face react mid-stream. Everything that is not
 * message text is forwarded untouched.
 *
 * The scanner's chunking invariance guarantees the concatenated text written
 * here is byte-identical to `stripCueTags` of the full draft — which is what
 * onComplete persists, and what the client's exact-text dedupe relies on.
 * (The tool-less draft path emits a single text segment; the flush on
 * `text-end` assumes a tag never spans two separate text parts.)
 */
export async function pumpWithCues(
  parts: AsyncIterable<StreamChunk>,
  write: (chunk: StreamChunk) => void,
  scanner: CueScanner,
): Promise<Cue[]> {
  const collected: Cue[] = [];
  // Cues first: a push's exact tag position inside its delta is not recoverable
  // from the scanner result, and firing the expression just before the words it
  // colors is the better approximation (an opening [face:] lands before the
  // first words render). Relative order among cues is preserved either way.
  const emit = (scanned: { text: string; cues: Cue[] }, template: StreamChunk) => {
    for (const cue of scanned.cues) {
      collected.push(cue);
      write(cueChunk(cue));
    }
    if (scanned.text.length > 0) write({ ...template, type: 'text-delta', delta: scanned.text });
  };

  for await (const part of parts) {
    if (part.type === 'text-delta') {
      emit(scanner.push(String(part.delta ?? '')), part);
      continue;
    }
    if (part.type === 'text-end') {
      // End of the text: an unterminated tag comes out as literal prose
      // rather than vanishing — same as stripCueTags on the full draft.
      emit(scanner.flush(), { type: 'text-delta', id: part.id });
      write(part);
      continue;
    }
    write(part);
  }
  return collected;
}
