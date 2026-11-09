import { formatCurrency, isDisplayCurrency, type DisplayCurrency } from './currency';
import type { Candle } from './candle-series';

export const MARKET_API_DEFAULT = 'https://paypal-markets-companion.onrender.com';

export const ASSETS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', monogram: '₿', color: '#F7931A' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', monogram: '◆', color: '#627EEA' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', monogram: '◎', color: '#7C5CFF' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', monogram: '⬡', color: '#2A5ADA' },
  { id: 'litecoin', symbol: 'LTC', name: 'Litecoin', monogram: 'Ł', color: '#345D9D' },
  { id: 'bitcoin-cash', symbol: 'BCH', name: 'Bitcoin Cash', monogram: 'Ƀ', color: '#0AC18E' },
  { id: 'paypal-usd', symbol: 'PYUSD', name: 'PayPal USD', monogram: '$', color: '#0070E0' },
] as const;

export type CoinId = (typeof ASSETS)[number]['id'];
export type ChartDays = 1 | 7 | 30 | 90 | 365;
export type Metric = 'price' | 'marketCap' | 'volume';

export interface MarketCoin {
  id: CoinId;
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

export interface MarketOverview {
  currency: DisplayCurrency;
  provider: 'CoinGecko';
  retrievedAt: string;
  coins: MarketCoin[];
}

export interface ChartPoint {
  timestamp: number;
  value: number;
}

export interface MarketChart {
  coinId: CoinId;
  currency: DisplayCurrency;
  days: ChartDays;
  provider: 'CoinGecko';
  retrievedAt: string;
  seriesSource: 'market_chart' | 'market_overview_sparkline';
  availableMetrics: Metric[];
  prices: ChartPoint[];
  marketCaps: ChartPoint[];
  volumes: ChartPoint[];
}

export interface MarketCandles {
  coinId: CoinId;
  currency: DisplayCurrency;
  days: ChartDays;
  source: 'CoinGecko';
  retrievedAt: string;
  candleIntervalMinutes: 30 | 240 | 5760;
  timestampKind: 'close';
  candles: Candle[];
}

const INTRADAY_INTERVAL_MINUTES = { '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 } as const;
export type IntradayInterval = keyof typeof INTRADAY_INTERVAL_MINUTES;
export type IntradayDays = 1 | 7;
const SUPPORTED_INTRADAY_DAYS: Record<IntradayInterval, readonly IntradayDays[]> = {
  '3m': [1], '5m': [1], '15m': [1, 7], '30m': [1, 7], '1h': [1, 7], '4h': [1, 7], '1d': [7],
};
export function supportsIntradayWindow(interval: IntradayInterval, days: IntradayDays): boolean {
  return SUPPORTED_INTRADAY_DAYS[interval].includes(days);
}
export function preferredIntradayDays(interval: IntradayInterval): IntradayDays {
  return interval === '1d' ? 7 : 1;
}
export interface IntradayCandles {
  coinId: Exclude<CoinId, 'paypal-usd'>;
  source: 'Binance Spot';
  quote: 'USDT';
  interval: IntradayInterval;
  intervalMinutes: (typeof INTRADAY_INTERVAL_MINUTES)[IntradayInterval];
  days: IntradayDays;
  timestampKind: 'close';
  observedAt: string;
  retrievedAt: string;
  coveredStart: number;
  coveredEnd: number;
  count: number;
  candles: Candle[];
}

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  /** Cache writes wait until the corresponding saved snapshot is read. */
  cacheReady?: boolean;
  /** A response the customer can inspect when its timestamp is older. */
  networkAlternative?: T | null;
  /** Keep an explicit response choice while an earlier cache read settles. */
  networkSelected?: boolean;
}

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || MARKET_API_DEFAULT).replace(/\/+$/, '');
const MAX_MARKET_RESPONSE_BYTES = 1024 * 1024;
const MAX_OVERVIEW_SPARKLINE_POINTS = 512;
const MAX_CHART_POINTS_PER_METRIC = 2400;

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoinId(value: unknown): value is CoinId {
  return ASSETS.some((asset) => asset.id === value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableNonnegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function isMarketOverview(value: unknown): value is MarketOverview {
  if (!isRecord(value) || !isDisplayCurrency(value.currency) || value.provider !== 'CoinGecko' || !isUtcTimestamp(value.retrievedAt) || !Array.isArray(value.coins) || value.coins.length === 0 || value.coins.length > ASSETS.length) return false;
  const seen = new Set<CoinId>();
  return value.coins.every((coin) => {
    if (!isRecord(coin) || !isCoinId(coin.id) || seen.has(coin.id)) return false;
    seen.add(coin.id);
    return (
      typeof coin.name === 'string' && coin.name.length <= 128 &&
      typeof coin.symbol === 'string' && coin.symbol.length <= 32 &&
      (coin.rank === null || (typeof coin.rank === 'number' && Number.isInteger(coin.rank) && coin.rank > 0)) &&
      isNullableNonnegativeNumber(coin.price) &&
      isNullableNonnegativeNumber(coin.marketCap) &&
      isNullableNonnegativeNumber(coin.volume24h) &&
      isNullableNumber(coin.change24hPct) &&
      isNullableNumber(coin.change7dPct) &&
      isNullableNonnegativeNumber(coin.high24h) &&
      isNullableNonnegativeNumber(coin.low24h) &&
      Array.isArray(coin.sparkline7d) &&
      coin.sparkline7d.length <= MAX_OVERVIEW_SPARKLINE_POINTS &&
      coin.sparkline7d.every((point) => typeof point === 'number' && Number.isFinite(point) && point >= 0) &&
      (coin.lastUpdated === null || (typeof coin.lastUpdated === 'string' && coin.lastUpdated.length <= 64))
    );
  });
}

function isChartPoint(value: unknown): value is ChartPoint {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value)
  );
}

