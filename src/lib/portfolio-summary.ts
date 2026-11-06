import type { TrackedCoin } from "./market-assets";
import type { MarketQuote } from "./market-data";

export type PortfolioPosition = { id: TrackedCoin; amount: number; coin: MarketQuote | null; value: number | null };
export type PortfolioSummary = { positions: PortfolioPosition[]; total: number | null; dailyChange: number | null };

/** Returns complete totals only when every entered position has the required data. */
export function calculatePortfolio(
  amounts: Partial<Record<TrackedCoin, number>>,
  coinById: ReadonlyMap<TrackedCoin, MarketQuote>,
  trackedCoins: readonly TrackedCoin[],
): PortfolioSummary {
  const positions = trackedCoins.flatMap((id): PortfolioPosition[] => {
    const amount = amounts[id];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return [];
    const coin = coinById.get(id) ?? null;
    const price = coin?.price;
    const calculatedValue = typeof price === "number" && Number.isFinite(price) && price >= 0 ? amount * price : null;
    const value = calculatedValue !== null && Number.isFinite(calculatedValue) ? calculatedValue : null;
    return [{ id, amount, coin, value }];
  });

  let total: number | null = positions.length ? 0 : null;
  let dailyChange: number | null = positions.length ? 0 : null;
  for (const position of positions) {
    if (position.value === null) {
      total = null;
      dailyChange = null;
      continue;
    }
    if (total !== null) {
      total += position.value;
      if (!Number.isFinite(total)) total = null;
    }
    const change = position.coin?.change24hPct;
    if (dailyChange !== null) {
      if (typeof change !== "number" || !Number.isFinite(change) || change <= -100) {
        dailyChange = null;
      } else {
        dailyChange += position.value * (change / (100 + change));
        if (!Number.isFinite(dailyChange)) dailyChange = null;
      }
    }
  }
  if (total === null) dailyChange = null;
  return { positions, total, dailyChange };
}
