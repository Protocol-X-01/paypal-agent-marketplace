import 'server-only';
import { acquireClientSlotForAddress } from './request-limits';

// Binance's market-data-only origin; this module has no account or order path.
const KLINES_URL = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  solana: 'SOLUSDT',
  chainlink: 'LINKUSDT',
  litecoin: 'LTCUSDT',
  'bitcoin-cash': 'BCHUSDT',
} as const;
const INTERVAL_MINUTES = { '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 } as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 30_000;
const CACHE_MS = 15_000;
const BUDGET_WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 12;
const MAX_CONCURRENT = 4;

export type IntradayCoin = keyof typeof SYMBOLS;
export type IntradayInterval = keyof typeof INTERVAL_MINUTES;
export type IntradayDays = 1 | 7;
const SUPPORTED_DAYS: Record<IntradayInterval, readonly IntradayDays[]> = {
  '3m': [1], '5m': [1], '15m': [1, 7], '30m': [1, 7], '1h': [1, 7], '4h': [1, 7], '1d': [7],
};
export type IntradayErrorKind = 'rate_limited' | 'invalid_response' | 'unavailable' | 'data_gap';

export class IntradayError extends Error {
  constructor(readonly kind: IntradayErrorKind, readonly retryAfterSeconds = 60) {
    super('Intraday market data could not be retrieved.');
    this.name = 'IntradayError';
  }
}

export interface IntradayCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IntradayHistory {
  coinId: IntradayCoin;
  source: 'Binance Spot';
  quote: 'USDT';
  interval: IntradayInterval;
  intervalMinutes: (typeof INTERVAL_MINUTES)[IntradayInterval];
  days: IntradayDays;
  timestampKind: 'close';
  observedAt: string;
  retrievedAt: string;
  coveredStart: number;
  coveredEnd: number;
  count: number;
  candles: IntradayCandle[];
}

export function isIntradayCoin(value: string): value is IntradayCoin {
  return Object.prototype.hasOwnProperty.call(SYMBOLS, value);
}

export function isIntradayInterval(value: string): value is IntradayInterval {
  return Object.prototype.hasOwnProperty.call(INTERVAL_MINUTES, value);
}

export function isSupportedIntradayWindow(interval: IntradayInterval, days: IntradayDays): boolean {
  return SUPPORTED_DAYS[interval].includes(days);
}

function parsePrice(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,30}(?:\.\d{1,30})?$/.test(value)) {
    throw new IntradayError('invalid_response');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new IntradayError('invalid_response');
  return number;
}

function responseDate(headers: Headers, receivedAt: number): number {
  const value = headers.get('date');
  if (!value) throw new IntradayError('unavailable');
  const observed = Date.parse(value);
  if (!Number.isFinite(observed) || new Date(observed).toUTCString() !== value ||
      Math.abs(receivedAt - observed) > MAX_CLOCK_SKEW_MS) {
    throw new IntradayError('unavailable');
  }
  return observed;
}

function retryAfter(headers: Headers): { seconds: number; indefinite: boolean } {
  const raw = headers.get('retry-after');
  if (!raw || !/^\d+$/.test(raw)) return { seconds: 60, indefinite: false };
  // Never shorten a provider ban. A number too large to represent safely is
  // blocked until process restart; advertise a bounded local polling delay.
  if (raw.length > 12) return { seconds: 86_400, indefinite: true };
  return { seconds: Math.max(1, Number(raw)), indefinite: false };
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d{1,12}$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new IntradayError('invalid_response');
  }
  if (!response.body) throw new IntradayError('invalid_response');
  const reader = response.body.getReader();
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelRead, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let result = '';
  let done = false;
  try {
    if (signal.aborted) throw new IntradayError('unavailable');
    while (true) {
      const part = await reader.read();
      if (part.done) { done = true; break; }
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new IntradayError('invalid_response');
      result += decoder.decode(part.value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof IntradayError) throw error;
    throw new IntradayError('invalid_response');
  } finally {
    signal.removeEventListener('abort', cancelRead);
    if (!done) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A timed-out read may still be pending. */ }
  }
}

function parseCandles(body: string, start: number, end: number, intervalMs: number, observedAt: number): IntradayCandle[] {
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new IntradayError('invalid_response'); }
  const expected = (end - start) / intervalMs;
  if (!Array.isArray(rows) || rows.length > expected || rows.length > 1000) {
    throw new IntradayError('invalid_response');
  }
  if (rows.length !== expected) throw new IntradayError('data_gap');
  const candles: IntradayCandle[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row: unknown = rows[index];
    if (!Array.isArray(row) || row.length !== 12) throw new IntradayError('invalid_response');
    const [openTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume, inclusiveClose, , trades] = row;
    if (!Number.isSafeInteger(openTime) || openTime <= 0 || !Number.isSafeInteger(inclusiveClose) ||
        inclusiveClose !== openTime + intervalMs - 1 || !Number.isSafeInteger(trades) || trades < 0) {
      throw new IntradayError('invalid_response');
    }
    if (openTime !== start + index * intervalMs) throw new IntradayError('data_gap');
    // The Date header has only second precision. Leave an additional second
    // after the exclusive close before treating the bar as complete.
    const timestamp = inclusiveClose + 1;
    if (timestamp > observedAt - 1000) throw new IntradayError('data_gap');
    const open = parsePrice(rawOpen);
    const high = parsePrice(rawHigh);
    const low = parsePrice(rawLow);
    const close = parsePrice(rawClose);
    const volume = parsePrice(rawVolume);
    if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new IntradayError('invalid_response');
    }
    if (trades === 0) throw new IntradayError('data_gap');
    if (volume === 0) throw new IntradayError('invalid_response');
    candles.push({ timestamp, open, high, low, close });
  }
  return candles;
}

