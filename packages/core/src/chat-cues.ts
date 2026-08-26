import { z } from 'zod';

/**
 * Companion cue vocabulary for the dashboard chat (prompt v22; v30 added
 * `[break]`; facial cues remain decodable for older persisted messages).
 *
 * The model embeds `[face: ...]`, `[theme: ...]`, `[action_chips: ...]`, and
 * `[break]` tags in its reply text; the streaming pump and the executor's
 * finalize step strip them with the scanner below and re-emit them as
 * structured message parts, so the tags never reach the reader,
 * `messages.text` (and with it the rebuilt model history, SMS, and email
 * bodies) stays clean, and the streamed text remains byte-identical to the
 * persisted text that client-side dedupe matches on.
 *
 * `[break]` is the one POSITIONAL cue: it splits the reply into separate chat
 * bubbles at the exact point the tag appears. The scanner records the output
 * offset it fired at (`at`), so the live pump and the persisted parts split
 * at the same byte positions — both sides keep every slice verbatim
 * (whitespace-only slices included) so the concatenated text stays identical.
 *
 * The client keeps its own copy of these value lists in
 * `apps/web/lib/chat-cues.ts` (the boundary rules bar the web app from
 * importing core); drift between the copies degrades gracefully — the UI
 * ignores values it does not know.
 */

export const FACE_STATES = [
  'neutral',
  'warm_smile',
  'happy_squint',
  'curious_blink',
  'thoughtful_tilt',
  'wide_excited',
  'gentle_nod',
  'focused',
] as const;
export type FaceState = (typeof FACE_STATES)[number];

export const THEME_NAMES = ['default', 'warm_amber', 'soft_rose', 'cool_sky'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
/**
 * How many recent assistant messages a `[theme:]` cue reaches forward over.
 *
 * The mood is derived from the log rather than stored, so without a bound it
 * held for the whole loaded window (the newest 100 messages) and then vanished
 * the moment the cue scrolled out — a color change with no message behind it.
 * Bounding the lookback lets a mood cover a normal exchange and then decay on a
 * boundary the owner can actually see.
 */
export const THEME_LOOKBACK = 8;

export const MAX_CHIPS = 4;
export const MAX_CHIP_LABEL = 60;
// A maximal well-formed action_chips tag (four quoted 60-char labels plus
// separators) runs just under 280 characters; the bound exists so an unclosed
// "[face:" cannot swallow the rest of a reply while the scanner waits for "]".
export const MAX_TAG_LEN = 320;

export const CueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('face'), state: z.enum(FACE_STATES) }),
  z.object({ kind: z.literal('theme'), name: z.enum(THEME_NAMES) }),
  z.object({
    kind: z.literal('chips'),
    labels: z.array(z.string().min(1).max(MAX_CHIP_LABEL)).min(1).max(MAX_CHIPS),
  }),
  // Positional: `at` is the byte offset in the stripped output where the
  // bubble boundary fell. Not parsed out of the tag — the scanner stamps it.
  z.object({ kind: z.literal('break'), at: z.number().int().nonnegative() }),
]);
export type Cue = z.infer<typeof CueSchema>;

/** The break tag is a fixed literal with no value — the only self-closing cue. */
const BREAK_TAG = '[break]';

const OPENERS = ['[face:', '[theme:', '[action_chips:', BREAK_TAG] as const;

const FACE_TAG = /^\[face:[ \t]*([a-z_]{1,32})[ \t]*\]$/;
const THEME_TAG = /^\[theme:[ \t]*([a-z_]{1,32})[ \t]*\]$/;
const CHIPS_TAG =
  /^\[action_chips:[ \t]*"[^"\]\n]{1,60}"(?:[ \t]*\|[ \t]*"[^"\]\n]{1,60}")*[ \t]*\]$/;
const CHIP_LABEL = /"([^"\]\n]{1,60})"/g;

/** A recognized, closed tag → its cue; null when the value is unknown. */
function parseTag(tag: string): Cue | null {
  const face = FACE_TAG.exec(tag);
  if (face) {
    const state = face[1] as string;
    return (FACE_STATES as readonly string[]).includes(state)
      ? { kind: 'face', state: state as FaceState }
      : null;
  }
  const theme = THEME_TAG.exec(tag);
  if (theme) {
    const name = theme[1] as string;
    return (THEME_NAMES as readonly string[]).includes(name)
      ? { kind: 'theme', name: name as ThemeName }
      : null;
  }
  if (CHIPS_TAG.test(tag)) {
    const labels = [...tag.matchAll(CHIP_LABEL)]
      .map((match) => (match[1] as string).trim())
      .filter((label) => label.length > 0)
      .slice(0, MAX_CHIPS);
    return labels.length > 0 ? { kind: 'chips', labels } : null;
  }
  return null;
}

