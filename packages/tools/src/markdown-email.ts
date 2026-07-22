/**
 * Markdown → email HTML/plain-text rendering.
 *
 * The model writes Markdown; an email must render it as formatted HTML (so bold,
 * lists, and links look right) with a plain-text alternative that has no leftover
 * `**`/`#`/`[]()` markers. Self-contained on purpose — a heavyweight Markdown
 * dependency is unwarranted for the small subset email needs, and every value
 * that reaches the HTML is escaped first, so model text can never inject markup.
 */

import { parseInline } from './google/docs-markdown.js';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LINK_STYLE = 'color:#1155cc';
const CODE_STYLE =
  'font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(135,131,120,0.15);padding:0 3px;border-radius:3px';

/** Render one line's inline Markdown to escaped HTML. */
function inlineHtml(text: string): string {
  return parseInline(text)
    .map((run) => {
      const body = escapeHtml(run.text);
      if (run.code) return `<code style="${CODE_STYLE}">${body}</code>`;
      if (run.link) return `<a href="${escapeHtml(run.link)}" style="${LINK_STYLE}">${body}</a>`;
      if (run.bold) return `<strong>${body}</strong>`;
      if (run.italic) return `<em>${body}</em>`;
      return body;
    })
    .join('');
}

/** Render one line's inline Markdown to plain text (links become "text (url)"). */
function inlinePlain(text: string): string {
  return parseInline(text)
    .map((run) => (run.link ? `${run.text} (${run.link})` : run.text))
    .join('');
}

interface Line {
  raw: string;
  heading?: number;
  bullet?: boolean;
  ordered?: boolean;
  ordinal?: string;
  quote?: boolean;
  hr?: boolean;
  blank?: boolean;
  content: string;
}

function classify(raw: string): Line {
  if (/^\s*$/.test(raw)) return { raw, blank: true, content: '' };
  const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
  if (heading) return { raw, heading: heading[1]?.length, content: heading[2] ?? '' };
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) return { raw, hr: true, content: '' };
  const quote = /^>\s?(.*)$/.exec(raw);
  if (quote) return { raw, quote: true, content: quote[1] ?? '' };
  const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
  if (ordered) return { raw, ordered: true, ordinal: ordered[1], content: ordered[2] ?? '' };
  const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
  if (bullet) return { raw, bullet: true, content: bullet[1] ?? '' };
  return { raw, content: raw };
}

/** Render Markdown as an inline-styled HTML fragment suitable for an email body. */
export function markdownToEmailHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p style="margin:0 0 12px">${paragraph.map(inlineHtml).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (/^\s*```/.test(raw)) {
      flushParagraph();
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      html.push(
        `<pre style="${CODE_STYLE};display:block;padding:10px;white-space:pre-wrap;overflow-x:auto">${escapeHtml(
          buf.join('\n'),
        )}</pre>`,
      );
      continue;
    }

    const line = classify(raw);
    if (line.blank) {
      flushParagraph();
      closeList();
      continue;
    }
    if (line.hr) {
      flushParagraph();
      closeList();
      html.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">');
      continue;
    }
    if (line.heading) {
      flushParagraph();
      closeList();
      const size = Math.max(14, 24 - (line.heading - 1) * 2);
      html.push(
        `<h${line.heading} style="font-size:${size}px;margin:16px 0 8px;font-weight:600">${inlineHtml(
          line.content,
        )}</h${line.heading}>`,
      );
      continue;
    }
    if (line.quote) {
      flushParagraph();
      closeList();
      html.push(
        `<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #ddd;color:#666">${inlineHtml(
          line.content,
        )}</blockquote>`,
      );
      continue;
    }
    if (line.bullet || line.ordered) {
      flushParagraph();
      const want = line.ordered ? 'ol' : 'ul';
      if (list !== want) {
        closeList();
        html.push(`<${want} style="margin:0 0 12px;padding-left:24px">`);
        list = want;
      }
      html.push(`<li style="margin:2px 0">${inlineHtml(line.content)}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.content);
  }
  flushParagraph();
  closeList();

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;max-width:640px">${html.join(
    '',
  )}</div>`;
}

/** Strip Markdown to a clean plain-text alternative (no `**`/`#`/`[]()` left over). */
export function markdownToPlainText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (/^\s*```/.test(raw)) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        out.push(lines[i] ?? '');
        i++;
      }
      continue;
    }
    const line = classify(raw);
    if (line.blank) out.push('');
    else if (line.hr) out.push('---');
    else if (line.heading) out.push(inlinePlain(line.content));
    else if (line.quote) out.push(`> ${inlinePlain(line.content)}`);
    else if (line.bullet) out.push(`- ${inlinePlain(line.content)}`);
    else if (line.ordered) out.push(`${line.ordinal}. ${inlinePlain(line.content)}`);
    else out.push(inlinePlain(line.content));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
