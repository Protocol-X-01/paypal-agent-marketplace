import type { TrackedCoin } from "./market-assets";
import type { ChartDays } from "./market-data";
import type { ChartViewport } from "./chart-viewport";
import type { PriceIndicatorState } from "./price-indicators";
import type { CandleIntervalChoice, CandleViewSnapshot, IntradayDays } from "./web-candle-data";

/** Public chart controls only. Never add holdings, reports, searches, contacts or drafts. */
export type PublicChartControls = {
  selectedId: TrackedCoin;
  days: ChartDays;
  metric: "price" | "marketCap" | "volume";
  style: "line" | "candles";
  indicators: PriceIndicatorState;
  viewport: ChartViewport;
  candleView: CandleViewSnapshot | null;
  candleInterval: CandleIntervalChoice;
  intradayDays: IntradayDays;
};

export function createPublicChartControls(): PublicChartControls {
  return { selectedId: "bitcoin", days: 7, metric: "price", style: "line", indicators: { sma: false, ema: false, rsi: false }, viewport: { start: 0, end: 1 }, candleView: null, candleInterval: "auto", intradayDays: 1 };
}
