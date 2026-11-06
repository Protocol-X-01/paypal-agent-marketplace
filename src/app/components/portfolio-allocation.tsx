"use client";

import { useState } from "react";
import { allocationShareLabel, portfolioAllocation } from "@/lib/portfolio-allocation";
import { formatMarketMoney } from "@/lib/market-format";
import type { MarketCurrency } from "@/lib/market-currency";
import type { TrackedCoin } from "@/lib/market-assets";
import type { PortfolioSummary } from "@/lib/portfolio-summary";
import styles from "./portfolio-allocation.module.css";

const ASSETS: Record<TrackedCoin, { name: string; symbol: string; color: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", color: "#e78a16" },
  ethereum: { name: "Ethereum", symbol: "ETH", color: "#6774d7" },
  solana: { name: "Solana", symbol: "SOL", color: "#7855d9" },
  chainlink: { name: "Chainlink", symbol: "LINK", color: "#2a5ada" },
  litecoin: { name: "Litecoin", symbol: "LTC", color: "#7590ad" },
  "bitcoin-cash": { name: "Bitcoin Cash", symbol: "BCH", color: "#078761" },
  "paypal-usd": { name: "PayPal USD", symbol: "PYUSD", color: "#0070e0" },
};

function valueLabel(value: number, currency: MarketCurrency) {
  return value > 0 && value < 0.000001
    ? `Less than ${formatMarketMoney(0.000001, currency)}`
    : formatMarketMoney(value, currency);
}

export default function PortfolioAllocation({ portfolio, currency, inputMessage, loading }: {
  portfolio: PortfolioSummary;
  currency: MarketCurrency;
  inputMessage: string;
  loading: boolean;
}) {
  const [selectedId, setSelectedId] = useState<TrackedCoin | null>(null);
  const slices = inputMessage ? null : portfolioAllocation(portfolio.positions, portfolio.total);
  const selected = slices?.find((slice) => slice.id === selectedId) ?? null;
  const missing = portfolio.positions.filter((position) => position.value === null).length;
  const unavailable = inputMessage || (!portfolio.positions.length
    ? "Add a quantity to see how your portfolio is divided."
    : missing
      ? `${loading ? "Waiting for" : "Reference prices are needed for"} ${missing} ${missing === 1 ? "holding" : "holdings"} before the full allocation can be shown.`
      : portfolio.total === 0
        ? "The entered holdings have no positive estimated value to divide yet."
        : "The complete allocation is unavailable until every holding can be valued.");

  return (
    <section className={styles.panel} aria-labelledby="portfolio-allocation-title">
      <div className={styles.heading}>
        <div><p className={styles.eyebrow}>PORTFOLIO MIX</p><h2 id="portfolio-allocation-title">Your allocation</h2><p>Based on your entered quantities and {currency} reference prices.</p></div>
        <span className={styles.badge}>Manual estimate</span>
      </div>
      {slices ? <div className={styles.content}>
        <div className={styles.chartWrap}>
          <svg className={styles.chart} viewBox="14 14 172 172" aria-hidden="true">
            <circle cx="100" cy="100" r="72" fill="none" stroke="#e5eef8" strokeWidth="22" />
            {slices.map((slice) => <circle key={slice.id} cx="100" cy="100" r="72" fill="none" pathLength="100" stroke={ASSETS[slice.id].color} strokeWidth={selected?.id === slice.id ? "26" : "22"} strokeDasharray={`${slice.share} ${100 - slice.share}`} strokeDashoffset={-slice.start} transform="rotate(-90 100 100)" onClick={() => setSelectedId(slice.id)} className={styles.slice} />)}
          </svg>
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
