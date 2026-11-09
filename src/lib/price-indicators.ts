import { calculateEma, calculateRsi, calculateSma } from "./candle-series";
import type { CandleHistory } from "./web-candle-data";
import { marketChartColors } from "./market-chart-theme";

export type PriceIndicator = "sma" | "ema" | "rsi";
export type PriceIndicatorState = Record<PriceIndicator, boolean>;
export type PriceIndicatorValues = Record<PriceIndicator, (number | null)[]>;
export type IndicatorPoint = { timestamp: number; value: number };
export type LineIndicatorOverlay = { id: "sma" | "ema"; label: string; color: string; segments: IndicatorPoint[][] };
export type IndicatorTimeWindow = { start: number; end: number };

export const EMPTY_PRICE_INDICATORS: PriceIndicatorState = { sma: false, ema: false, rsi: false };
export const PRICE_INDICATORS: { id: PriceIndicator; label: string; minimum: number; color: string }[] = [
  { id: "sma", label: "SMA 20", minimum: 20, color: marketChartColors.sma },
  { id: "ema", label: "EMA 20", minimum: 20, color: marketChartColors.ema },
  { id: "rsi", label: "RSI 14", minimum: 15, color: marketChartColors.rsi },
];

export function hasPriceIndicators(indicators: PriceIndicatorState): boolean {
  return indicators.sma || indicators.ema || indicators.rsi;
}

export function needsCandleHistory({ currencyReady, metric, style, indicators, timestampedLine }: { currencyReady: boolean; metric: "price" | "marketCap" | "volume"; style: "line" | "candles"; indicators: PriceIndicatorState; timestampedLine: boolean }): boolean {
  return currencyReady && metric === "price" && (style === "candles" || (hasPriceIndicators(indicators) && timestampedLine));
}

/** Every value is calculated before any viewport clipping, from actual OHLC closes. */
export function calculatePriceIndicators(history: CandleHistory): PriceIndicatorValues {
  const closes = history.candles.map((candle) => candle.close);
  return { sma: calculateSma(closes), ema: calculateEma(closes), rsi: calculateRsi(closes) };
}

export function candleIntervalLabel(minutes: CandleHistory["candleIntervalMinutes"]): string {
  return minutes < 60 ? `${minutes}-minute candles` : minutes < 1440 ? `${minutes / 60}-hour candles` : `${minutes / 1440}-day candles`;
}

/**
 * Split at warm-up/missing intervals, then clip by time rather than sample index.
 * One genuine neighbor on each side lets the chart clip a valid segment at the
 * viewport edge. No new timestamp, candle, indicator value or extrapolation is made.
 */
export function indicatorSegments(history: CandleHistory, values: readonly (number | null)[], window: IndicatorTimeWindow): IndicatorPoint[][] {
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end < window.start) return [];
  const segments: IndicatorPoint[][] = [];
  let segment: IndicatorPoint[] = [];
  const finish = () => { if (segment.length) segments.push(segment); segment = []; };
  history.candles.forEach((candle, index) => {
    const value = values[index];
    if (value === null || value === undefined || !Number.isFinite(value)) { finish(); return; }
    if (index > 0 && candle.timestamp - history.candles[index - 1].timestamp > history.candleIntervalMinutes * 60_000 * 1.5) finish();
    segment.push({ timestamp: candle.timestamp, value });
  });
  finish();
  return segments.flatMap((points) => {
    if (points[0].timestamp > window.end || points[points.length - 1].timestamp < window.start) return [];
    const first = points.findIndex((point) => point.timestamp >= window.start);
    const after = points.findIndex((point) => point.timestamp > window.end);
    const start = Math.max(0, first - 1);
    const end = after < 0 ? points.length : Math.min(points.length, after + 1);
    return [points.slice(start, end)];
  });
}

export function lineIndicatorOverlays(history: CandleHistory, values: PriceIndicatorValues, indicators: PriceIndicatorState, window: IndicatorTimeWindow, colors = marketChartColors): LineIndicatorOverlay[] {
  return PRICE_INDICATORS.flatMap(({ id, label }) => id === "rsi" || !indicators[id] ? [] : [{ id, label, color: colors[id], segments: indicatorSegments(history, values[id], window) }]);
}

/** Nearest actual close at or before the visible endpoint, within this window. */
export function lastVisibleCandleIndex(history: CandleHistory, window: IndicatorTimeWindow): number | null {
  for (let index = history.candles.length - 1; index >= 0; index--) {
    const timestamp = history.candles[index].timestamp;
    if (timestamp <= window.end) return timestamp >= window.start ? index : null;
  }
  return null;
}
