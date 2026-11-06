import type { Candle } from "./candle-series";
import type { TrackedCoin } from "./market-assets";
import type { MarketCurrency } from "./market-currency";
import type { ChartDays } from "./market-data";

export type AutoCandleHistory = {
  coinId: TrackedCoin;
  currency: MarketCurrency;
  days: ChartDays;
  source: "CoinGecko";
  retrievedAt: string;
  candleIntervalMinutes: 30 | 240 | 5760;
  timestampKind: "close";
  candles: Candle[];
};
export type IntradayInterval = "3m" | "5m" | "15m";
export type IntradayDays = 1 | 7;
export type CandleIntervalChoice = "auto" | IntradayInterval;
export type IntradaySelection = { interval: IntradayInterval; days: IntradayDays };
export type IntradayCandleHistory = {
  coinId: Exclude<TrackedCoin, "paypal-usd">;
  currency: "USDT";
  quote: "USDT";
  days: IntradayDays;
  source: "Binance Spot";
  interval: IntradayInterval;
  intervalMinutes: 3 | 5 | 15;
  candleIntervalMinutes: 3 | 5 | 15;
  timestampKind: "close";
  observedAt: string;
  retrievedAt: string;
  coveredStart: number;
  coveredEnd: number;
  count: number;
  candles: Candle[];
};
export type CandleHistory = AutoCandleHistory | IntradayCandleHistory;
export type CandleSelection = { coinId: TrackedCoin; currency: MarketCurrency; days: ChartDays; intraday?: IntradaySelection };
export type CandleWindow = { start: number; end: number };
export type CandleViewSnapshot = { identity: string; startTimestamp: number; endTimestamp: number; selectedTimestamp: number; fullRange: boolean };
export const MAX_CANDLE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CANDLE_COUNT = 1000;

export function isSupportedIntradaySelection(coinId: TrackedCoin, selection: IntradaySelection): boolean {
  return coinId !== "paypal-usd" && ["3m", "5m", "15m"].includes(selection.interval) &&
    (selection.days === 1 || selection.days === 7 && selection.interval === "15m");
}

export function candleSelectionIdentity({ coinId, currency, days, intraday }: CandleSelection): string {
  return intraday ? `Binance Spot:${coinId}:USDT:${intraday.days}:${intraday.interval}` : `CoinGecko:${coinId}:${currency}:${days}:auto`;
}

export function candleHistoryIdentity(history: CandleHistory): string {
  return history.source === "Binance Spot" ? `Binance Spot:${history.coinId}:USDT:${history.days}:${history.interval}` : `CoinGecko:${history.coinId}:${history.currency}:${history.days}:auto`;
}

export function captureCandleView(history: CandleHistory, window: CandleWindow, selected: number): CandleViewSnapshot {
  return { identity: candleHistoryIdentity(history), startTimestamp: history.candles[window.start].timestamp, endTimestamp: history.candles[window.end - 1].timestamp, selectedTimestamp: history.candles[selected].timestamp, fullRange: window.start === 0 && window.end === history.candles.length };
}

/** Restore only matching actual timestamps; a new asset/currency/range cannot reuse a selection. */
export function restoreCandleView(history: CandleHistory, snapshot: CandleViewSnapshot | null | undefined): { window: CandleWindow | null; selected: number | null } {
  const empty = { window: null, selected: null };
  if (!snapshot || snapshot.identity !== candleHistoryIdentity(history) || !history.candles.length) return empty;
  const first = snapshot.fullRange ? 0 : history.candles.findIndex((candle) => candle.timestamp === snapshot.startTimestamp);
  const last = snapshot.fullRange ? history.candles.length - 1 : history.candles.findIndex((candle) => candle.timestamp === snapshot.endTimestamp);
  if (first < 0 || last < first || last - first + 1 < Math.min(3, history.candles.length)) return empty;
  const selected = history.candles.findIndex((candle) => candle.timestamp === snapshot.selectedTimestamp);
  return { window: { start: first, end: last + 1 }, selected: selected >= first && selected <= last ? selected : last };
}

