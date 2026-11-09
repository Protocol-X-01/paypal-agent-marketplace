export const TRACKED_COINS = [
  "bitcoin",
  "ethereum",
  "solana",
  "chainlink",
  "litecoin",
  "bitcoin-cash",
  "paypal-usd",
] as const;

export type TrackedCoin = (typeof TRACKED_COINS)[number];

/** Reject ambiguous duplicate IDs without requiring a complete watchlist. */
export function hasDistinctTrackedCoinIds(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length > TRACKED_COINS.length) return false;
  const allowed = new Set<string>(TRACKED_COINS);
  const seen = new Set<string>();
  return rows.every((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
