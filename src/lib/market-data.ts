import "server-only";

import { cacheLife } from "next/cache";
import { z } from "zod";
import { hasDistinctTrackedCoinIds, TRACKED_COINS, type TrackedCoin } from "./market-assets";
import type { MarketCurrency } from "./market-currency";
import type { Candle } from "./candle-series";

export { TRACKED_COINS, type TrackedCoin } from "./market-assets";
export const CHART_DAYS = [1, 7, 30, 90, 365] as const;
export type ChartDays = (typeof CHART_DAYS)[number];

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
// App-owned decoded-body limits, not CoinGecko promises. Demo auto-granularity
// reaches roughly 2,160 hourly observations per series at 90 days; 4 MiB leaves
// headroom for three full-precision series. Quotes request only seven tracked
// assets and their 7-day sparklines. Provider payload formats can still change.
// https://docs.coingecko.com/demo/reference/coins-id-market-chart
// https://docs.coingecko.com/demo/reference/coins-markets
const MAX_QUOTE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CHART_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CANDLE_RESPONSE_BYTES = 1024 * 1024;
// Leave headroom below CoinGecko Demo's 30 calls/minute. This rolling limit is
// per Node process and is not shared between service instances.
const PROVIDER_CALL_LIMIT_PER_MINUTE = 24;
const PROVIDER_CALL_WINDOW_MS = 60_000;
type MarketDataGlobal = typeof globalThis & {
  __paypalMarketsProviderCallTimestamps?: number[];
};
const providerCallTimestamps =
  ((globalThis as MarketDataGlobal).__paypalMarketsProviderCallTimestamps ??= []);

const marketRowSchema = z
  .object({
    id: z.enum(TRACKED_COINS),
    symbol: z.string(),
    name: z.string(),
    market_cap_rank: z.number().int().nullable().optional(),
    current_price: z.number().nonnegative().nullable(),
    market_cap: z.number().nonnegative().nullable(),
    total_volume: z.number().nonnegative().nullable(),
    price_change_percentage_24h: z.number().nullable().optional(),
    price_change_percentage_24h_in_currency: z.number().nullable().optional(),
    price_change_percentage_7d_in_currency: z.number().nullable().optional(),
    high_24h: z.number().nonnegative().nullable(),
    low_24h: z.number().nonnegative().nullable(),
    last_updated: z.string().datetime().nullable().optional(),
    sparkline_in_7d: z.object({ price: z.array(z.number().nonnegative()) }).optional(),
  })
  .passthrough();

// Historical values follow the existing ChartPoint contract. Keep timestamps
// within JavaScript's Date range so clients can render each accepted sample.
const chartPointSchema = z.tuple([
  z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
  z.number().nonnegative(),
]);
const chartSchema = z
  .object({
    prices: z.array(chartPointSchema),
    market_caps: z.array(chartPointSchema),
    total_volumes: z.array(chartPointSchema),
  })
  .passthrough();

type MarketDataErrorKind = "unavailable" | "invalid_response" | "not_configured" | "rate_limited";

export class MarketDataError extends Error {
  constructor(
    readonly kind: MarketDataErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === "invalid_response"
        ? "Invalid market data response"
        : kind === "not_configured"
          ? "Market data credentials are not configured"
          : kind === "rate_limited"
            ? "Market data request budget reached"
            : "Market data unavailable",
    );
    this.name = "MarketDataError";
  }
}

type CachedMarketResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: MarketDataErrorKind; status: number | null; retryAfterSeconds: number | null };

function cachedFailure(error: MarketDataError): CachedMarketResult<never> {
  return {
    ok: false,
    kind: error.kind,
    status: error.status ?? null,
    retryAfterSeconds: error.retryAfterSeconds ?? null,
  };
}

function unwrapCachedResult<T>(result: CachedMarketResult<T>): T {
  if (result.ok) return result.value;
  throw new MarketDataError(result.kind, result.status ?? undefined, result.retryAfterSeconds ?? undefined);
}

