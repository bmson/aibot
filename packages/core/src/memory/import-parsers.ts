/**
 * Archive parsers for backstory import (Phase 22). Deterministic and cheap —
 * the whole file re-parses on every resumed run, so no state lives here.
 * Units are the atoms of an archive (an email, a chat message, a paragraph);
 * distillation windows are built from consecutive units elsewhere.
 */

export interface ImportUnit {
  /** When the unit happened (for source-age-scaled confidence). Null = unknown. */
  date: Date | null;
  /** Short header line ("From X — Subject Y"), '' when not applicable. */
  header: string;
  text: string;
}

export type ImportKind = 'mbox' | 'json' | 'text';

const UNIT_CHAR_CAP = 2000;

/** Guess the parser from filename + content sniff. */
export function detectKind(filename: string, content: string): ImportKind {
  const lower = filename.toLowerCase();
  // mbox separator: "From sender@host <weekday> ..." — plain "From alice" prose doesn't count
  if (lower.endsWith('.mbox') || /^From \S+@\S+ .*\d{4}/.test(content.slice(0, 200))) return 'mbox';
  if (lower.endsWith('.json')) return 'json';
  try {
    const head = content.slice(0, 5).trimStart();
    if (head.startsWith('[') || head.startsWith('{')) {
      JSON.parse(content);
      return 'json';
    }
  } catch {
    // fall through to text
  }
  return 'text';
}

export function parseArchive(kind: ImportKind, content: string): ImportUnit[] {
  switch (kind) {
    case 'mbox':
      return parseMbox(content);
    case 'json':
      return parseJsonExport(content);
    case 'text':
      return parseText(content);
  }
}

function parseDate(value: string | number | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  // numeric epoch (seconds or millis)
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip the noise email bodies carry: quoted replies, base64 blobs, HTML, MIME scaffolding. */
function cleanBody(body: string): string {
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith('>')) return false; // quoted reply
      if (/^[A-Za-z0-9+/=]{60,}$/.test(t)) return false; // base64 payload line
      if (/^--[-=_A-Za-z0-9.]+/.test(t)) return false; // MIME boundary
      if (/^(Content-Type|Content-Transfer-Encoding|Content-Disposition|charset)/i.test(t))
        return false;
      if (/^On .* wrote:$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Minimal mbox splitter: messages start at /^From / separator lines. Reads
 * Date/From/Subject headers, cleans the body. Good enough for Takeout mail;
 * exotic MIME just degrades to noisier text, never a crash.
 */
export function parseMbox(content: string): ImportUnit[] {
  const chunks = `\n${content}`.split(/\n(?=From )/).filter((c) => c.trim().length > 0);
  const units: ImportUnit[] = [];
  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf('\n\n');
    const rawHeaders = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const rawBody = headerEnd === -1 ? '' : chunk.slice(headerEnd + 2);

    // unfold continuation lines, then read the headers we care about
    const headers = rawHeaders.replace(/\n[ \t]+/g, ' ');
    const get = (name: string) =>
      headers.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'im'))?.[1]?.trim() ?? '';
    const date = parseDate(get('Date'));
    const from = get('From');
    const subject = get('Subject');

    const text = cleanBody(rawBody).slice(0, UNIT_CHAR_CAP);
    if (text.length < 20 && !subject) continue;
    units.push({
      date,
      header: [from && `From ${from}`, subject && `Subject: ${subject}`]
        .filter(Boolean)
        .join(' — '),
      text: text || subject,
    });
  }
  return units;
}

/**
 * Generic JSON chat/message export: an array (or {messages: []}) of objects
 * with recognizable date/sender/text keys.
 */
export function parseJsonExport(content: string): ImportUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { messages?: unknown[] })?.messages)
      ? ((parsed as { messages: unknown[] }).messages ?? [])
      : [];

  const units: ImportUnit[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const text = String(item.text ?? item.content ?? item.body ?? item.message ?? '').trim();
    if (text.length < 3) continue;
    const from = String(item.from ?? item.sender ?? item.author ?? item.name ?? '').trim();
    units.push({
      date: parseDate(
        (item.date ?? item.timestamp ?? item.time ?? item.created_at ?? item.ts) as
          | string
          | number
          | undefined,
      ),
      header: from ? `From ${from}` : '',
      text: text.slice(0, UNIT_CHAR_CAP),
    });
  }
  return units;
}

/** Plain text / markdown: paragraphs merged into ~1500-char units, no dates. */
export function parseText(content: string): ImportUnit[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const units: ImportUnit[] = [];
  let buffer = '';
  for (const p of paragraphs) {
    if (buffer && buffer.length + p.length > 1500) {
      units.push({ date: null, header: '', text: buffer.slice(0, UNIT_CHAR_CAP) });
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n\n${p}` : p;
  }
  if (buffer) units.push({ date: null, header: '', text: buffer.slice(0, UNIT_CHAR_CAP) });
  return units;
}

export interface ImportWindow {
  units: ImportUnit[];
  /** Median unit date — the period this window covers. */
  date: Date | null;
  text: string;
}

/** Group consecutive units into distillation windows of roughly maxChars. */
export function windowUnits(units: ImportUnit[], maxChars = 6000): ImportWindow[] {
  const windows: ImportWindow[] = [];
  let bucket: ImportUnit[] = [];
  let size = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const dates = bucket
      .map((u) => u.date)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime());
    windows.push({
      units: bucket,
      date: dates[Math.floor(dates.length / 2)] ?? null,
      text: bucket
        .map((u) => (u.header ? `${u.header}\n${u.text}` : u.text))
        .join('\n---\n')
        .slice(0, maxChars + 500),
    });
    bucket = [];
    size = 0;
  };

  for (const unit of units) {
    if (size > 0 && size + unit.text.length > maxChars) flush();
    bucket.push(unit);
    size += unit.text.length;
  }
  flush();
  return windows;
}

/**
 * Source-age-scaled confidence: a 2019 fact starts low. Linear decay of ~6%
 * per year with a floor — old facts are hints, not gospel.
 */
export function ageScaledConfidence(base: number, date: Date | null, now = new Date()): number {
  if (!date) return Math.min(base, 0.6); // unknown age: cap moderately
  const years = Math.max(0, (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
  const factor = Math.max(0.35, 1 - 0.06 * years);
  return Math.max(0.05, Math.min(base * factor, 0.95));
}
