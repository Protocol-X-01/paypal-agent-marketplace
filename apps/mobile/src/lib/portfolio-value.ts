import { ASSETS, type CoinId, type MarketOverview } from './market';
import { holdingQuantityForEstimate } from './holding-input';

export const MAX_ESTIMATED_VALUE = 1_000_000_000_000;

/** Values over this conservative display bound remain saved, but are not estimated. */
export function estimateHoldingValue(value: string, price: number | null | undefined): number | null {
  const quantity = holdingQuantityForEstimate(value);
  if (quantity === null || typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  const result = quantity * price;
  // A positive mathematical product can underflow to zero in floating-point
  // arithmetic. Withhold it instead of presenting it as a zero holding.
  if (quantity > 0 && price > 0 && result === 0) return null;
  return Number.isFinite(result) && result <= MAX_ESTIMATED_VALUE ? result : null;
}

export function estimatePortfolio(
  holdings: Partial<Record<CoinId, string>>,
  overview: MarketOverview | null,
  holdingsReady: boolean,
): {
  state: 'holdings-unavailable' | 'empty' | 'prices-unavailable' | 'calculation-unavailable' | 'ready';
  estimatedValue: number | null;
  enteredAssetCount: number | null;
  missingPriceCount: number;
} {
  // An empty in-memory object is not evidence of an empty portfolio while
  // storage is loading, unreadable, or awaiting a recovery choice.
  if (!holdingsReady) {
    return { state: 'holdings-unavailable', estimatedValue: null, enteredAssetCount: null, missingPriceCount: 0 };
  }
  let total = 0;
  let missing = 0;
  let entered = 0;
  let calculationUnavailable = false;
  for (const asset of ASSETS) {
    const value = holdings[asset.id];
    if (!value) continue;
    const quantity = holdingQuantityForEstimate(value);
    if (quantity === null) {
      entered += 1;
      calculationUnavailable = true;
      continue;
    }
    if (quantity <= 0) continue;
    entered += 1;
    const price = overview?.coins.find((coin) => coin.id === asset.id)?.price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      missing += 1;
    } else {
      const amount = estimateHoldingValue(value, price);
      if (amount === null || !Number.isFinite(total + amount) || total + amount > MAX_ESTIMATED_VALUE) calculationUnavailable = true;
      else total += amount;
    }
  }
  if (entered === 0) return { state: 'empty', estimatedValue: null, enteredAssetCount: 0, missingPriceCount: 0 };
  if (calculationUnavailable) return { state: 'calculation-unavailable', estimatedValue: null, enteredAssetCount: entered, missingPriceCount: missing };
  if (missing > 0) return { state: 'prices-unavailable', estimatedValue: null, enteredAssetCount: entered, missingPriceCount: missing };
  return { state: 'ready', estimatedValue: total, enteredAssetCount: entered, missingPriceCount: 0 };
}
