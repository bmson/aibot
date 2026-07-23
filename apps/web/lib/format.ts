// Server-side display formatting shared by the dashboard, approvals, and tasks pages.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "3m ago" / "in 2h" / "just now". Deterministic, server-rendered only. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff <= 0 ? 'just now' : 'in <1m';
  const unit =
    abs < HOUR
      ? `${Math.round(abs / MINUTE)}m`
      : abs < DAY
        ? `${Math.round(abs / HOUR)}h`
        : `${Math.round(abs / DAY)}d`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

/**
 * Compact timestamp "2026-07-15 09:41" in the owner's timezone. The sv-SE locale
 * renders ISO-style YYYY-MM-DD HH:mm; pass the agent's stored timezone so the
 * owner sees local time (dates were 7–8h off when this rendered UTC). Falls back
 * to UTC only if no timezone is given.
 */
export function formatDateTime(date: Date, timeZone?: string): string {
  if (!timeZone) return date.toISOString().slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** "$0.25" — numeric strings from drizzle, trailing zeros trimmed. */
export function formatUsd(value: string | null | undefined): string {
  const n = Number.parseFloat(value ?? '0');
  if (Number.isNaN(n)) return '$0';
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}
