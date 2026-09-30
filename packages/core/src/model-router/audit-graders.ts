/**
 * Deterministic defect checks over one piece of model output.
 *
 * These exist because the September audit found the repository grading itself
 * on properties it never enforced: the unclosed-code-fence and leaked-marker
 * checks lived only in the question-regression harness, so a green suite implied
 * a guarantee that did not ship, and `response-contract.ts` contained no
 * formatting check at all.
 *
 * Everything here is pure and cheap, which is the point twice over. It lets the
 * review tool grade recorded production output without a model call, and it
 * leaves these checks in a shape that can be called from the response contract
 * itself — the same function deciding what shipped and what gets counted.
 *
 * Each check is mechanical. Nothing here judges whether an answer was *right*:
 * that needs the evidence, and it is what `groundReadDraft` already does for
 * reads. These catch the defects that are visible in the text alone.
 */

export type AuditDefectKind =
  | 'unclosed-code-fence'
  | 'background-notice-echo'
  | 'forbidden-theme-tag'
  | 'leaked-markup'
  | 'excess-break-tags'
  | 'excess-chip-rows'
  | 'fabricated-interface-element'
  | 'empty-output'
  | 'truncated-output'
  | 'schema-parse-failure'
  | 'emoji'
  | 'wall-of-text'
  | 'repetitive-output'
  | 'malformed-output';

export interface AuditDefect {
  kind: AuditDefectKind;
  /** What a reader needs to see to judge it, bounded for a report table. */
  detail: string;
}

/** Cue vocabulary the dashboard legitimately uses; see chat-cues.ts. */
const BREAK_TAG = /\[break\]/g;
const CHIP_ROW = /\[action_chips:/g;
const MAX_BREAKS = 2;
const MAX_CHIP_ROWS = 1;

/**
 * A bracketed row like `[Set weather alert] | [Check rain timing]`. The system
 * prompt forbids it — nothing renders it, so it reaches the owner as literal
 * text offering taps that do nothing — but no code ever checked for it.
 */
const FAKE_BUTTON_ROW = /\[[A-Z][^\]\n]{2,40}\]\s*\|\s*\[[A-Z][^\]\n]{2,40}\]/;

/**
 * Emoji, by the ranges that actually show up in assistant prose. Deliberately
 * not exhaustive over every pictographic codepoint: this is a review signal, and
 * a check that also fired on ordinary symbols would be ignored.
 *
 * An alternation rather than one class, because a variation selector is a
 * combining character and cannot share a class with the base characters it
 * modifies. It is not listed at all: on its own it is not an emoji, and every
 * emoji that carries one also carries a base character in one of these ranges.
 */
const EMOJI =
  /[\u{1F300}-\u{1FAFF}]|[\u{1F000}-\u{1F2FF}]|[\u{2600}-\u{27BF}]|[\u{1F1E6}-\u{1F1FF}]/u;

/**
 * Raw HTML and cue tags that should have been consumed before publish — a
 * closing `[/break]`, a `[smile]`, a literal `<br>`. Their presence in the
 * delivered text means a tag survived the stripper rather than being rendered.
 */
const LEAKED_MARKUP = /<br\s*\/?\s*>|\[\/(?:break|smile|nod)\]|\[(?:smile|nod)\]/i;

/**
 * Prose with fenced and inline code removed.
 *
 * Every marker check below has to run against this rather than the raw text: an
 * answer that legitimately *shows* the owner a `<br>` tag or a bracketed cue in
 * a code example is correct, and flagging it would make the checks unusable for
 * exactly the technical questions where they matter.
 */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function excerpt(text: string, around: number, span = 60): string {
  const start = Math.max(0, around - span / 2);
  return text
    .slice(start, start + span)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect obvious generation loops without trying to spell-check prose. A
 * repeated byte run is a strong corruption signal, while repeated ordinary
 * sentences remain allowed. The same check protects live step output and the
 * historical audit report.
 */
function repetitiveOutput(text: string): AuditDefect | undefined {
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  if (replacementChars >= 3) {
    return { kind: 'repetitive-output', detail: `${replacementChars} replacement characters` };
  }
  const body = prose(text).replace(/\s+/g, ' ').trim();
  if (body.length < 80) return undefined;
  for (let size = 1; size <= Math.min(16, Math.floor(body.length / 8)); size += 1) {
    for (let start = 0; start + size * 4 <= body.length; start += 1) {
      const unit = body.slice(start, start + size);
      if (unit.length < 2 || /^[\s\-=_*~.#|]+$/.test(unit)) continue;
      let repeats = 1;
      while (body.slice(start + size * repeats, start + size * (repeats + 1)) === unit) {
        repeats += 1;
      }
      const hasWhitespace = /\s/.test(unit);
      const hasPunctuation = /[^\p{L}\p{N}\s]/u.test(unit);
      const minimumRepeats = hasWhitespace ? 32 : hasPunctuation ? 8 : 16;
      const minimumSpan = hasWhitespace ? 256 : hasPunctuation ? 80 : 128;
      if (repeats >= minimumRepeats && size * repeats >= minimumSpan) {
        return {
          kind: 'repetitive-output',
          detail: `${repeats} repetitions of ${JSON.stringify(unit.slice(0, 24))}`,
        };
      }
    }
  }
  return undefined;
}

/** A degree marker followed by a nonstandard unit is a common text-corruption seam. */
function malformedOutput(text: string): AuditDefect | undefined {
  const match = /\b\d{1,3}°[CF](?!elsius\b|ahrenheit\b)[A-Za-z]{2,}\b/i.exec(prose(text));
  return match
    ? { kind: 'malformed-output', detail: `suspicious unit token ${match[0]}` }
    : undefined;
}

/** Strip the legacy audit encoding of tool choices before grading prose. */
function proseOnlyAuditOutput(text: string, toolCallsSerialized = false): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return toolCallsSerialized
        ? !/^→\s+[\w.-]+\(/.test(trimmed)
        : !/^→\s+[\w.-]+\([\s\S]*\)$/.test(trimmed);
    })
    .join('\n')
    .trim();
}

/**
 * An odd number of fences means one was never closed, which renders the rest of
 * the reply as a code block in every client.
 */
function unclosedCodeFence(text: string): AuditDefect | undefined {
  const fences = text.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2 === 0) return undefined;
  return { kind: 'unclosed-code-fence', detail: `${fences} fence markers, so one is unclosed` };
}

