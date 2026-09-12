import { Cron } from 'croner';

/** Compute the next strictly later occurrence, including exact cron boundaries. */
export function nextRun(cron: string, timezone: string, from: Date = new Date()): Date {
  const expression = new Cron(cron, { timezone });
  let next = expression.nextRun(from);
  if (next && next.getTime() <= from.getTime()) {
    next = expression.nextRun(new Date(from.getTime() + 1_000));
  }
  if (!next) throw new Error(`cron never fires: ${cron}`);
  return next;
}
