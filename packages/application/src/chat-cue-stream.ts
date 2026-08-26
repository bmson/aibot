import type { Cue, CueScanner } from '@assistant/core/chat-cues';

/**
 * The minimal chunk shape the pump needs. The real parts come from
 * `toUIMessageStream` and go back out through `writer.write`; typing them
 * loosely here keeps the pump testable without replaying the AI SDK's full
 * generic chunk union (the call site casts once, matching the existing
 * hand-pump precedent in chat-turn.ts).
 */
export type StreamChunk = { type: string } & Record<string, unknown>;

function cueChunk(cue: Cue): StreamChunk | null {
  return cue.kind === 'face'
    ? { type: 'data-face', data: { state: cue.state } }
    : cue.kind === 'theme'
      ? { type: 'data-theme', data: { name: cue.name } }
      : cue.kind === 'chips'
        ? { type: 'data-chips', data: { labels: cue.labels } }
        : null; // a break is a bubble boundary, not an overlay — handled positionally below
}

/**
 * Hand-pump a model UI-message stream while stripping companion cue tags.
 *
 * Text deltas pass through the scanner, so a tag split across arbitrary chunk
 * boundaries is still caught; each completed overlay cue is written
 * immediately as a non-transient `data-*` chunk (no `id`, so every cue
 * appends its own message part), which is what lets the face react
 * mid-stream. Everything that is not message text is forwarded untouched.
 *
 * A `[break]` cue ends the current text block mid-stream (`text-end`) and
 * opens a fresh one (`text-start`), so the client renders the rest of the
 * reply as its own bubble; a `data-break` chunk accompanies the split so the
 * iOS client — which reads cues, not block ids — mirrors the same boundary.
 * Break offsets are in the scanner's cumulative coordinates; this pump's own
 * counter converts them into this push's local ones.
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
  // The currently open text block's id. The incoming stream names it; after a
  // break the pump names the continuation, so the stream's own trailing
  // text-end always closes whichever block is open by then.
  let currentTextId: string | null = null;
  let breakCount = 0;
  // Total scanner-output text forwarded so far — converts the scanner's
  // cumulative break offsets into this push's local slice points.
  let forwardedText = 0;

  // Cues first: a push's exact tag position inside its delta is not
  // recoverable from the scanner result, and firing the expression just
  // before the words it colors is the better approximation (an opening
  // [face:] lands before the first words render). Overlay order is preserved
  // either way; only breaks interleave positionally with text.
  const emit = (scanned: { text: string; cues: Cue[] }, template: StreamChunk) => {
    for (const cue of scanned.cues) {
      collected.push(cue);
      const chunk = cueChunk(cue);
      if (chunk) write(chunk);
    }
    const text = scanned.text;
    const breaks = scanned.cues
      .filter((cue): cue is Extract<Cue, { kind: 'break' }> => cue.kind === 'break')
      .map((cue) => cue.at - forwardedText)
      .filter((at) => at >= 0 && at <= text.length)
      .sort((a, b) => a - b);

    let cursor = 0;
    const writeDelta = (delta: string) => {
      if (delta.length === 0) return;
      const id = currentTextId ?? String(template.id ?? '');
      write({ ...template, type: 'text-delta', id, delta });
    };
    for (const localAt of breaks) {
      writeDelta(text.slice(cursor, localAt));
      const closedId = currentTextId ?? String(template.id ?? '');
      write({ type: 'text-end', id: closedId });
      breakCount += 1;
      currentTextId = `${closedId}:break-${breakCount}`;
      write({ type: 'text-start', id: currentTextId });
      write({ type: 'data-break', data: {} });
      cursor = localAt;
    }
    writeDelta(text.slice(cursor));
    forwardedText += text.length;
  };

  for await (const part of parts) {
    if (part.type === 'text-start') {
      currentTextId = String(part.id ?? '');
      write(part);
      continue;
    }
    if (part.type === 'text-delta') {
      emit(scanner.push(String(part.delta ?? '')), part);
      continue;
    }
    if (part.type === 'text-end') {
      // End of the text: an unterminated tag comes out as literal prose
      // rather than vanishing — same as stripCueTags on the full draft.
      emit(scanner.flush(), { type: 'text-delta', id: currentTextId ?? part.id });
      // Close whichever block is open — after a break that is the
      // continuation, not the id this chunk arrived with.
      write({ ...part, id: currentTextId ?? part.id });
      currentTextId = null;
      continue;
    }
    write(part);
  }
  return collected;
}