export function isMarketChart(value: unknown): value is MarketChart {
  if (
    !isRecord(value) ||
    !isCoinId(value.coinId) ||
    !isDisplayCurrency(value.currency) ||
    value.provider !== 'CoinGecko' ||
    !isUtcTimestamp(value.retrievedAt) ||
    ![1, 7, 30, 90, 365].includes(value.days as number) ||
    (value.seriesSource !== 'market_chart' && value.seriesSource !== 'market_overview_sparkline') ||
    !Array.isArray(value.availableMetrics) ||
    value.availableMetrics.length > 3 ||
    !value.availableMetrics.every((metric) => metric === 'price' || metric === 'marketCap' || metric === 'volume') ||
    new Set(value.availableMetrics).size !== value.availableMetrics.length ||
    !Array.isArray(value.prices) ||
    value.prices.length > MAX_CHART_POINTS_PER_METRIC ||
    !Array.isArray(value.marketCaps) ||
    value.marketCaps.length > MAX_CHART_POINTS_PER_METRIC ||
    !Array.isArray(value.volumes) ||
    value.volumes.length > MAX_CHART_POINTS_PER_METRIC
  ) {
    return false;
  }
  return value.prices.every(isChartPoint) && value.marketCaps.every(isChartPoint) && value.volumes.every(isChartPoint);
}

/** Never turn sampled line prices into OHLC: accept only bounded provider candles. */
export function isMarketCandles(value: unknown): value is MarketCandles {
  if (!isRecord(value) || !isCoinId(value.coinId) || !isDisplayCurrency(value.currency)
      || ![1, 7, 30, 90, 365].includes(value.days as number) || value.source !== 'CoinGecko'
      || !isUtcTimestamp(value.retrievedAt) || value.timestampKind !== 'close'
      || ![30, 240, 5760].includes(value.candleIntervalMinutes as number)
      || !Array.isArray(value.candles) || value.candles.length > 1000) return false;
  const expectedInterval = value.days === 1 ? 30 : value.days === 7 || value.days === 30 ? 240 : 5760;
  if (value.candleIntervalMinutes !== expectedInterval) return false;
  let previousTimestamp = 0;
  return value.candles.every((candle) => {
    if (!isRecord(candle) || typeof candle.timestamp !== 'number' || !Number.isSafeInteger(candle.timestamp)
        || candle.timestamp <= previousTimestamp || !Number.isFinite(new Date(candle.timestamp).getTime())
        || typeof candle.open !== 'number' || !Number.isFinite(candle.open) || candle.open < 0
        || typeof candle.high !== 'number' || !Number.isFinite(candle.high) || candle.high < 0
        || typeof candle.low !== 'number' || !Number.isFinite(candle.low) || candle.low < 0
        || typeof candle.close !== 'number' || !Number.isFinite(candle.close) || candle.close < 0
        || candle.low > candle.open || candle.low > candle.close
        || candle.high < candle.open || candle.high < candle.close || candle.low > candle.high) return false;
    previousTimestamp = candle.timestamp;
    return true;
  });
}

