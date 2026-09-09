/** The ledger stores USD at six decimal places on both databases. */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('USD must be finite and nonnegative');
  const micros = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error('USD exceeds the supported ledger precision');
  return micros;
}

export function microsToUsd(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error('Microdollars must be a nonnegative safe integer');
  }
  return micros / 1_000_000;
}

/** Keep arithmetic exact: an overflow must never turn into an accepted budget. */
export function addMicros(...amounts: number[]): number {
  let total = 0;
  for (const amount of amounts) {
    microsToUsd(amount);
    total += amount;
    if (!Number.isSafeInteger(total)) throw new Error('Ledger total exceeds safe precision');
  }
  return total;
}
