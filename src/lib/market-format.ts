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

/** Preserve the distinction between a very small positive holding and zero. */
export function formatPortfolioMoney(value: number | null | undefined, currency: MarketCurrency): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 0.000001
    ? `Less than ${formatMarketMoney(0.000001, currency)}`
    : formatMarketMoney(value, currency);
}

/** USDT is a cryptoasset quote, never a fiat USD symbol or a converted amount. */
export function formatUsdtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "— USDT";
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value)} USDT`;
}

/** Keep chart labels in UTC even when the viewer's device uses another zone. */
export function formatChartAxisTime(value: unknown, days: number): string {
  if (!(value instanceof Date) && typeof value !== "number") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = days === 1
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : days === 365 ? { month: "short", year: "2-digit" } : { day: "2-digit", month: "short" };
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
}

/** A sample tooltip preserves the actual instant, including subsecond precision. */
export function formatChartSampleTime(value: Date, approximate = false): string {
  if (!Number.isFinite(value.getTime())) return "Sample time unavailable";
  const utc = value.toISOString().replace("T", " ").replace(/\.000Z$/, "Z").replace("Z", " UTC");
  return `${approximate ? "Estimated sample time · " : ""}${utc}`;
}

/** Show when a snapshot was fetched without implying an individual quote's age. */
export function formatMarketRetrievalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Provider update times are separate from the time this snapshot was retrieved. */
export function formatMarketProviderUpdateTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    return "time unavailable";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return "time unavailable";
  }
  return formatMarketRetrievalTime(value) ?? "time unavailable";
}