/** Intraday history is a separate USDT-quoted feed with a complete, closed window. */
export function isIntradayCandles(value: unknown): value is IntradayCandles {
  if (!isRecord(value) || typeof value.interval !== 'string' || !Object.prototype.hasOwnProperty.call(INTRADAY_INTERVAL_MINUTES, value.interval)) return false;
  const interval = value.interval as IntradayInterval;
  const intervalMinutes = INTRADAY_INTERVAL_MINUTES[interval];
  if ((value.days !== 1 && value.days !== 7) || !supportsIntradayWindow(interval, value.days)) return false;
  const days = value.days as IntradayDays;
  if (!isCoinId(value.coinId) || value.coinId === 'paypal-usd'
      || value.source !== 'Binance Spot' || value.quote !== 'USDT'
      || typeof value.intervalMinutes !== 'number' || value.intervalMinutes !== intervalMinutes || value.timestampKind !== 'close'
      || !isUtcTimestamp(value.observedAt) || !isUtcTimestamp(value.retrievedAt)
      || !Number.isSafeInteger(value.coveredStart) || !Number.isSafeInteger(value.coveredEnd)
      || typeof value.coveredStart !== 'number' || typeof value.coveredEnd !== 'number'
      || value.coveredStart <= 0 || !Number.isFinite(new Date(value.coveredEnd).getTime())
      || !Array.isArray(value.candles) || !Number.isSafeInteger(value.count)
      || value.count !== value.candles.length || value.candles.length === 0 || value.candles.length > 1000) return false;
  const intervalMs = intervalMinutes * 60_000;
  if (value.coveredStart % intervalMs !== 0 || value.coveredEnd - value.coveredStart !== days * 86_400_000
      || value.candles.length !== days * 86_400_000 / intervalMs
      || value.coveredEnd > new Date(value.observedAt).getTime() - 1000) return false;
  const start = value.coveredStart;
  return value.candles.every((candle, index) => {
    if (!isRecord(candle) || candle.timestamp !== start + (index + 1) * intervalMs
        || typeof candle.open !== 'number' || !Number.isFinite(candle.open) || candle.open < 0
        || typeof candle.high !== 'number' || !Number.isFinite(candle.high) || candle.high < 0
        || typeof candle.low !== 'number' || !Number.isFinite(candle.low) || candle.low < 0
        || typeof candle.close !== 'number' || !Number.isFinite(candle.close) || candle.close < 0
        || candle.low > candle.open || candle.low > candle.close
        || candle.high < candle.open || candle.high < candle.close || candle.low > candle.high) return false;
    return true;
  });
}

function exceedsMarketBodyLimit(text: string): boolean {
  if (text.length > MAX_MARKET_RESPONSE_BYTES) return true;
  if (text.length * 3 <= MAX_MARKET_RESPONSE_BYTES) return false;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > MAX_MARKET_RESPONSE_BYTES) return true;
  }
  return false;
}

