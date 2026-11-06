"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { AgCharts } from "ag-charts-react";
import { CrossLinesModule, LineSeriesModule, NumberAxisModule, TimeAxisModule, type AgChartOptions } from "ag-charts-community";
import { candleIntervalLabel, lastVisibleCandleIndex, PRICE_INDICATORS, type IndicatorPoint, type IndicatorTimeWindow, type PriceIndicatorState, type PriceIndicatorValues } from "@/lib/price-indicators";
import { formatMarketMoney, formatMarketRetrievalTime } from "@/lib/market-format";
import type { CandleHistory } from "@/lib/web-candle-data";
import type { ChartDays } from "@/lib/market-data";
import type { CandleHistoryRequest } from "./use-candle-history";
import styles from "./candle-history-panel.module.css";

export const TECHNICAL_AXIS_GUTTER = 92;
export const TECHNICAL_TIME_AXIS_HEIGHT = 32;
const rsiModules = [CrossLinesModule, LineSeriesModule, NumberAxisModule, TimeAxisModule];

export function useMarketChartFont() {
  const [family, setFamily] = useState("monospace");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const value = window.getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
      if (value) setFamily(value);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return family;
}

function closeTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(timestamp) + " UTC";
}

export function PriceIndicatorControls({ indicators, onChange, history = null }: { indicators: PriceIndicatorState; onChange: Dispatch<SetStateAction<PriceIndicatorState>>; history?: CandleHistory | null }) {
  const active = Object.values(indicators).filter(Boolean).length;
  return <details className={styles.indicatorMenu}>
    <summary>Indicators{active > 0 ? ` · ${active}` : ""}</summary>
    <div className={styles.indicatorOptions}>
      {PRICE_INDICATORS.map(({ id, label, minimum }) => {
        const short = history !== null && history.candles.length < minimum;
        return <label key={id}><input type="checkbox" checked={indicators[id]} disabled={short && !indicators[id]} onChange={(event) => { const checked = event.currentTarget.checked; onChange((current) => ({ ...current, [id]: checked })); }} /><span>{label}<small>{short ? `Needs ${minimum} candles` : id === "rsi" ? "Separate 0–100 panel" : "Candle-close average"}</small></span></label>;
      })}
      <p>Calculated from actual candle closes across the complete returned series before zooming. Choices carry across Line and Candles; warm-up values stay unavailable.</p>
    </div>
  </details>;
}

export function LineIndicatorStatus({ request, indicators, values, window, approximateLine, lineAvailable, precisePrice = false, onCandles }: {
  request: CandleHistoryRequest; indicators: PriceIndicatorState; values: PriceIndicatorValues | null; window: IndicatorTimeWindow | null;
  approximateLine: boolean; lineAvailable: boolean; precisePrice?: boolean; onCandles: () => void;
}) {
  if (approximateLine) return <div className={styles.lineIndicatorNotice} role="status"><p>Indicators need exact sample times. This fallback price sparkline has approximate times, so overlays are paused. Your choices are kept for timestamped history.</p><button type="button" onClick={onCandles}>Show indicators in Candles</button></div>;
  if (!lineAvailable || !window) return <div className={styles.lineIndicatorNotice} role="status"><p>Indicators will appear when timestamped price history is available. Candle history can load independently.</p><button type="button" onClick={onCandles}>Open Candles</button></div>;
  if (request.status === "loading" || request.status === "idle") return <p className={styles.lineIndicatorNotice} role="status">Loading candle-close indicators… The ordinary price line remains available.</p>;
  if (request.status === "error") return <div className={styles.lineIndicatorNotice} role="status"><p>Candle-close indicators are temporarily unavailable. The ordinary price line is unchanged.</p><button type="button" onClick={request.retry}>Retry indicators</button></div>;
  const { history } = request;
  if (history.source !== "CoinGecko") return <p className={styles.lineIndicatorNotice} role="status">Fiat price-line indicators need matching CoinGecko candle history. Minute USDT candles are available in Candles.</p>;
  if (!history.candles.length || !values) return <p className={styles.lineIndicatorNotice} role="status">No candle history is available for these indicators. The ordinary price line is unchanged.</p>;
  const index = lastVisibleCandleIndex(history, window);
  const gap = history.candles.some((candle, i) => i > 0 && candle.timestamp - history.candles[i - 1].timestamp > history.candleIntervalMinutes * 60_000 * 1.5);
  return <section className={styles.lineIndicatorSummary} aria-label="Candle-close indicator values">
    <div className={styles.lineIndicatorHeading}><strong>Candle-close indicators</strong><span>{candleIntervalLabel(history.candleIntervalMinutes)}</span></div>
    <dl className={styles.indicatorValues}>{PRICE_INDICATORS.filter(({ id }) => indicators[id]).map(({ id, label, color }) => <div key={id}><dt><i style={{ background: color }} />{label}</dt><dd>{index === null ? "Outside candle coverage" : values[id][index] === null ? "Warm-up" : id === "rsi" ? values[id][index]!.toFixed(2) : formatMarketMoney(values[id][index], history.currency, precisePrice ? 6 : 0)}</dd></div>)}</dl>
    <p className={styles.provenance}>{index !== null ? `Last close in view: ${closeTime(history.candles[index].timestamp)}. ` : "No observed candle closes fall inside this view. "}CoinGecko OHLC retrieved {formatMarketRetrievalTime(history.retrievedAt)}. Averages use the full returned history and can differ from the finer price-line samples.{gap ? " Missing intervals remain gaps in indicator lines." : ""}</p>
  </section>;
}

