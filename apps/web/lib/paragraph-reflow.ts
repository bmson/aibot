/**
 * Render-time reflow of overlong prose paragraphs.
 *
 * A reply line longer than about four phone lines reads as a block of text. The
 * prompt asks for short paragraphs, but a model does not always comply, and
 * history written before that rule still exists. Splitting at sentence
 * boundaries changes only whitespace, so doing it here — at render time, on
 * the markdown source — leaves the persisted and streamed text byte-identical
 * and never disturbs `[break]` offsets.
 *
 * The iOS renderer (`AssistantMarkdown.reflowParagraphs` in MessageBubble.swift)
 * implements the same rules; both are checked against
 * `paragraph-reflow.fixtures.json` so the two clients split identically.
 */

/** A line shorter than this is left exactly as written. */
export const REFLOW_MIN_LENGTH = 420;
/** A chunk ends once it reaches this length… */
const CHUNK_TARGET = 240;
/** …or this many sentences, whichever comes first. */
const CHUNK_SENTENCES = 3;
/** A trailing chunk shorter than this joins the chunk before it. */
const TAIL_MIN = 80;

/**
 * Lines that open or continue structure: list items, tables, quotes, headings,
 * math, HTML, footnotes, and any indented line (a list continuation or code).
 */
const STRUCTURED_LINE = /^(?:\s|[-*+]\s|\d+[.)]\s|\||>|#{1,6}\s|\$\$|<|\[\^)/;
const FENCE = /^\s*(?:```|~~~)/;
/** Words whose trailing period does not end a sentence. Compared lower-case. */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'dr',
  'mr',
  'mrs',
  'ms',
  'st',
  'no',
  'u.s',
  'approx',
  'a.m',
  'p.m',
  'inc',
  'ltd',
  'jr',
  'sr',
  'fig',
]);

/**
 * Offsets just past each sentence end in `line` that are safe to break at: at
 * nesting depth zero (not inside a link, parentheses, inline code, or bold) and
 * followed by whitespace and a capital letter, digit, or opening mark.
 */
function sentenceBreaks(line: string): number[] {
  const breaks: number[] = [];
  let brackets = 0;
  let parens = 0;
  let code = false;
  let bold = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '`') {
      code = !code;
      continue;
    }
    if (code) continue;
    if (char === '*' && line[index + 1] === '*') {
      bold = !bold;
      index++;
      continue;
    }
    if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    if (brackets || parens || bold) continue;
    if (char !== '.' && char !== '!' && char !== '?') continue;

    let end = index + 1;
    while (end < line.length && /["'”’)]/.test(line[end] ?? '')) end++;
    const rest = line.slice(end);
    if (!/^\s+["'“‘(*[]?[A-Z0-9]/.test(rest)) continue;
    if (char === '.') {
      const word = /([A-Za-z.]+)$/.exec(line.slice(0, index))?.[1] ?? '';
      if (ABBREVIATIONS.has(word.toLowerCase())) continue;
      // An initial ("J. Smith") or a single-letter enumerator.
      if (/^[A-Za-z]$/.test(word)) continue;
    }
    breaks.push(end);
  }
  return breaks;
}

/** One overlong line as sentence-grouped chunks, or the line unchanged. */
function reflowLine(line: string): string {
  if (line.length < REFLOW_MIN_LENGTH) return line;
  const cuts = sentenceBreaks(line);
  if (!cuts.length) return line;

  const sentences: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    sentences.push(line.slice(start, cut).trim());
    start = cut;
  }
  sentences.push(line.slice(start).trim());

  const chunks: string[] = [];
  let current: string[] = [];
  for (const sentence of sentences.filter(Boolean)) {
    current.push(sentence);
    const text = current.join(' ');
    if (text.length >= CHUNK_TARGET || current.length >= CHUNK_SENTENCES) {
      chunks.push(text);
      current = [];
    }
  }
  if (current.length) {
    const tail = current.join(' ');
    if (chunks.length && tail.length < TAIL_MIN) chunks[chunks.length - 1] += ` ${tail}`;
    else chunks.push(tail);
  }
  return chunks.length > 1 ? chunks.join('\n\n') : line;
}

/**
 * The same markdown with every overlong prose line split into short
 * paragraphs. Code fences, display math, and every structured line pass
 * through untouched. Idempotent.
 */
export function reflowParagraphs(markdown: string): string {
  if (markdown.length < REFLOW_MIN_LENGTH) return markdown;
  const lines = markdown.split('\n');
  let fence = false;
  let math = false;
  // A plain line straight after a list item or quote is its lazy
  // continuation; a blank line would pull it out of that structure.
  let structure = false;
  return lines
    .map((line) => {
      if (!line.trim()) {
        structure = false;
        return line;
      }
      if (FENCE.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      if (/^\s*\$\$/.test(line)) {
        // A one-line `$$…$$` block opens and closes on the same line.
        if (!/^\s*\$\$.*\S.*\$\$\s*$/.test(line)) math = !math;
        return line;
      }
      if (math) return line;
      if (STRUCTURED_LINE.test(line)) structure = true;
      return structure ? line : reflowLine(line);
    })
    .join('\n');
}