type ClientOptions = { fetcher?: typeof fetch; now?: () => number; deadlineMs?: number };
type CacheEntry = { value: IntradayHistory; createdAt: number };

export function createBinanceIntradayClient(options: ClientOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 8000;
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<IntradayHistory>>();
  let calls: number[] = [];
  let active = 0;
  let blockedUntil = 0;

  async function load(coinId: IntradayCoin, interval: IntradayInterval, days: IntradayDays): Promise<IntradayHistory> {
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > 8_640_000_000_000_000) {
      throw new IntradayError('unavailable');
    }
    calls = calls.filter((time) => time > startedAt - BUDGET_WINDOW_MS);
    if (startedAt < blockedUntil) {
      throw new IntradayError('rate_limited', Number.isFinite(blockedUntil) ? Math.ceil((blockedUntil - startedAt) / 1000) : 86_400);
    }
    if (active >= MAX_CONCURRENT) throw new IntradayError('rate_limited', 1);
    if (calls.length >= MAX_CALLS_PER_WINDOW) {
      throw new IntradayError('rate_limited', Math.max(1, Math.ceil((calls[0] + BUDGET_WINDOW_MS - startedAt) / 1000)));
    }
    calls.push(startedAt);
    active += 1;
    const intervalMinutes = INTERVAL_MINUTES[interval];
    const intervalMs = intervalMinutes * 60_000;
    const end = Math.floor((startedAt - 1000) / intervalMs) * intervalMs;
    const start = end - days * 86_400_000;
    const limit = (end - start) / intervalMs;
    if (start <= 0 || !Number.isSafeInteger(end)) {
      active -= 1;
      throw new IntradayError('unavailable');
    }
    const url = new URL(KLINES_URL);
    url.searchParams.set('symbol', SYMBOLS[coinId]);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(start));
    url.searchParams.set('endTime', String(end - 1));
    url.searchParams.set('limit', String(limit));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new IntradayError('unavailable'));
        }, deadlineMs);
      });
      const work = (async () => {
        const response = await fetcher(url, {
          method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
          cache: 'no-store', signal: controller.signal,
        });
        if (response.status === 429 || response.status === 418) {
          const { seconds, indefinite } = retryAfter(response.headers);
          const until = now() + seconds * 1000;
          blockedUntil = indefinite || !Number.isSafeInteger(until) ? Infinity : Math.max(blockedUntil, until);
          void response.body?.cancel().catch(() => {});
          throw new IntradayError('rate_limited', seconds);
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new IntradayError('unavailable');
        }
        let observed: number;
        try { observed = responseDate(response.headers, now()); }
        catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
        const body = await readBounded(response, controller.signal);
        const retrieved = now();
        const candles = parseCandles(body, start, end, intervalMs, observed);
        return {
          coinId, source: 'Binance Spot', quote: 'USDT', interval, intervalMinutes, days,
          timestampKind: 'close', observedAt: new Date(observed).toISOString(),
          retrievedAt: new Date(retrieved).toISOString(), coveredStart: start, coveredEnd: end,
          count: candles.length, candles,
        } satisfies IntradayHistory;
      })();
      return await Promise.race([work, timeout]);
    } catch (error) {
      if (error instanceof IntradayError) throw error;
      throw new IntradayError('unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      active -= 1;
    }
  }

  async function get(
    coinId: IntradayCoin,
    interval: IntradayInterval,
    days: IntradayDays,
    address = 'unknown',
  ): Promise<IntradayHistory> {
    // Defensive checks also protect non-route callers from unsupported windows.
    if (!isIntradayCoin(coinId) || !isIntradayInterval(interval) || (days !== 1 && days !== 7) ||
        !isSupportedIntradayWindow(interval, days)) throw new IntradayError('unavailable');
    const key = `${coinId}:${interval}:${days}`;
    const time = now();
    const cached = cache.get(key);
    if (cached && time >= cached.createdAt && time - cached.createdAt < CACHE_MS) return cached.value;
    const ongoing = pending.get(key);
    if (ongoing) return ongoing;
    const releaseClientSlot = acquireClientSlotForAddress(address, 'binance-intraday', 2);
    if (!releaseClientSlot) throw new IntradayError('rate_limited', 1);
    const promise = load(coinId, interval, days).then((value) => {
      cache.set(key, { value, createdAt: now() });
      return value;
    }).finally(() => {
      pending.delete(key);
      releaseClientSlot();
    });
    pending.set(key, promise);
    return promise;
  }
  return { get };
}

const state = globalThis as typeof globalThis & { __paypalBinanceIntradayClient?: ReturnType<typeof createBinanceIntradayClient> };
const client = state.__paypalBinanceIntradayClient ??= createBinanceIntradayClient();
export const getIntradayCandles = client.get;
