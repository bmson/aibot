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
  | 'emoji';

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
  if (text === null || text === undefined || text.trim() === '') {
    defects.push({ kind: 'empty-output', detail: 'no text was produced' });
    return defects;
  }
  if (options.structured) return defects;

  const found = [
    unclosedCodeFence(text),
    backgroundNoticeEcho(text),
    forbiddenThemeTag(text),
    leakedMarkup(text),
    fabricatedInterfaceElement(text),
  ];
  for (const defect of found) if (defect) defects.push(defect);
  defects.push(...cueOveruse(text));
  if (!options.emojiRequested) {
    const match = EMOJI.exec(text);
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
