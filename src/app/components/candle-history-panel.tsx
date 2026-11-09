"use client";

import { useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";
import { candleIndexAtRatio } from "@/lib/candle-series";
import { formatMarketMoney, formatMarketRetrievalTime, formatUsdtPrice } from "@/lib/market-format";
import { calculatePriceIndicators, candleIntervalLabel, EMPTY_PRICE_INDICATORS, type PriceIndicatorState } from "@/lib/price-indicators";
import { candleHistoryIdentity, candleSelectionIdentity, captureCandleView, candlePriceDomain, candleWindowWheelZoom, moveCandleWindow, normalizedCandleWindow, restoreCandleView, type CandleHistory, type CandleSelection, type CandleViewSnapshot, type CandleWindow } from "@/lib/web-candle-data";
import { PriceIndicatorControls } from "./price-chart-indicators";
import { useCandleHistory, type CandleHistoryRequest } from "./use-candle-history";
import { usePlotWheelZoom } from "./use-plot-wheel-zoom";
import styles from "./candle-history-panel.module.css";

const WIDTH = 800;
const HEIGHT = 250;
const PAD_X = 12;
const PAD_Y = 18;

function candleTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(timestamp) + " UTC";
}

type IndicatorProps = { indicators?: PriceIndicatorState; onIndicatorsChange?: Dispatch<SetStateAction<PriceIndicatorState>>; showIndicatorControls?: boolean; viewSnapshot?: CandleViewSnapshot | null; onViewSnapshotChange?: (next: CandleViewSnapshot) => void };

export default function CandleHistoryPanel({ coinId, currency, days, intraday, precisePrice = false, request: sharedRequest, ...indicatorProps }: CandleSelection & { precisePrice?: boolean; request?: CandleHistoryRequest } & IndicatorProps) {
  const identity = candleSelectionIdentity({ coinId, currency, days, intraday });
  const ownRequest = useCandleHistory({ coinId, currency, days, intraday, enabled: sharedRequest === undefined });
  const request = sharedRequest ?? ownRequest;
  if (request.status === "idle" || request.status === "loading") return <div className={styles.requestState} role="status">Loading candle history…</div>;
  if (request.status === "error") return <div className={styles.requestState} role="status"><p>{request.message ?? "Candle history is temporarily unavailable."}</p><button type="button" onClick={request.retry}>Retry candle history</button></div>;
  if (candleHistoryIdentity(request.history) !== identity) return <div className={styles.requestState} role="status">Loading candle history…</div>;
  if (!request.history.candles.length) return <div className={styles.requestState} role="status"><p>No candle history is available for this asset and range.</p><button type="button" onClick={request.retry}>Check again</button></div>;
  return <CandlePlot key={`${identity}:${request.history.retrievedAt}`} history={request.history} precisePrice={precisePrice} {...indicatorProps} />;
}