export interface CueScanner {
  /** Feed the next chunk; returns the text safe to emit and any completed cues. */
  push(chunk: string): { text: string; cues: Cue[] };
  /** End of stream: any held-back partial tag comes out as literal text. One-shot. */
  flush(): { text: string; cues: Cue[] };
}

/**
 * Incremental cue-tag stripper.
 *
 * The invariant that everything downstream leans on: the concatenated output
 * for a given input is the same for EVERY chunking of that input, so the
 * streamed text and the full-text `stripCueTags` of the persisted reply are
 * byte-identical — which is what `retireProvisionalReplies` dedupes on.
 *
 * Rules: a tag must open with a recognized keyword and close with `]` on the
 * same line within MAX_TAG_LEN. Anything meeting that is stripped — even with
 * an unknown value (robot syntax never reaches the reader; an unknown value
 * just animates nothing). Anything else in brackets (markdown links,
 * citations, a missing colon, an unknown keyword, a newline inside) passes
 * through untouched, and an unterminated tag at end of stream is flushed as
 * literal text rather than silently dropped.
 */
export function createCueScanner(): CueScanner {
  // Tail that may still become a tag: a proper prefix of an opener, or a
  // recognized open tag awaiting its `]`.
  let held = '';
  // Whitespace repair after a consumed tag ('line' also swallows one newline
  // when the tag opened a line); part of scanner state so it survives chunk
  // boundaries.
  let skip: 'none' | 'spaces' | 'line' = 'none';
  // Last emitted character ('' at start of stream) — picks the repair mode.
  let last = '';
  // Total text emitted across ALL pushes — a break cue's `at` is in these
  // cumulative coordinates, so chunked streaming and whole-text stripping
  // record identical positions.
  let emittedTotal = 0;

  const scan = (work: string): { text: string; cues: Cue[] } => {
    held = '';
    let out = '';
    const cues: Cue[] = [];
    let i = 0;

    const emit = (piece: string) => {
      if (piece.length === 0) return;
      out += piece;
      emittedTotal += piece.length;
      last = piece[piece.length - 1] as string;
    };

    while (i < work.length) {
      const ch = work[i] as string;

      if (skip !== 'none') {
        if (ch === ' ' || ch === '\t') {
          i += 1;
          continue;
        }
        if (skip === 'line' && ch === '\n') {
          skip = 'none';
          i += 1;
          continue;
        }
        skip = 'none';
        continue;
      }

      if (ch !== '[') {
        const bracket = work.indexOf('[', i);
        const end = bracket === -1 ? work.length : bracket;
        emit(work.slice(i, end));
        i = end;
        continue;
      }

      const rest = work.slice(i);
      const opener = OPENERS.find((candidate) => rest.startsWith(candidate));
      if (!opener) {
        if (OPENERS.some((candidate) => candidate.startsWith(rest))) {
          // Could still become an opener — hold the tail for the next chunk.
          held = rest;
          return { text: out, cues };
        }
        emit(ch);
        i += 1;
        continue;
      }

      // [break] carries no value: it marks a bubble boundary at this exact
      // output position. A break before any text is a no-op; an inline one
      // (no newline before the tag) still never glues words in the plain
      // text that history and SMS read.
      if (opener === BREAK_TAG) {
        if (emittedTotal > 0) {
          cues.push({ kind: 'break', at: emittedTotal });
          if (last !== '\n') emit('\n');
        }
        skip = 'line';
        i += BREAK_TAG.length;
        continue;
      }

      const close = rest.indexOf(']');
      const newline = rest.indexOf('\n');
      if (close === -1 && newline === -1 && rest.length <= MAX_TAG_LEN) {
        held = rest; // open tag, still growing
        return { text: out, cues };
      }
      if (close === -1 || (newline !== -1 && newline < close) || close + 1 > MAX_TAG_LEN) {
        // Broken across a line or over-long: not a tag. Emit the bracket and
        // rescan what follows it.
        emit(ch);
        i += 1;
        continue;
      }

      const cue = parseTag(rest.slice(0, close + 1));
      if (cue) cues.push(cue);
      skip =
        last === '' || last === '\n' ? 'line' : last === ' ' || last === '\t' ? 'spaces' : 'none';
      i += close + 1;
    }

    return { text: out, cues };
  };

  return {
    push: (chunk) => scan(held + chunk),
    flush: () => {
      const text = held;
      held = '';
      skip = 'none';
      return { text, cues: [] };
    },
  };
}