export function parseCandleHistory(value: unknown, expected: Pick<AutoCandleHistory, "coinId" | "currency" | "days">): AutoCandleHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid candle history");
  const data = value as Record<string, unknown>;
  const interval = expected.days === 1 ? 30 : expected.days <= 30 ? 240 : 5760;
  if (data.coinId !== expected.coinId || data.currency !== expected.currency || data.days !== expected.days ||
      data.source !== "CoinGecko" || data.timestampKind !== "close" || data.candleIntervalMinutes !== interval ||
      typeof data.retrievedAt !== "string" || !Number.isFinite(Date.parse(data.retrievedAt)) ||
      !Array.isArray(data.candles) || data.candles.length > MAX_CANDLE_COUNT) throw new Error("Invalid candle history");
  let previous = 0;
  const candles = data.candles.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid candle");
    const candle = value as Record<string, unknown>;
    const { timestamp, open, high, low, close } = candle;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= previous || !Number.isFinite(new Date(timestamp).getTime()) ||
        ![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
        (low as number) > Math.min(open as number, close as number) || (high as number) < Math.max(open as number, close as number)) throw new Error("Invalid candle");
    previous = timestamp;
    return { timestamp, open, high, low, close } as Candle;
  });
  return { ...expected, source: "CoinGecko", retrievedAt: data.retrievedAt, candleIntervalMinutes: interval, timestampKind: "close", candles };
}

