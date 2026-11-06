import type { MarketCurrency } from "./market-currency";

/** Format a market amount, retaining extra precision for selected unit prices. */
export function formatMarketMoney(value: number | null | undefined, currency: MarketCurrency, minimumPrecision = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const currencyFractionDigits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().minimumFractionDigits ?? 2;
  const minimumFractionDigits = Math.max(currencyFractionDigits, minimumPrecision);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits: Math.max(minimumFractionDigits, Math.abs(value) < 1 || minimumPrecision > 0 ? 6 : 2),
  }).format(value);
}

/** USDT is a cryptoasset quote, never a fiat USD symbol or a converted amount. */
export function formatUsdtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "— USDT";
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value)} USDT`;
}

/** Show when a snapshot was fetched without implying an individual quote's age. */
export function formatMarketRetrievalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