function providerHeaders(): HeadersInit {
  const key = process.env.COINGECKO_DEMO_API_KEY?.trim();
  if (!key) throw new MarketDataError("not_configured");
  return { "x-cg-demo-api-key": key };
}

function reserveProviderCall(): void {
  const now = Date.now();
  const cutoff = now - PROVIDER_CALL_WINDOW_MS;
  while (providerCallTimestamps.length && providerCallTimestamps[0] <= cutoff) {
    providerCallTimestamps.shift();
  }

  if (providerCallTimestamps.length >= PROVIDER_CALL_LIMIT_PER_MINUTE) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((providerCallTimestamps[0] + PROVIDER_CALL_WINDOW_MS - now) / 1000),
    );
    throw new MarketDataError("rate_limited", 429, retryAfterSeconds);
  }

  providerCallTimestamps.push(now);
}

function providerRetryAfterSeconds(value: string | null): number {
  if (!value) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return 60;
}

async function readBoundedProviderJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* Already unavailable. */ }
    throw new MarketDataError("invalid_response", response.status);
  }
  if (!response.body) throw new MarketDataError("invalid_response", response.status);
  const reader = response.body.getReader();
  let complete = false;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new MarketDataError("unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new MarketDataError("unavailable");
      const result = await reader.read();
      if (signal.aborted) throw new MarketDataError("unavailable");
      if (result.done) { complete = true; break; }
      if (result.value.byteLength > maxBytes - bytes) throw new MarketDataError("invalid_response", response.status);
      bytes += result.value.byteLength;
      chunks.push(result.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown;
  };
  try {
    return await Promise.race([read(), aborted]);
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    throw new MarketDataError(signal.aborted ? "unavailable" : "invalid_response", response.status);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!complete) {
      try { void reader.cancel().catch(() => undefined); } catch { /* Already unavailable. */ }
    }
    try { reader.releaseLock(); } catch { /* Cancellation may still be pending. */ }
  }
}

async function fetchProvider(path: string, params: URLSearchParams, maxResponseBytes: number): Promise<unknown> {
  const headers = providerHeaders();
  reserveProviderCall();
  const signal = AbortSignal.timeout(8_000);

  let response: Response;
  try {
    response = await fetch(`${COINGECKO_BASE}${path}?${params.toString()}`, {
      headers,
      redirect: "error",
      signal,
    });
  } catch {
    throw new MarketDataError("unavailable");
  }

  if (response.status === 429) {
    throw new MarketDataError("unavailable", 429, providerRetryAfterSeconds(response.headers.get("Retry-After")));
  }
  if (!response.ok) throw new MarketDataError("unavailable", response.status);
  return readBoundedProviderJson(response, signal, maxResponseBytes);
}

export interface MarketCoin {
  id: TrackedCoin;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  high24hUsd: number | null;
  low24hUsd: number | null;
  sparkline7d: number[];
  lastUpdated: string | null;
}

export interface MarketOverview {
  currency: "USD";
  provider: "CoinGecko";
  retrievedAt: string;
  coins: MarketCoin[];
}

/** Currency-neutral quote fields; values use MarketQuotes.currency. */
export interface MarketQuote {
  id: TrackedCoin;
  symbol: string;
  name: string;
  rank: number | null;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  high24h: number | null;
  low24h: number | null;
  sparkline7d: number[];
  lastUpdated: string | null;
}

export interface MarketQuotes {
  currency: MarketCurrency;
  provider: "CoinGecko";
  retrievedAt: string;
  coins: MarketQuote[];
}

export interface ChartPoint {
  timestamp: number;
  value: number;
}

export interface MarketChart {
  coinId: TrackedCoin;
  currency: MarketCurrency;
  days: ChartDays;
  provider: "CoinGecko";
  retrievedAt: string;
  seriesSource: "market_chart" | "market_overview_sparkline";
  availableMetrics: Array<"price" | "marketCap" | "volume">;
  prices: ChartPoint[];
  marketCaps: ChartPoint[];
  volumes: ChartPoint[];
}