function requestJson<T>(path: string, validate: (value: unknown) => value is T, signal?: AbortSignal, missingRouteMessage?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finishError = (message: string, abort = false) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (abort) {
        try { request.abort(); } catch { /* The request may not have opened yet. */ }
      }
      reject(new Error(message));
    };
    const finishSuccess = (value: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finishError('Market request canceled.', true);
    if (signal?.aborted) {
      finishError('Market request canceled.');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request.open('GET', `${API_BASE_URL}${path}`);
      request.timeout = 20_000;
      request.responseType = 'text';
      request.setRequestHeader('Accept', 'application/json');
    } catch {
      finishError('Check your connection and try again.', true);
      return;
    }
    request.onreadystatechange = () => {
      if (request.readyState !== 2) return;
      const header = request.getResponseHeader('Content-Length');
      if (header && /^\d+$/.test(header) && Number(header) > MAX_MARKET_RESPONSE_BYTES) {
        finishError('The market service returned a response that was too large.', true);
      }
    };
    request.onprogress = (event) => {
      if (event.loaded > MAX_MARKET_RESPONSE_BYTES || exceedsMarketBodyLimit(request.responseText)) {
        finishError('The market service returned a response that was too large.', true);
      }
    };
    request.onerror = () => finishError('Check your connection and try again.');
    request.ontimeout = () => finishError('The market service took too long to respond.');
    request.onabort = () => finishError('Market request canceled.');
    request.onload = () => {
      if (settled) return;
      if (exceedsMarketBodyLimit(request.responseText)) {
        finishError('The market service returned a response that was too large.');
        return;
      }
      if (request.status === 404 && missingRouteMessage) {
        finishError(missingRouteMessage);
        return;
      }
      if (request.status === 429) {
        finishError('Market data is busy right now. Try refreshing in a minute.');
        return;
      }
      if (request.status >= 500) {
        finishError('Market data is temporarily unavailable.');
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        finishError('The market service could not load this view.');
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        finishError('The market service returned an unexpected response.');
        return;
      }
      if (!validate(payload)) {
        finishError('The market service returned an unexpected response.');
        return;
      }
      finishSuccess(payload);
    };
    try {
      request.send();
    } catch {
      finishError('Check your connection and try again.', true);
    }
  });
}

export function fetchMarketOverview(currency: DisplayCurrency, signal?: AbortSignal): Promise<MarketOverview> {
  return requestJson(
    `/api/market/quotes?currency=${currency}`,
    (value): value is MarketOverview => isMarketOverview(value) && value.currency === currency,
    signal,
    'The market service needs an update before display-currency prices can load. Please try again later.',
  );
}

export function fetchMarketChart(coinId: CoinId, days: ChartDays, currency: DisplayCurrency, signal?: AbortSignal): Promise<MarketChart> {
  return requestJson(`/api/market/chart/${coinId}?days=${days}&currency=${currency}`, (value): value is MarketChart =>
    isMarketChart(value) && value.coinId === coinId && value.days === days && value.currency === currency, signal);
}

/** React Native delivers text incrementally; abort when either transport or decoded body exceeds the cap. */
function requestCandles<T>(path: string, validate: (value: unknown) => value is T, signal: AbortSignal | undefined, intraday: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finishError = (message: string, abort = false) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (abort) {
        try { request.abort(); } catch { /* The request may not have opened yet. */ }
      }
      reject(new Error(message));
    };
    const onAbort = () => finishError('Market request canceled.', true);
    if (signal?.aborted) {
      finishError('Market request canceled.');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request.open('GET', `${API_BASE_URL}${path}`);
      request.timeout = 20_000;
      request.responseType = 'text';
      request.setRequestHeader('Accept', 'application/json');
    } catch {
      finishError('Check your connection and try again.', true);
      return;
    }
    request.onreadystatechange = () => {
      if (request.readyState !== 2) return;
      const header = request.getResponseHeader('Content-Length');
      if (header && /^\d+$/.test(header) && Number(header) > MAX_MARKET_RESPONSE_BYTES) {
        finishError('The candlestick response was too large.', true);
      }
    };
    request.onprogress = (event) => {
      if (event.loaded > MAX_MARKET_RESPONSE_BYTES || exceedsMarketBodyLimit(request.responseText)) {
        finishError('The candlestick response was too large.', true);
      }
    };
    request.onerror = () => finishError('Check your connection and try again.');
    request.ontimeout = () => finishError('The market service took too long to respond.');
    request.onabort = () => finishError('Market request canceled.');
    request.onload = () => {
      if (settled) return;
      if (exceedsMarketBodyLimit(request.responseText)) return finishError('The candlestick response was too large.');
      if (request.status === 404) return finishError('Candlestick data is not available on this version of the market service yet.');
      if (request.status === 429) return finishError(intraday ? 'Binance candle data is rate limited. Please try again later.' : 'Market data is busy right now. Try refreshing in a minute.');
      if (request.status >= 500) {
        if (intraday && request.status === 503) {
          try {
            const error: unknown = JSON.parse(request.responseText);
            if (isRecord(error) && isRecord(error.error) && error.error.code === 'intraday_data_gap') {
              return finishError('This window has missing or no-trade intervals. Try another interval or Auto.');
            }
          } catch { /* Keep service errors generic. */ }
        }
        return finishError(intraday ? 'Intraday market data is temporarily unavailable.' : 'Market data is temporarily unavailable.');
      }
      if (request.status < 200 || request.status >= 300) return finishError('The market service could not load this view.');
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        return finishError('The market service returned an unexpected response.');
      }
      if (!validate(payload)) {
        return finishError('The market service returned an unexpected response.');
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(payload);
    };
    try { request.send(); } catch { finishError('Check your connection and try again.', true); }
  });
}

