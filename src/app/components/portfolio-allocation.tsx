"use client";

import { useMemo, useState } from "react";
import { AgCharts } from "ag-charts-react";
import { DonutSeriesModule, type AgChartOptions } from "ag-charts-community";
import { allocationShareLabel, portfolioAllocation } from "@/lib/portfolio-allocation";
import { formatPortfolioMoney as valueLabel } from "@/lib/market-format";
import type { MarketCurrency } from "@/lib/market-currency";
import type { TrackedCoin } from "@/lib/market-assets";
import type { PortfolioSummary } from "@/lib/portfolio-summary";
import { marketChartThemeFor } from "@/lib/market-chart-theme";
import styles from "./portfolio-allocation.module.css";
import { useAppearance } from "./theme-preference";

const chartModules = [DonutSeriesModule];
type AllocationChartDatum = { id: TrackedCoin; name: string; symbol: string; color: string; value: number; share: number };

const ASSETS: Record<TrackedCoin, { name: string; symbol: string; color: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", color: "#e78a16" },
  ethereum: { name: "Ethereum", symbol: "ETH", color: "#6774d7" },
  solana: { name: "Solana", symbol: "SOL", color: "#7855d9" },
  chainlink: { name: "Chainlink", symbol: "LINK", color: "#2a5ada" },
  litecoin: { name: "Litecoin", symbol: "LTC", color: "#7590ad" },
  "bitcoin-cash": { name: "Bitcoin Cash", symbol: "BCH", color: "#078761" },
  "paypal-usd": { name: "PayPal USD", symbol: "PYUSD", color: "#0070e0" },
};

export default function PortfolioAllocation({ portfolio, currency, inputMessage, loading }: {
  portfolio: PortfolioSummary;
  currency: MarketCurrency;
  inputMessage: string;
  loading: boolean;
}) {
  const [selectedId, setSelectedId] = useState<TrackedCoin | null>(null);
  const { appearance } = useAppearance();
  const slices = useMemo(() => inputMessage ? null : portfolioAllocation(portfolio.positions, portfolio.total), [inputMessage, portfolio.positions, portfolio.total]);
  const selected = slices?.find((slice) => slice.id === selectedId) ?? null;
  const chartData = useMemo<AllocationChartDatum[]>(() => slices?.map((slice) => ({
    id: slice.id,
    ...ASSETS[slice.id],
    value: slice.value,
    share: slice.share,
  })) ?? [], [slices]);
  const chartOptions = useMemo<AgChartOptions<AllocationChartDatum>>(() => ({
    theme: marketChartThemeFor(appearance),
    background: { visible: false },
    animation: { enabled: false },
    legend: { enabled: false },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    series: [{
      type: "donut",
      data: chartData,
      angleKey: "value",
      legendItemKey: "symbol",
      innerRadiusRatio: 0.68,
      outerRadiusRatio: 0.96,
      fills: chartData.map((datum) => datum.color),
      strokes: chartData.map((datum) => datum.color),
      strokeWidth: 0,
      cursor: "pointer",
      listeners: { seriesNodeClick: ({ datum }) => setSelectedId(datum.id) },
      itemStyler: ({ datum }) => datum.id === selectedId
        ? { stroke: appearance === "light" ? "#10213e" : "#f7fafc", strokeWidth: 3 }
        : { stroke: datum.color, strokeWidth: 0 },
      tooltip: {
        renderer: ({ datum }) => ({
          heading: datum.name,
          data: [
            { label: "Allocation", value: allocationShareLabel(datum.share) },
            { label: "Estimated value", value: valueLabel(datum.value, currency) },
          ],
        }),
      },
    }],
  }), [appearance, chartData, currency, selectedId]);
  const missing = portfolio.positions.filter((position) => position.value === null).length;
  const unavailable = inputMessage || (!portfolio.positions.length
    ? "Add a quantity to see how your portfolio is divided."
    : missing
      ? `${loading ? "Waiting for an updated price or estimate for" : "A usable reference price or estimate is needed for"} ${missing} ${missing === 1 ? "holding" : "holdings"} before the full allocation can be shown.`
      : portfolio.total === 0
        ? "The entered holdings have no positive estimated value to divide yet."
        : "The complete allocation is unavailable until every holding can be valued.");

  return (
    <section className={styles.panel} aria-labelledby="portfolio-allocation-title">
      <div className={styles.heading}>
        <div><p className={styles.eyebrow}>PORTFOLIO MIX</p><h2 id="portfolio-allocation-title">Your allocation</h2></div>
        <span className={styles.badge}>Manual estimate</span>
      </div>
      {slices ? <div className={styles.content}>
        <div className={styles.chartWrap}>
          <div className={styles.chart} role="group" aria-label={`Portfolio allocation chart: ${chartData.map((datum) => `${datum.name} ${allocationShareLabel(datum.share)}`).join(", ")}`}>
            <AgCharts className="ag-market-chart" modules={chartModules} options={chartOptions} />
          </div>
          <div className={styles.chartCenter} aria-live="polite">
            <span>{selected ? ASSETS[selected.id].symbol : "TOTAL VALUE"}</span>
            <strong>{selected ? allocationShareLabel(selected.share) : valueLabel(portfolio.total!, currency)}</strong>
            <small>{selected ? valueLabel(selected.value, currency) : `${slices.length} ${slices.length === 1 ? "holding" : "holdings"}`}</small>
          </div>
        </div>
        <div className={styles.details}>
          <div className={styles.detailHeader}><span>Select an asset</span>{selected && <button type="button" className={styles.clear} onClick={() => setSelectedId(null)}>Show total</button>}</div>
          <ul className={styles.legend}>
            {slices.map((slice) => {
              const asset = ASSETS[slice.id];
              const selectedSlice = selected?.id === slice.id;
              return <li key={slice.id}><button type="button" className={styles.legendButton} aria-pressed={selectedSlice} aria-label={`${asset.name}, ${valueLabel(slice.value, currency)}, ${allocationShareLabel(slice.share)} of portfolio`} onClick={() => setSelectedId(slice.id)}>
                <span className={styles.swatch} style={{ backgroundColor: asset.color }} aria-hidden="true" />
                <span className={styles.asset}><strong>{asset.name}</strong><small>{asset.symbol}</small></span>
                <span className={styles.amount}><strong>{allocationShareLabel(slice.share)}</strong><small>{valueLabel(slice.value, currency)}</small></span>
              </button></li>;
            })}
          </ul>
          <p className={styles.caption}>Share of estimated value, not investment return. Percentages are rounded.</p>
        </div>
      </div> : <div className={styles.empty} role="status"><span className={styles.emptyMark} aria-hidden="true" /><div><strong>Allocation unavailable</strong><p>{unavailable}</p></div></div>}
    </section>
  );
}
