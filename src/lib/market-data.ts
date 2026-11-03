import "server-only";

import { cacheLife } from "next/cache";
import { z } from "zod";
import { TRACKED_COINS, type TrackedCoin } from "./market-assets";

export { TRACKED_COINS, type TrackedCoin } from "./market-assets";
export const CHART_DAYS = [1, 7, 30, 90, 365] as const;
export type ChartDays = (typeof CHART_DAYS)[number];

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

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
    price_change_percentage_7d_in_currency: z.number().nullable().optional(),
    high_24h: z.number().nonnegative().nullable(),
    low_24h: z.number().nonnegative().nullable(),
    last_updated: z.string().datetime().nullable().optional(),
    sparkline_in_7d: z.object({ price: z.array(z.number().nonnegative()) }).optional(),
  })
  .passthrough();

const chartSchema = z
  .object({
    prices: z.array(z.tuple([z.number(), z.number()])),
    market_caps: z.array(z.tuple([z.number(), z.number()])),
    total_volumes: z.array(z.tuple([z.number(), z.number()])),
  })
  .passthrough();

export class MarketDataError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid_response",
    readonly status?: number,
  ) {
    super(kind === "invalid_response" ? "Invalid market data response" : "Market data unavailable");
    this.name = "MarketDataError";
  }
}

function providerHeaders(): HeadersInit {
  const key = process.env.COINGECKO_DEMO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function fetchProvider(path: string, params: URLSearchParams): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${COINGECKO_BASE}${path}?${params.toString()}`, {
      headers: providerHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new MarketDataError("unavailable");
  }

  if (!response.ok) throw new MarketDataError("unavailable", response.status);
  try {
    return await response.json();
  } catch {
    throw new MarketDataError("invalid_response", response.status);
  }
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

export interface ChartPoint {
  timestamp: number;
  value: number;
}

export interface MarketChart {
  coinId: TrackedCoin;
  currency: "USD";
  days: ChartDays;
  provider: "CoinGecko";
  retrievedAt: string;
  prices: ChartPoint[];
  marketCaps: ChartPoint[];
  volumes: ChartPoint[];
}

export async function getMarketOverview(): Promise<MarketOverview> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 60, expire: 600 });

  const params = new URLSearchParams({
    vs_currency: "usd",
    ids: TRACKED_COINS.join(","),
    sparkline: "true",
    price_change_percentage: "24h,7d",
    precision: "full",
  });
  const raw = await fetchProvider("/coins/markets", params);
  const parsed = z.array(marketRowSchema).safeParse(raw);
  if (!parsed.success) throw new MarketDataError("invalid_response");

  return {
    currency: "USD",
    provider: "CoinGecko",
    retrievedAt: new Date().toISOString(),
    coins: parsed.data.map((coin) => ({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      rank: coin.market_cap_rank ?? null,
      priceUsd: coin.current_price,
      marketCapUsd: coin.market_cap,
      volume24hUsd: coin.total_volume,
      change24hPct: coin.price_change_percentage_24h ?? null,
      change7dPct: coin.price_change_percentage_7d_in_currency ?? null,
      high24hUsd: coin.high_24h,
      low24hUsd: coin.low_24h,
      sparkline7d: coin.sparkline_in_7d?.price ?? [],
      lastUpdated: coin.last_updated ?? null,
    })),
  };
}

function chartPoints(values: Array<[number, number]>): ChartPoint[] {
  return values.map(([timestamp, value]) => ({ timestamp, value }));
}

export async function getMarketChart(coinId: TrackedCoin, days: ChartDays): Promise<MarketChart> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 60, expire: 600 });

  const params = new URLSearchParams({ vs_currency: "usd", days: String(days), precision: "full" });
  const raw = await fetchProvider(`/coins/${coinId}/market_chart`, params);
  const parsed = chartSchema.safeParse(raw);
  if (!parsed.success) throw new MarketDataError("invalid_response");

  return {
    coinId,
    currency: "USD",
    days,
    provider: "CoinGecko",
    retrievedAt: new Date().toISOString(),
    prices: chartPoints(parsed.data.prices),
    marketCaps: chartPoints(parsed.data.market_caps),
    volumes: chartPoints(parsed.data.total_volumes),
  };
}
