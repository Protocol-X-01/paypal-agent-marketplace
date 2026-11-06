import type { MarketCandles } from "@/lib/market-data";
import type { MarketInsightRequest, MarketInsightSource } from "../../../../../packages/ai-insights/contracts";
import { InsightError } from "../../../../../packages/ai-insights/src/core";

/** Derive facts only from the selected bounded provider candles, never browser input. */
export function marketInsightSource(selection: MarketInsightRequest, chart: MarketCandles): MarketInsightSource {
  const expectedInterval = selection.days === 1 ? 30 : selection.days <= 30 ? 240 : 5760;
  if (chart.source !== "CoinGecko" || chart.coinId !== selection.coinId || chart.currency !== selection.currency || chart.days !== selection.days ||
      chart.timestampKind !== "close" || chart.candleIntervalMinutes !== expectedInterval || !Number.isFinite(Date.parse(chart.retrievedAt)) ||
      chart.candles.length < 2 || chart.candles.length > 1000) throw new InsightError("market_data_unavailable", 503);
  const all = chart.candles;
  if (!all.every((point, index) => Number.isSafeInteger(point.timestamp) && point.timestamp > 0 &&
      [point.open, point.high, point.low, point.close].every((value) => Number.isFinite(value) && value >= 0) &&
      point.low <= Math.min(point.open, point.close) && point.high >= Math.max(point.open, point.close) &&
      (index === 0 || point.timestamp > all[index - 1].timestamp))) {
    throw new InsightError("market_data_unavailable", 503);
  }
  // Do not describe a candle whose declared close lies after retrieval time.
  const points = all.filter((point) => point.timestamp <= Date.parse(chart.retrievedAt));
  if (points.length < 2) throw new InsightError("market_data_unavailable", 503);
  const first = points[0];
  const last = points[points.length - 1];
  const change = first.close > 0 ? (last.close - first.close) / first.close * 100 : null;
  if (change !== null && !Number.isFinite(change)) throw new InsightError("market_data_unavailable", 503);
  return {
    ...selection,
    provider: "CoinGecko",
    retrievedAt: chart.retrievedAt,
    sampleCount: points.length,
    candleIntervalMinutes: chart.candleIntervalMinutes,
    timestampKind: "close",
    priceBasis: "candle_close",
    rangeBasis: "candle_high_low",
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    firstPrice: first.close,
    lastPrice: last.close,
    low: Math.min(...points.map((point) => point.low)),
    high: Math.max(...points.map((point) => point.high)),
    changePercent: change,
  };
}