export function fetchMarketCandles(coinId: CoinId, days: ChartDays, currency: DisplayCurrency, signal?: AbortSignal): Promise<MarketCandles> {
  return requestCandles(`/api/market/candles/${coinId}?days=${days}&currency=${currency}`,
    (value): value is MarketCandles => isMarketCandles(value) && value.coinId === coinId && value.days === days && value.currency === currency,
    signal, false);
}

export function fetchIntradayCandles(coinId: CoinId, interval: IntradayInterval, days: IntradayDays, signal?: AbortSignal): Promise<IntradayCandles> {
  return requestCandles(`/api/market/intraday/${coinId}?interval=${interval}&days=${days}`,
    (value): value is IntradayCandles => isIntradayCandles(value) && value.coinId === coinId && value.interval === interval && value.days === days,
    signal, true);
}

export function pointsForMetric(chart: MarketChart, metric: Metric): ChartPoint[] {
  if (metric === 'marketCap') return chart.marketCaps;
  if (metric === 'volume') return chart.volumes;
  return chart.prices;
}

/** Sort a copy by time; equal timestamps retain their provider order. */
export function chronologicalChartPoints<T extends { timestamp: number }>(points: readonly T[]): T[] {
  return points
    .map((point, index) => ({ point, index }))
    .sort((left, right) => left.point.timestamp - right.point.timestamp || left.index - right.index)
    .map(({ point }) => point);
}

/** A percentage across one instant is not a period change. */
export function chartPercentageChange(points: readonly { timestamp: number; value: number }[]): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || !Number.isFinite(first.timestamp) || !Number.isFinite(last.timestamp)
      || first.timestamp >= last.timestamp || !Number.isFinite(first.value) || !Number.isFinite(last.value) || first.value === 0) return null;
  const change = (last.value / first.value - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

export function selectHeadlineMetric(quote: MarketCoin | null, metric: Metric, lastPoint?: ChartPoint): { value: number | null; source: 'overview' | 'chart' | 'unavailable' } {
  const overviewValue = !quote ? null : metric === 'marketCap' ? quote.marketCap : metric === 'volume' ? quote.volume24h : quote.price;
  if (typeof overviewValue === 'number' && Number.isFinite(overviewValue)) return { value: overviewValue, source: 'overview' };
  if (lastPoint && Number.isFinite(lastPoint.value)) return { value: lastPoint.value, source: 'chart' };
  return { value: null, source: 'unavailable' };
}

export function formatUsd(value: number | null | undefined, compact = false): string {
  return formatCurrency(value, 'USD', compact);
}

/** Keep candle values legible while retaining extra precision for small prices. */
export function formatCandlePrice(value: number, currency: DisplayCurrency, precisePrice = false): string {
  if (!Number.isFinite(value)) return '—';
  const safeCurrency = isDisplayCurrency(currency) ? currency : 'USD';
  const magnitude = Math.abs(value);
  if (value !== 0 && (magnitude < 1e-8 || magnitude >= 1e15)) return `${safeCurrency} ${Number(value.toPrecision(6)).toExponential()}`;
  const standard = new Intl.NumberFormat('en-US', { style: 'currency', currency: safeCurrency }).resolvedOptions();
  const minimum = Math.max(standard.minimumFractionDigits ?? 0, precisePrice ? 4 : 0);
  const usualMaximum = Math.max(minimum, standard.maximumFractionDigits ?? 2);
  const maximum = precisePrice ? Math.max(8, usualMaximum)
    : magnitude >= 1000 ? Math.max(2, usualMaximum)
      : magnitude >= 1 ? Math.max(6, usualMaximum)
        : magnitude >= 0.01 ? Math.max(8, usualMaximum)
          : magnitude > 0 ? Math.max(8, Math.min(12, 5 - Math.floor(Math.log10(magnitude))), usualMaximum)
            : usualMaximum;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: safeCurrency,
    minimumFractionDigits: minimum,
    maximumFractionDigits: maximum,
  }).format(value);
}