export function CandlePlot({ history, precisePrice = false, indicators: controlledIndicators, onIndicatorsChange, showIndicatorControls = true, viewSnapshot, onViewSnapshotChange }: { history: CandleHistory; precisePrice?: boolean } & IndicatorProps) {
  const { candles, currency } = history;
  const restoredView = restoreCandleView(history, viewSnapshot);
  const [window, setWindow] = useState<CandleWindow>(() => restoredView.window ?? { start: Math.max(0, candles.length - Math.min(60, candles.length)), end: candles.length });
  const [selected, setSelected] = useState<number>(() => restoredView.selected ?? Math.max(0, candles.length - 1));
  const [localIndicators, setLocalIndicators] = useState<PriceIndicatorState>({ ...EMPTY_PRICE_INDICATORS });
  const indicators = controlledIndicators ?? localIndicators;
  const setIndicators = onIndicatorsChange ?? setLocalIndicators;
  const gesture = useRef<{ pointerId: number; x: number; y: number; captured: boolean } | null>(null);
  const pricePlotRef = useRef<SVGSVGElement | null>(null);
  const range = normalizedCandleWindow(candles.length, window);
  usePlotWheelZoom({
    elementRef: pricePlotRef, view: range,
    getBounds: () => {
      const rect = pricePlotRef.current?.getBoundingClientRect();
      return rect ? { left: rect.left + PAD_X / WIDTH * rect.width, top: rect.top + PAD_Y / HEIGHT * rect.height, width: (WIDTH - PAD_X * 2) / WIDTH * rect.width, height: (HEIGHT - PAD_Y * 2) / HEIGHT * rect.height } : null;
    },
    project: (view, factor, ratio) => candleWindowWheelZoom(candles.length, view, factor, ratio),
    onChange: (next, previous, ratio) => { const index = candleIndexAtRatio(ratio, previous.start, previous.end) ?? next.end - 1; setWindow(next); setSelected(index); onViewSnapshotChange?.(captureCandleView(history, next, index)); },
  });
  const selectedIndex = Math.max(range.start, Math.min(range.end - 1, selected ?? candles.length - 1));
  const current = candles[selectedIndex];
  const visible = candles.slice(range.start, range.end);
  const { sma, ema, rsi } = useMemo(() => calculatePriceIndicators(history), [history]);
  const domain = candlePriceDomain(visible, precisePrice && currency === "USD", [
    ...(indicators.sma ? sma.slice(range.start, range.end) : []),
    ...(indicators.ema ? ema.slice(range.start, range.end) : []),
  ]);
  const slotWidth = (WIDTH - PAD_X * 2) / visible.length;
  const xPosition = (index: number) => PAD_X + (index - range.start + 0.5) * slotWidth;
  const yPosition = (value: number) => PAD_Y + (domain.high - value) / (domain.high - domain.low) * (HEIGHT - PAD_Y * 2);
  const rsiY = (value: number) => 8 + (100 - value) / 100 * 84;
  const money = (value: number | null) => history.source === "Binance Spot" ? formatUsdtPrice(value) : formatMarketMoney(value, history.currency, precisePrice ? 6 : 0);
  const activeIndicators = Object.values(indicators).filter(Boolean).length;
  const gap = candles.some((candle, index) => index > 0 && candle.timestamp - candles[index - 1].timestamp !== history.candleIntervalMinutes * 60_000);
  const change = current.close - current.open;
  const selectedDescription = `Candle ${selectedIndex + 1} of ${candles.length}, close time ${candleTime(current.timestamp)}. Open ${money(current.open)}, high ${money(current.high)}, low ${money(current.low)}, close ${money(current.close)}.`;

  function select(index: number) {
    const next = Math.max(0, Math.min(candles.length - 1, index));
    setSelected(next);
    if (next < range.start || next >= range.end) {
      const span = range.end - range.start;
      const start = Math.max(0, Math.min(candles.length - span, next < range.start ? next : next - span + 1));
      const nextWindow = { start, end: start + span };
      setWindow(nextWindow);
      onViewSnapshotChange?.(captureCandleView(history, nextWindow, next));
    }
  }

  function moveWindow(action: "in" | "out" | "earlier" | "later" | "reset") {
    const next = moveCandleWindow(candles.length, range, action, selectedIndex);
    const index = Math.max(next.start, Math.min(next.end - 1, selectedIndex));
    setWindow(next);
    setSelected(index);
    onViewSnapshotChange?.(captureCandleView(history, next, index));
  }

  function selectAt(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const position = (event.clientX - rect.left) / rect.width * WIDTH;
    const index = candleIndexAtRatio((position - PAD_X) / (WIDTH - PAD_X * 2), range.start, range.end);
    if (index !== null) setSelected(index);
  }

  function startPointer(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, captured: event.pointerType === "mouse" };
    if (event.pointerType === "mouse") { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }
    selectAt(event);
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && !gesture.current) { selectAt(event); return; }
    const currentGesture = gesture.current;
    if (!currentGesture || currentGesture.pointerId !== event.pointerId) return;
    if (!currentGesture.captured) {
      const dx = Math.abs(event.clientX - currentGesture.x);
      const dy = Math.abs(event.clientY - currentGesture.y);
      if (dy > 6 && dy >= dx) { gesture.current = null; return; }
      if (dx < 6 || dx <= dy) return;
      currentGesture.captured = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (event.cancelable) event.preventDefault();
    selectAt(event);
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gesture.current = null;
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === "ArrowLeft" ? selectedIndex - 1 : event.key === "ArrowRight" ? selectedIndex + 1
      : event.key === "Home" ? 0 : event.key === "End" ? candles.length - 1
        : event.key === "PageUp" ? selectedIndex - Math.max(1, Math.floor(visible.length / 2))
          : event.key === "PageDown" ? selectedIndex + Math.max(1, Math.floor(visible.length / 2)) : null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  }

  function indicatorPath(series: readonly (number | null)[], project: (value: number) => number) {
    let started = false;
    return series.slice(range.start, range.end).map((value, offset) => {
      if (value === null) { started = false; return ""; }
      const index = range.start + offset;
      // Do not draw a continuous indicator through a missing candle interval.
      if (offset > 0 && candles[index].timestamp - candles[index - 1].timestamp > history.candleIntervalMinutes * 60_000 * 1.5) started = false;
      const command = `${started ? "L" : "M"}${xPosition(index).toFixed(2)},${project(value).toFixed(2)}`;
      started = true;
      return command;
    }).join(" ");
  }

  return (
    <section className={styles.panel} aria-label="Historical candle inspection">
      <div className={styles.readout}>
        <div className={styles.readoutTop}>
          <div><p className={styles.eyebrow}>Candle {selectedIndex + 1} of {candles.length}</p><p className={styles.closePrice}>{money(current.close)} <span className={styles.closeLabel}>close</span></p></div>
          <div className={styles.time}><span>Candle close time</span><strong>{candleTime(current.timestamp)}</strong></div>
        </div>
        <dl className={styles.ohlc}>
          <div><dt>Open</dt><dd>{money(current.open)}</dd></div><div><dt>High</dt><dd>{money(current.high)}</dd></div>
          <div><dt>Low</dt><dd>{money(current.low)}</dd></div><div><dt>Close</dt><dd className={change >= 0 ? styles.upText : styles.downText}>{money(current.close)}</dd></div>
        </dl>
        {activeIndicators > 0 && <dl className={styles.indicatorValues}>
          {indicators.sma && <div><dt><i className={styles.smaKey} />SMA 20</dt><dd>{sma[selectedIndex] === null ? "Warm-up" : money(sma[selectedIndex])}</dd></div>}
          {indicators.ema && <div><dt><i className={styles.emaKey} />EMA 20</dt><dd>{ema[selectedIndex] === null ? "Warm-up" : money(ema[selectedIndex])}</dd></div>}
          {indicators.rsi && <div><dt><i className={styles.rsiKey} />RSI 14</dt><dd>{rsi[selectedIndex] === null ? "Warm-up" : rsi[selectedIndex]?.toFixed(2)}</dd></div>}
        </dl>}
      </div>

      <div className={styles.controlRow}>
        <span className={styles.interval}>{candleIntervalLabel(history.candleIntervalMinutes)}</span>
        {showIndicatorControls && <PriceIndicatorControls indicators={indicators} onChange={setIndicators} history={history} />}
      </div>

      <div className={styles.plot} role="slider" tabIndex={0} aria-label="Inspect historical candles" aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={candles.length} aria-valuenow={selectedIndex + 1} aria-valuetext={selectedDescription} onKeyDown={keyDown} onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}>
        <svg ref={pricePlotRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className={styles.priceSvg} aria-hidden="true" focusable="false">
          {[0, 1, 2, 3].map((step) => <line key={step} x1={PAD_X} x2={WIDTH - PAD_X} y1={PAD_Y + step / 3 * (HEIGHT - PAD_Y * 2)} y2={PAD_Y + step / 3 * (HEIGHT - PAD_Y * 2)} className={styles.gridLine} />)}
          <rect x={xPosition(selectedIndex) - slotWidth / 2} y={PAD_Y} width={slotWidth} height={HEIGHT - PAD_Y * 2} className={styles.selectionBand} />
          {precisePrice && currency === "USD" && <line x1={PAD_X} x2={WIDTH - PAD_X} y1={yPosition(1)} y2={yPosition(1)} className={styles.pegLine} />}
          {visible.map((candle, offset) => {
            const index = range.start + offset;
            const bodyWidth = Math.max(1, Math.min(14, slotWidth * 0.6));
            const bodyY = yPosition(Math.max(candle.open, candle.close));
            return <g key={candle.timestamp} className={candle.close >= candle.open ? styles.upCandle : styles.downCandle}>
              <line x1={xPosition(index)} x2={xPosition(index)} y1={yPosition(candle.high)} y2={yPosition(candle.low)} vectorEffect="non-scaling-stroke" />
              <rect x={xPosition(index) - bodyWidth / 2} y={bodyY} width={bodyWidth} height={Math.max(1, Math.abs(yPosition(candle.open) - yPosition(candle.close)))} />
            </g>;
          })}
          {indicators.sma && <path d={indicatorPath(sma, yPosition)} className={styles.smaLine} vectorEffect="non-scaling-stroke" />}
          {indicators.ema && <path d={indicatorPath(ema, yPosition)} className={styles.emaLine} vectorEffect="non-scaling-stroke" />}
          <line x1={xPosition(selectedIndex)} x2={xPosition(selectedIndex)} y1={PAD_Y} y2={HEIGHT - PAD_Y} className={styles.crosshair} />
          <line x1={PAD_X} x2={WIDTH - PAD_X} y1={yPosition(current.close)} y2={yPosition(current.close)} className={styles.crosshair} />
          <circle cx={xPosition(selectedIndex)} cy={yPosition(current.close)} r={6} className={styles.selectedPoint} vectorEffect="non-scaling-stroke" />
        </svg>
        {indicators.rsi && <div className={styles.rsiPanel}><div className={styles.rsiHeading}><strong>RSI 14</strong><span>0–100 scale · guides at 30 and 70</span></div><svg viewBox={`0 0 ${WIDTH} 100`} preserveAspectRatio="none" className={styles.rsiSvg} aria-hidden="true" focusable="false">
          {[30, 50, 70].map((value) => <line key={value} x1={PAD_X} x2={WIDTH - PAD_X} y1={rsiY(value)} y2={rsiY(value)} className={styles.rsiGuide} />)}
          <path d={indicatorPath(rsi, rsiY)} className={styles.rsiLine} vectorEffect="non-scaling-stroke" />
          <line x1={xPosition(selectedIndex)} x2={xPosition(selectedIndex)} y1={8} y2={92} className={styles.crosshair} />
          {rsi[selectedIndex] !== null && <circle cx={xPosition(selectedIndex)} cy={rsiY(rsi[selectedIndex]!)} r={5} className={styles.selectedPoint} vectorEffect="non-scaling-stroke" />}
        </svg></div>}
      </div>
      <div className={styles.axisLabels}><span>{candleTime(visible[0].timestamp)}</span><span>{candleTime(visible[visible.length - 1].timestamp)}</span></div>
      <div className={styles.extremes}><span>Low {money(Math.min(...visible.map((candle) => candle.low)))}</span><span>High {money(Math.max(...visible.map((candle) => candle.high)))}</span></div>
      <p className={styles.gestureHint}>Drag across the chart or use the arrow keys to inspect a candle. Scroll over the price plot to zoom at the pointer; page scrolling resumes at the limits.{precisePrice && currency === "USD" ? " Dashed gold line: $1.00 USD peg." : ""}</p>
      <div className={styles.navigation} role="group" aria-label="Candle navigation and zoom">
        <span>Showing {range.start + 1}–{range.end} of {candles.length}</span>
        <div><button type="button" aria-label="Show earlier candles" disabled={range.start === 0} onClick={() => moveWindow("earlier")}>←</button><button type="button" aria-label="Zoom out of candles" disabled={visible.length === candles.length} onClick={() => moveWindow("out")}>−</button><button type="button" disabled={visible.length === candles.length} onClick={() => moveWindow("reset")}>Reset</button><button type="button" aria-label="Zoom into candles" disabled={visible.length <= Math.min(3, candles.length)} onClick={() => moveWindow("in")}>+</button><button type="button" aria-label="Show later candles" disabled={range.end === candles.length} onClick={() => moveWindow("later")}>→</button></div>
      </div>
      <p className={styles.provenance}>{history.source === "Binance Spot" ? <>Binance Spot · {history.quote} quote · {history.interval} trade candles · {history.days}-day complete window. Provider HTTP Date {formatMarketRetrievalTime(history.observedAt)}; this is not an independently verified exchange clock. </> : "CoinGecko OHLC · "}Retrieved {formatMarketRetrievalTime(history.retrievedAt)}. Candle timestamps mark {history.source === "Binance Spot" ? "exclusive " : ""}close time.{gap ? " Missing intervals are not filled; candles are spaced by observation order." : ""}{history.source === "Binance Spot" ? " USDT is a cryptoasset, separate from USD. These are exchange reference prices, not PayPal or Venmo quotes." : ""}</p>
    </section>
  );
}
