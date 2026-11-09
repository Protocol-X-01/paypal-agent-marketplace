import { calculateEma, calculateRsi, calculateSma, type Candle } from './candle-series';

export type LineIndicator = 'sma' | 'ema' | 'rsi';
export type IndicatorSelection = Record<LineIndicator, boolean>;
export interface IndicatorPoint { timestamp: number; value: number }
export type IndicatorSegments = IndicatorPoint[][];

/** Compute on all closes first; clip only observed candle-close timestamps to the line viewport. */
export function buildVisibleLineIndicators(candles: readonly Candle[], from: number, to: number, intervalMinutes: number, enabled: IndicatorSelection) {
  const segments: Record<LineIndicator, IndicatorSegments> = { sma: [], ema: [], rsi: [] };
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return { segments, visibleCandles: 0 };
  }
  const closes = candles.map((candle) => candle.close);
  const values: Record<LineIndicator, (number | null)[]> = {
    sma: enabled.sma ? calculateSma(closes) : [],
    ema: enabled.ema ? calculateEma(closes) : [],
    rsi: enabled.rsi ? calculateRsi(closes) : [],
  };
  const visibleCandles = candles.filter((candle) => candle.timestamp >= from && candle.timestamp <= to).length;
  const gapThreshold = intervalMinutes * 60_000 * 1.5;
  for (const indicator of ['sma', 'ema', 'rsi'] as const) {
    if (!enabled[indicator]) continue;
    let previous: number | null = null;
    let current: IndicatorPoint[] = [];
    candles.forEach((candle, index) => {
      if (candle.timestamp < from || candle.timestamp > to) return;
      const value = values[indicator][index];
      if (value === null || value === undefined || !Number.isFinite(value)) {
        previous = null;
        current = [];
        return;
      }
      if (previous === null || candle.timestamp - previous > gapThreshold) {
        current = [];
        segments[indicator].push(current);
      }
      current.push({ timestamp: candle.timestamp, value });
      previous = candle.timestamp;
    });
  }
  return { segments, visibleCandles };
}

/** Each move command starts an actual observed segment; one-point segments get markers. */
export function projectIndicatorSegments(segments: IndicatorSegments, x: (timestamp: number) => number, y: (value: number) => number) {
  const singletons: { x: number; y: number }[] = [];
  const paths = segments.map((segment) => {
    if (segment.length === 1) singletons.push({ x: x(segment[0]!.timestamp), y: y(segment[0]!.value) });
    return segment.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.timestamp).toFixed(2)} ${y(point.value).toFixed(2)}`).join(' ');
  });
  return { path: paths.join(' '), singletons };
}
