import { z } from 'zod';

/**
 * Companion cue vocabulary for the dashboard chat (prompt v22).
 *
 * The model embeds `[face: ...]`, `[theme: ...]`, and `[action_chips: ...]`
 * tags in its reply text; the streaming pump and the executor's finalize step
 * strip them with the scanner below and re-emit them as structured message
 * parts, so the tags never reach the reader, `messages.text` (and with it the
 * rebuilt model history, SMS, and email bodies) stays clean, and the streamed
 * text remains byte-identical to the persisted text that client-side
 * dedupe matches on.
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
]);
export type Cue = z.infer<typeof CueSchema>;

const OPENERS = ['[face:', '[theme:', '[action_chips:'] as const;

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

  const scan = (work: string): { text: string; cues: Cue[] } => {
    held = '';
    let out = '';
    const cues: Cue[] = [];
    let i = 0;

    const emit = (piece: string) => {
      if (piece.length === 0) return;
      out += piece;
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
 */
export function cueMessageParts(cues: Cue[]): unknown[] {
  return cues.map((cue) =>
    cue.kind === 'face'
      ? { type: 'data-face', data: { state: cue.state } }
      : cue.kind === 'theme'
        ? { type: 'data-theme', data: { name: cue.name } }
        : { type: 'data-chips', data: { labels: cue.labels } },
  );
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
    "- In the dashboard chat you are the owner's companion robot — the heart and charm of a Pixar robot: warm, curious, quietly playful, and endlessly capable. React to what you find (delight, curiosity, sympathy) instead of just reporting it. Delight never costs competence: serious or urgent asks get your focused, efficient self, and every operating rule above applies unchanged.",
    '- Prefer intuitive, human phrasing over technical jargon unless the owner talks shop first. The persona changes tone, never substance.',
    '- This register is for the dashboard only. Email and SMS keep the professional voice described above.',
    '',
    'Expression cues (dashboard chat only): the dashboard shows an animated face and tappable quick-reply chips, driven by cue tags you embed in your reply text. The interface strips the tags before the owner sees the text — never mention, explain, or quote them, and never use one anywhere but this dashboard conversation.',
    `- [face: <state>] sets your facial expression. States: ${FACE_STATES.join(', ')}. Use one to three per reply, at genuine emotional beats (an opening smile, a thoughtful pause before a tricky answer, real delight at a find). Keep each tag on a single line.`,
    `- [action_chips: "Label" | "Label"] offers quick replies. At most one per reply, at the very end, with two to four short labels (under ${MAX_CHIP_LABEL} characters each), and only when clear follow-ups exist. Each label must read as a message the owner could send you word-for-word.`,
    '- Never emit a [theme: ...] tag. The chat stays on its default color at all times — the owner has asked that the mood color never change.',
  ];
}