/** USDT prices are crypto quotes, never fiat currency or a dollar amount. */
export function formatIntradayPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (value !== 0 && (magnitude < 1e-8 || magnitude >= 1e15)) return `${Number(value.toPrecision(6)).toExponential()} USDT`;
  const maximum = magnitude >= 1000 ? 2 : magnitude >= 1 ? 6 : magnitude >= 0.01 ? 8 : magnitude > 0 ? Math.min(12, Math.max(8, 5 - Math.floor(Math.log10(magnitude)))) : 2;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maximum }).format(value)} USDT`;
}

export function formatQuantity(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(numeric);
}

export function formatChange(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'Time unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/** Provider update fields are optional and must be valid UTC timestamps. */
export function formatProviderUpdate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return 'Time unavailable';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return 'Time unavailable';
  return formatTimestamp(date.getTime());
}

/** Distinguish the displayed view from a conflicting response before selection. */
export function formatRetrievalComparison(displayedAt: string | null | undefined, responseAt: string | null | undefined): string | null {
  if (!responseAt) return null;
  return `Displayed view retrieved ${formatTimestamp(displayedAt)}\nResponse retrieved ${formatTimestamp(responseAt)}`;
}

/** Sparkline fallback timestamps are estimates, not observed chart times. */
export function formatChartSampleTime(point: ChartPoint | undefined, source: MarketChart['seriesSource'] | undefined): string {
  const label = source === 'market_overview_sparkline' ? 'Estimated sample time' : 'Chart sample time';
  return `${label} ${formatTimestamp(point?.timestamp)}`;
}

export function metricLabel(metric: Metric): string {
  if (metric === 'marketCap') return 'Market cap';
  if (metric === 'volume') return '24h volume';
  return 'Price';
}

export function metricValueLabel(metric: Metric, value: number | null | undefined, currency: DisplayCurrency, highPrecision = false): string {
  return formatCurrency(value, currency, metric !== 'price', metric === 'price' && highPrecision ? 4 : undefined);
}

export function shouldShowUsdPeg(isPaypalUsd: boolean, metric: Metric, currency: DisplayCurrency): boolean {
  return isPaypalUsd && metric === 'price' && currency === 'USD';
}

export function describeMarketChart(metric: Metric, low: number, high: number, currency: DisplayCurrency, isPaypalUsd: boolean, delta: number | null): string {
  const guide = shouldShowUsdPeg(isPaypalUsd, metric, currency) ? ' A dashed line marks the $1.00 USD peg.' : '';
  const change = delta === null ? 'not available' : `${delta > 0 ? 'plus ' : ''}${delta.toFixed(2)} percent`;
  return `${metricLabel(metric)} chart ranges from ${metricValueLabel(metric, low, currency, isPaypalUsd)} to ${metricValueLabel(metric, high, currency, isPaypalUsd)}.${guide} Range change ${change}.`;
}
