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

/** Compact UTC timestamp: "2026-07-15 09:41". */
export function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
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