/**
 * Full-text stripping, by construction identical to feeding the same text
 * through a scanner chunk by chunk.
 */
export function stripCueTags(text: string): { text: string; cues: Cue[] } {
  const scanner = createCueScanner();
  const scanned = scanner.push(text);
  const rest = scanner.flush();
  return { text: scanned.text + rest.text, cues: [...scanned.cues, ...rest.cues] };
}

/**
 * Cues as persisted message-part objects. Deliberately the AI SDK `data-*`
 * shape (not the repo's bare-name idiom like `recall`), so the client reads
 * one shape whether a part arrived live over the UI message stream or was
 * loaded from `messages.parts` (jsonb — no migration).
 *
 * Break cues are excluded: a boundary becomes separate TEXT parts (see
 * `splitAtBreaks`), not an overlay part riding alongside one.
 */
export function cueMessageParts(cues: Cue[]): unknown[] {
  return cues.flatMap((cue): unknown[] =>
    cue.kind === 'face'
      ? [{ type: 'data-face', data: { state: cue.state } }]
      : cue.kind === 'theme'
        ? [{ type: 'data-theme', data: { name: cue.name } }]
        : cue.kind === 'chips'
          ? [{ type: 'data-chips', data: { labels: cue.labels } }]
          : [],
  );
}

/**
 * Split a stripped reply at the recorded break offsets, in the scanner's
 * cumulative coordinates. Every slice is kept VERBATIM — including
 * whitespace-only ones — because the streamed message parts split at the
 * same positions and the client's exact-text dedupe compares the two
 * concatenations. Renderers skip whitespace-only text parts.
 */
export function splitAtBreaks(text: string, breaks: number[]): string[] {
  const sorted = [...breaks].filter((at) => Number.isFinite(at)).sort((a, b) => a - b);
  const segments: string[] = [];
  let prev = 0;
  for (const raw of sorted) {
    const at = Math.min(Math.max(raw, prev), text.length);
    segments.push(text.slice(prev, at));
    prev = at;
  }
  segments.push(text.slice(prev));
  return segments;
}

/**
 * The dashboard-only persona and cue-vocabulary block for buildSystemPrompt.
 * Static text (safe for the byte-stable cacheable prefix); only spliced in
 * when the caller passes `channel: 'dashboard-chat'`.
 */
export function companionPersonaLines(): string[] {
  return [
    '',
    'Dashboard companion (this channel only):',
    "- In the dashboard chat you are the owner's companion — warm, unhurried, and capable. Keep your words plain and conversational. Serious or urgent asks get your focused, efficient self, and every operating rule above applies unchanged.",
    '- Prefer intuitive, human phrasing over technical jargon unless the owner talks shop first. The persona changes tone, never substance.',
    '- This register is for the dashboard only. Email and SMS keep the professional voice described above.',
    '',
    'Dashboard cues (dashboard chat only): the dashboard supports tappable quick-reply chips, driven by cue tags you embed in your reply text. The interface strips the tags before the owner sees the text — never mention, explain, or quote them, and never use one anywhere but this dashboard conversation.',
    '- [break] splits your reply into separate chat bubbles at the exact point the tag appears — the way a person sends two or three short texts instead of one block. At most two per reply, on its own line, only at a natural beat (a greeting, then the substance; an answer, then the follow-up question). Never inside a list, a table, or a code block, and never around one: a lookup result set is ONE message.',
    `- [action_chips: "Label" | "Label"] offers quick replies. At most one per reply, at the very end, with two to four short labels (under ${MAX_CHIP_LABEL} characters each), and only when clear follow-ups exist. Each label must read as a message the owner could send you word-for-word.`,
    '- Never emit a [theme: ...] tag. The chat stays on its default color at all times — the owner has asked that the mood color never change.',
  ];
}