/** Native USDT trade candles stay separate from the fiat CoinGecko history. */
export function parseIntradayCandleHistory(value: unknown, expected: { coinId: TrackedCoin } & IntradaySelection): IntradayCandleHistory {
  if (!isSupportedIntradaySelection(expected.coinId, expected) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intraday history");
  const data = value as Record<string, unknown>;
  const minutes = expected.interval === "3m" ? 3 : expected.interval === "5m" ? 5 : 15;
  const intervalMs = minutes * 60_000;
  const count = expected.days * 86_400_000 / intervalMs;
  const validTime = (time: unknown): time is number => typeof time === "number" && Number.isSafeInteger(time) && time > 0 && Number.isFinite(new Date(time).getTime());
  const observed = typeof data.observedAt === "string" ? Date.parse(data.observedAt) : NaN;
  const retrieved = typeof data.retrievedAt === "string" ? Date.parse(data.retrievedAt) : NaN;
  if (data.coinId !== expected.coinId || data.source !== "Binance Spot" || data.quote !== "USDT" || data.interval !== expected.interval ||
      data.intervalMinutes !== minutes || data.days !== expected.days || data.timestampKind !== "close" ||
      !validTime(observed) || !validTime(retrieved) || !validTime(data.coveredStart) || !validTime(data.coveredEnd) ||
      data.coveredStart % intervalMs !== 0 || data.coveredEnd % intervalMs !== 0 ||
      data.coveredEnd - data.coveredStart !== expected.days * 86_400_000 || data.coveredEnd > observed - 1000 ||
      data.count !== count || !Array.isArray(data.candles) || data.candles.length !== count || count > MAX_CANDLE_COUNT) throw new Error("Invalid intraday history");
  const start = data.coveredStart;
  const candles = data.candles.map((value: unknown, index: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intraday candle");
    const { timestamp, open, high, low, close } = value as Record<string, unknown>;
    if (!validTime(timestamp) || timestamp !== start + (index + 1) * intervalMs ||
        ![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
        (low as number) > Math.min(open as number, close as number) || (high as number) < Math.max(open as number, close as number)) throw new Error("Invalid intraday candle");
    return { timestamp, open, high, low, close } as Candle;
  });
  return { coinId: expected.coinId as IntradayCandleHistory["coinId"], source: "Binance Spot", currency: "USDT", quote: "USDT", interval: expected.interval,
    days: expected.days, intervalMinutes: minutes, candleIntervalMinutes: minutes, timestampKind: "close", observedAt: data.observedAt as string,
    retrievedAt: data.retrievedAt as string, coveredStart: data.coveredStart, coveredEnd: data.coveredEnd, count, candles };
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Candle request aborted")); return; }
    const abort = () => { cleanup(); reject(new Error("Candle request aborted")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

/** Bound decoded response bytes before parsing; never expose a provider error body. */
export async function readCandleResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => undefined); throw new Error("Candle history unavailable"); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_CANDLE_RESPONSE_BYTES)) {
    void response.body.cancel().catch(() => undefined);
    throw new Error("Candle response too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) { done = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_CANDLE_RESPONSE_BYTES) throw new Error("Candle response too large");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    if (!done) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A canceled browser read can still be settling. */ }
  }
}

export function normalizedCandleWindow(count: number, window: CandleWindow | null): CandleWindow {
  if (!Number.isSafeInteger(count) || count <= 0) return { start: 0, end: 0 };
  if (!window || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end)) return { start: 0, end: count };
  const span = Math.max(Math.min(3, count), Math.min(count, window.end - window.start));
  const start = Math.max(0, Math.min(count - span, window.start));
  return { start, end: start + span };
}

/** Zoom and pan in complete observed candles, retaining the selected candle on zoom. */
export function moveCandleWindow(count: number, current: CandleWindow | null, action: "in" | "out" | "earlier" | "later" | "reset", selected: number): CandleWindow {
  const window = normalizedCandleWindow(count, current);
  if (!count || action === "reset") return { start: 0, end: Math.max(0, count) };
  const span = window.end - window.start;
  if (action === "earlier" || action === "later") {
    const shift = Math.max(1, Math.floor(span / 2)) * (action === "earlier" ? -1 : 1);
    const start = Math.max(0, Math.min(count - span, window.start + shift));
    return { start, end: start + span };
  }
  const nextSpan = action === "in" ? Math.max(Math.min(3, count), Math.ceil(span / 2)) : Math.min(count, span * 2);
  const index = Math.max(window.start, Math.min(window.end - 1, selected));
  const ratio = span > 1 ? (index - window.start) / (span - 1) : 0.5;
  const start = Math.max(0, Math.min(count - nextSpan, index - Math.round(ratio * (nextSpan - 1))));
  return { start, end: start + nextSpan };
}

/** Keep the observed candle under the pointer in an integer window of at least three. */
export function candleWindowWheelZoom(count: number, current: CandleWindow, factor: number, pointerRatio: number): CandleWindow {
  if (count < 4 || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(pointerRatio)) return current;
  const window = normalizedCandleWindow(count, current);
  const span = window.end - window.start;
  const nextSpan = Math.max(3, Math.min(count, Math.round(span * factor)));
  if (nextSpan === span) return current;
  const ratio = Math.max(0, Math.min(1, pointerRatio));
  const index = window.start + Math.min(span - 1, Math.floor(ratio * span));
  const candleRatio = (index - window.start) / (span - 1);
  const start = Math.max(0, Math.min(count - nextSpan, index - Math.round(candleRatio * (nextSpan - 1))));
  return { start, end: start + nextSpan };
}

export function candlePriceDomain(candles: readonly Candle[], stablecoin: boolean, indicators: readonly (number | null)[] = []): { low: number; high: number } {
  const values = [...candles.flatMap((c) => [c.low, c.high]), ...indicators.filter((n): n is number => n !== null && Number.isFinite(n))];
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (!values.length || !Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1 };
  if (stablecoin) { low = Math.min(low, 0.98); high = Math.max(high, 1.02); }
  const padding = Math.max((high - low) * 0.07, Math.max(Math.abs(high), 1) * 0.001);
  return { low: Math.max(0, low - padding), high: Number.isFinite(high + padding) ? high + padding : Number.MAX_VALUE };
}