export interface MarketCandles {
  coinId: TrackedCoin;
  currency: MarketCurrency;
  days: ChartDays;
  source: "CoinGecko";
  retrievedAt: string;
  candleIntervalMinutes: 30 | 240 | 5760;
  timestampKind: "close";
  candles: Candle[];
}

const candleTupleSchema = z.tuple([
  z.number().int().positive().max(8_640_000_000_000_000),
  z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(),
]).refine(([, open, high, low, close]) => low <= Math.min(open, close) && high >= Math.max(open, close));
const candlesSchema = z.array(candleTupleSchema).max(1000).refine((rows) => rows.every((row, index) => index === 0 || row[0] > rows[index - 1][0]));

async function loadMarketCandles(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency): Promise<MarketCandles> {
  const params = new URLSearchParams({ vs_currency: currency.toLowerCase(), days: String(days), precision: "full" });
  const raw = await fetchProvider(`/coins/${coinId}/ohlc`, params, MAX_CANDLE_RESPONSE_BYTES);
  const result = candlesSchema.safeParse(raw);
  if (!result.success) throw new MarketDataError("invalid_response");
  return {
    coinId, currency, days, source: "CoinGecko", retrievedAt: new Date().toISOString(),
    candleIntervalMinutes: days === 1 ? 30 : days <= 30 ? 240 : 5760,
    timestampKind: "close",
    candles: result.data.map(([timestamp, open, high, low, close]) => ({ timestamp, open, high, low, close })),
  };
}

async function getCachedMarketCandles(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency): Promise<CachedMarketResult<MarketCandles>> {
  "use cache";
  try {
    const value = await loadMarketCandles(coinId, days, currency);
    cacheLife({ stale: 60, revalidate: 60, expire: 600 });
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof MarketDataError)) throw error;
    cacheLife({ stale: 0, revalidate: 0, expire: 1 });
    return cachedFailure(error);
  }
}

export async function getMarketCandles(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency = "USD"): Promise<MarketCandles> {
  return unwrapCachedResult(await getCachedMarketCandles(coinId, days, currency));
}

async function loadMarketQuotes(currency: MarketCurrency): Promise<MarketQuotes> {
  const params = new URLSearchParams({
    vs_currency: currency.toLowerCase(),
    ids: TRACKED_COINS.join(","),
    sparkline: "true",
    price_change_percentage: "24h,7d",
    precision: "full",
  });
  const raw = await fetchProvider("/coins/markets", params, MAX_QUOTE_RESPONSE_BYTES);
  const parsed = z.array(marketRowSchema).min(1).max(TRACKED_COINS.length).safeParse(raw);
  if (!parsed.success || !hasDistinctTrackedCoinIds(parsed.data)) throw new MarketDataError("invalid_response");

  return {
    currency,
    provider: "CoinGecko",
    retrievedAt: new Date().toISOString(),
    coins: parsed.data.map((coin) => ({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      rank: coin.market_cap_rank ?? null,
      price: coin.current_price,
      marketCap: coin.market_cap,
      volume24h: coin.total_volume,
      change24hPct: coin.price_change_percentage_24h_in_currency ??
        (currency === "USD" ? coin.price_change_percentage_24h ?? null : null),
      change7dPct: coin.price_change_percentage_7d_in_currency ?? null,
      high24h: coin.high_24h,
      low24h: coin.low_24h,
      sparkline7d: coin.sparkline_in_7d?.price ?? [],
      lastUpdated: coin.last_updated ?? null,
    })),
  };
}

async function getCachedMarketQuotes(currency: MarketCurrency): Promise<CachedMarketResult<MarketQuotes>> {
  "use cache";
  try {
    const value = await loadMarketQuotes(currency);
    cacheLife({ stale: 60, revalidate: 60, expire: 600 });
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof MarketDataError)) throw error;
    // Expected errors must cross the cache boundary as data: error instances
    // lose their custom properties when Next.js rehydrates them.
    cacheLife({ stale: 0, revalidate: 0, expire: 1 });
    return cachedFailure(error);
  }
}

export async function getMarketQuotes(currency: MarketCurrency): Promise<MarketQuotes> {
  return unwrapCachedResult(await getCachedMarketQuotes(currency));
}