export function PriceLineRsi({ segments, window, days }: { segments: IndicatorPoint[][]; window: IndicatorTimeWindow; days: ChartDays }) {
  const fontFamily = useMarketChartFont();
  type Datum = { timestamp: Date; value: number };
  const data = segments.flat();
  if (!data.length) return <div className={styles.lineRsiEmpty} role="status"><strong>RSI 14</strong><p>No warmed-up RSI observations cover this view. RSI needs 15 actual candle closes.</p></div>;
  const options: AgChartOptions<Datum> = {
    background: { visible: false }, animation: { enabled: false }, legend: { enabled: false },
    padding: { top: 10, right: 34, bottom: 8, left: 16 },
    axes: {
      x: { type: "time", position: "bottom", min: new Date(window.start), max: new Date(window.end), nice: false, thickness: TECHNICAL_TIME_AXIS_HEIGHT,
        label: { format: days === 1 ? "%H:%M" : days === 365 ? "%b %y" : "%d %b", color: "#526781", fontFamily, fontSize: 11, minSpacing: 56 },
        gridLine: { enabled: false }, tick: { enabled: false }, line: { stroke: "#e9edf5" } },
      y: { type: "number", position: "left", min: 0, max: 100, nice: false, thickness: TECHNICAL_AXIS_GUTTER,
        label: { color: "#526781", fontFamily, fontSize: 11 }, tick: { enabled: false },
        gridLine: { enabled: false }, crossLines: [30, 70].map((value) => ({ type: "line" as const, value, stroke: "#d5ddec", strokeWidth: 1, lineDash: [4, 5] })) },
    },
    series: segments.map((segment, index) => ({
      type: "line", id: `rsi-${index}`, data: segment.map((point) => ({ timestamp: new Date(point.timestamp), value: point.value })),
      xKey: "timestamp", yKey: "value", yName: "RSI 14 · candle close", stroke: "#5364b9", strokeWidth: 2,
      marker: { enabled: segment.length === 1, size: 4 }, connectMissingData: false,
      tooltip: { renderer: ({ datum }) => ({ heading: closeTime(datum.timestamp.getTime()), data: [{ label: "RSI 14 · candle close", value: datum.value.toFixed(2) }] }) },
    })),
  };
  return <section className={styles.lineRsiPanel} aria-label="RSI 14 from actual candle closes"><div className={styles.rsiHeading}><strong>RSI 14</strong><span>0–100 · guides at 30 and 70 · same time window as price</span></div><div className={styles.lineRsiChart} role="img" aria-label={`RSI 14, ${data.length} observations including viewport-edge neighbors. Calculated from actual OHLC closes; scale 0 to 100. Hover an observation for its UTC close time and value.`}><AgCharts className="ag-market-chart" modules={rsiModules} options={options} /></div></section>;
}