/**
 * The assistant repeating the background-notice marker from its own context
 * window back at the owner — the failure the `javascript-background-notice`
 * regression case was written for.
 */
function backgroundNoticeEcho(text: string): AuditDefect | undefined {
  const body = prose(text);
  const at = body.indexOf('[Background notice');
  if (at < 0) return undefined;
  return { kind: 'background-notice-echo', detail: excerpt(body, at) };
}

function forbiddenThemeTag(text: string): AuditDefect | undefined {
  const body = prose(text);
  const at = body.search(/\[theme:/i);
  if (at < 0) return undefined;
  return { kind: 'forbidden-theme-tag', detail: excerpt(body, at) };
}

function leakedMarkup(text: string): AuditDefect | undefined {
  const match = LEAKED_MARKUP.exec(prose(text));
  if (!match) return undefined;
  return { kind: 'leaked-markup', detail: `unrendered ${match[0]}` };
}

function cueOveruse(text: string): AuditDefect[] {
  const defects: AuditDefect[] = [];
  const body = prose(text);
  const breaks = body.match(BREAK_TAG)?.length ?? 0;
  if (breaks > MAX_BREAKS) {
    defects.push({
      kind: 'excess-break-tags',
      detail: `${breaks} [break] tags; at most ${MAX_BREAKS} are allowed`,
    });
  }
  const chips = body.match(CHIP_ROW)?.length ?? 0;
  if (chips > MAX_CHIP_ROWS) {
    defects.push({
      kind: 'excess-chip-rows',
      detail: `${chips} chip rows; at most ${MAX_CHIP_ROWS} is allowed`,
    });
  }
  return defects;
}

/**
 * The longest a plain paragraph may run before it reads as a wall on a phone:
 * roughly four lines of chat text at 390pt, or more than four sentences.
 */
const WALL_CHARACTERS = 400;
const WALL_SENTENCES = 4;
/** A block that already carries structure: list, table, quote, heading, math. */
const STRUCTURED_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|\||>|#{1,6}\s|\$\$)/;
/** Sentence ends that are not abbreviations or decimals ("e.g.", "3.5"). */
const SENTENCE_END =
  /(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|St|No|U\.S|approx))[.!?](?=\s+["'([]?[A-Z0-9])/g;

/**
 * A plain paragraph long enough to read as a block of text. A review signal
 * for `pnpm audit:llm`, not a repair: the clients reflow long paragraphs at
 * render time, which leaves persisted and streamed text byte-identical.
 */
function wallOfText(text: string): AuditDefect | undefined {
  for (const block of prose(text).split(/\n\s*\n/)) {
    let plainLines: string[] = [];
    const checkPlainParagraph = (): AuditDefect | undefined => {
      const paragraph = plainLines.join(' ').replace(/\s+/g, ' ').trim();
      plainLines = [];
      if (!paragraph) return undefined;
      const sentences = (paragraph.match(SENTENCE_END)?.length ?? 0) + 1;
      return paragraph.length > WALL_CHARACTERS || sentences > WALL_SENTENCES
        ? {
            kind: 'wall-of-text',
            detail: `${paragraph.length} characters, ${sentences} sentences: ${excerpt(paragraph, 0)}`,
          }
        : undefined;
    };
    for (const line of block.split('\n')) {
      if (STRUCTURED_BLOCK.test(line)) {
        const defect = checkPlainParagraph();
        if (defect) return defect;
      } else {
        plainLines.push(line);
      }
    }
    const defect = checkPlainParagraph();
    if (defect) return defect;
  }
  return undefined;
}

function fabricatedInterfaceElement(text: string): AuditDefect | undefined {
  const match = FAKE_BUTTON_ROW.exec(prose(text));
  if (!match) return undefined;
  return { kind: 'fabricated-interface-element', detail: match[0].slice(0, 80) };
}

export interface GradeOptions {
  /** From the provider. `length` means the answer was cut off mid-thought. */
  finishReason?: string | null;
  /**
   * Whether an emoji was legitimate. The owner asking for one makes it fine;
   * the record alone cannot tell, so the caller says when it knows.
   */
  emojiRequested?: boolean;
  /** Structured output is JSON and none of the prose checks apply to it. */
  structured?: boolean;
  /** Known owner request for exact or repeated wording suppresses this signal. */
  repetitionRequested?: boolean;
  /** Audit step rows append serialized tool calls after any prose. */
  toolCallsSerialized?: boolean;
}

/** Reserved prefix used when generateObject returned provider text it could not parse. */
export const OBJECT_PARSE_FAILURE_PREFIX = '[audit:object-schema-parse-failure]';

const EXPLICIT_REPETITION_REQUEST =
  /^\s*(?:please\s+)?(?:repeat|reproduce|copy)\b|\b(?:repeat|reproduce|copy|write|say|print)\b[^.!?\n]{0,100}\b(?:verbatim|exactly|again|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+times)\b/i;

/** Keep an owner's deliberate repetition request from tripping the live guard. */
export function explicitlyRequestsRepetition(request: string | undefined): boolean {
  if (
    !request ||
    /\b(?:do not|don['’]t|never|avoid)\s+(?:repeat|reproduce|copy)\b/i.test(request)
  ) {
    return false;
  }
  return EXPLICIT_REPETITION_REQUEST.test(request);
}

/**
 * Grade one output. Returns every defect found, most structural first.
 *
 * An empty result is not a claim that the answer was good — only that it
 * carries none of the defects that are detectable without its evidence.
 */
export function gradeAuditedOutput(
  text: string | null | undefined,
  options: GradeOptions = {},
): AuditDefect[] {
  const defects: AuditDefect[] = [];
  if (options.finishReason === 'length') {
    defects.push({ kind: 'truncated-output', detail: 'provider stopped at the token limit' });
  }
  const candidate =
    text === null || text === undefined
      ? text
      : proseOnlyAuditOutput(text, options.toolCallsSerialized);
  if (candidate === null || candidate === undefined || candidate.trim() === '') {
    // An empty textual payload is expected when the provider returned a tool
    // call. Older audit rows also encoded tool-call JSON as output; once those
    // lines are removed, this finish reason identifies the valid empty prose.
    if (options.finishReason === 'tool-calls') return defects;
    defects.push({ kind: 'empty-output', detail: 'no text was produced' });
    return defects;
  }
  if (candidate.startsWith(OBJECT_PARSE_FAILURE_PREFIX)) {
    defects.push({
      kind: 'schema-parse-failure',
      detail:
        candidate.slice(OBJECT_PARSE_FAILURE_PREFIX.length).trim().slice(0, 180) ||
        'provider text unavailable',
    });
    return defects;
  }
  if (options.structured) return defects;

  const malformed = malformedOutput(candidate);
  if (malformed) defects.push(malformed);
  if (!options.repetitionRequested) {
    const repeated = repetitiveOutput(candidate);
    if (repeated) defects.push(repeated);
  }

  const found = [
    unclosedCodeFence(candidate),
    backgroundNoticeEcho(candidate),
    forbiddenThemeTag(candidate),
    leakedMarkup(candidate),
    fabricatedInterfaceElement(candidate),
    wallOfText(candidate),
  ];
  for (const defect of found) if (defect) defects.push(defect);
  defects.push(...cueOveruse(candidate));
  if (!options.emojiRequested) {
    const match = EMOJI.exec(candidate);
    if (match) defects.push({ kind: 'emoji', detail: `contains ${match[0]}` });
  }
  return defects;
}

/**
 * Fix the presentation defects that can be fixed without judgement.
 *
 * The response contract already rewrites rather than blocks for fabricated
 * links (`enforceUrlProvenance`), and this is the same bargain: a stray fence
 * is a rendering bug, not dishonesty, so repairing it beats replacing a correct
 * answer with a refusal.
 *
 * Only two repairs qualify, and the bar is that they cannot lose meaning:
 * closing an unclosed fence is purely additive, and a `[theme:]` tag is
 * explicitly forbidden and renders as nothing. Everything else
 * `gradeAuditedOutput` finds is left alone on purpose — stripping a bracketed
 * row or an emoji requires knowing what the owner asked for, and a wrong
 * rewrite at the last step before delivery is worse than a defect caught in
 * review. Those stay review signals for `pnpm audit:llm`.
 */
export function repairPresentationDefects(text: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  let repaired = text;

  const withoutTheme = repaired.replace(/\[theme:[^\]\n]*\]\s*/gi, '');
  if (withoutTheme !== repaired) {
    repairs.push('forbidden-theme-tag');
    repaired = withoutTheme;
  }

  if ((repaired.match(/^\s*```/gm)?.length ?? 0) % 2) {
    repairs.push('unclosed-code-fence');
    repaired = `${repaired.replace(/\s+$/, '')}\n\`\`\``;
  }

  return { text: repaired, repairs };
}