/** Keep the existing USD response for clients using /api/market/coins. */
export async function getMarketOverview(): Promise<MarketOverview> {
  const quotes = await getMarketQuotes("USD");
  return {
    currency: "USD",
    provider: quotes.provider,
    retrievedAt: quotes.retrievedAt,
    coins: quotes.coins.map((coin) => ({
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      rank: coin.rank,
      priceUsd: coin.price,
      marketCapUsd: coin.marketCap,
      volume24hUsd: coin.volume24h,
      change24hPct: coin.change24hPct,
      change7dPct: coin.change7dPct,
      high24hUsd: coin.high24h,
      low24hUsd: coin.low24h,
      sparkline7d: coin.sparkline7d,
      lastUpdated: coin.lastUpdated,
    })),
  };
}

function chartPoints(values: Array<[number, number]>): ChartPoint[] {
  return values.map(([timestamp, value]) => ({ timestamp, value }));
}

async function loadMarketChart(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency): Promise<MarketChart> {
  const params = new URLSearchParams({ vs_currency: currency.toLowerCase(), days: String(days), precision: "full" });
  let raw: unknown;
  try {
    raw = await fetchProvider(`/coins/${coinId}/market_chart`, params, MAX_CHART_RESPONSE_BYTES);
  } catch (error) {
    if (
      !(error instanceof MarketDataError) ||
      error.kind !== "unavailable" ||
      error.status !== 429 ||
      (days !== 1 && days !== 7)
    ) {
      throw error;
    }

    const overview = await getMarketQuotes(currency);
    const coin = overview.coins.find((item) => item.id === coinId);
    if (!coin || coin.sparkline7d.length < 2) throw error;

    // The /coins/markets sparkline contains ordered price samples but no sample timestamps.
    // Spread the 7-day series evenly across its window and identify this fallback in the response.
    const anchor = Date.parse(coin.lastUpdated ?? overview.retrievedAt);
    const end = Number.isFinite(anchor) ? anchor : Date.parse(overview.retrievedAt);
    const step = (7 * 24 * 60 * 60 * 1000) / coin.sparkline7d.length;
    // The inferred times must remain distinct when represented in milliseconds.
    if (step < 1) throw error;
    const allPrices = coin.sparkline7d.map((value, index) => ({
      timestamp: Math.round(end - (coin.sparkline7d.length - index) * step),
      value,
    }));
    const prices = days === 1
      ? allPrices.filter((point) => point.timestamp >= end - 24 * 60 * 60 * 1000)
      : allPrices;
    if (prices.length < 2) throw error;

    return {
      coinId,
      currency,
      days,
      provider: "CoinGecko",
      retrievedAt: overview.retrievedAt,
      seriesSource: "market_overview_sparkline",
      availableMetrics: ["price"],
      prices,
      marketCaps: [],
      volumes: [],
    };
  }

  const parsed = chartSchema.safeParse(raw);
  if (!parsed.success) throw new MarketDataError("invalid_response");

  return {
    coinId,
    currency,
    days,
    provider: "CoinGecko",
    retrievedAt: new Date().toISOString(),
    seriesSource: "market_chart",
    availableMetrics: ["price", "marketCap", "volume"],
    prices: chartPoints(parsed.data.prices),
    marketCaps: chartPoints(parsed.data.market_caps),
    volumes: chartPoints(parsed.data.total_volumes),
  };
}

async function getCachedMarketChart(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency): Promise<CachedMarketResult<MarketChart>> {
  "use cache";
  try {
    const value = await loadMarketChart(coinId, days, currency);
    cacheLife({ stale: 60, revalidate: 60, expire: 600 });
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof MarketDataError)) throw error;
    cacheLife({ stale: 0, revalidate: 0, expire: 1 });
    return cachedFailure(error);
  }
}

export async function getMarketChart(coinId: TrackedCoin, days: ChartDays, currency: MarketCurrency = "USD"): Promise<MarketChart> {
  return unwrapCachedResult(await getCachedMarketChart(coinId, days, currency));
}
