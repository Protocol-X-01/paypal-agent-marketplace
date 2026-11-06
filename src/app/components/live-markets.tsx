"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { MarketCoin, MarketOverview, TrackedCoin } from "@/lib/market-data";
import { formatMarketRetrievalTime } from "@/lib/market-format";
import styles from "../home.module.css";

type MarketSnapshotState = {
  coins: MarketCoin[];
  retrievedAt: string | null;
  status: "loading" | "ready" | "error";
};

const MarketSnapshotContext = createContext<MarketSnapshotState | null>(null);

/** The hero and market cards share one effect and one snapshot. */
export function MarketSnapshotProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshotState>({ coins: [], retrievedAt: null, status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/market/coins", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Market data unavailable");
        return response.json() as Promise<MarketOverview>;
      })
      .then((data) => {
        if (!Array.isArray(data.coins)) throw new Error("Market data unavailable");
        if (!controller.signal.aborted) {
          setSnapshot({
            coins: data.coins,
            retrievedAt: typeof data.retrievedAt === "string" ? data.retrievedAt : null,
            status: "ready",
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSnapshot({ coins: [], retrievedAt: null, status: "error" });
      });
    return () => controller.abort();
  }, []);

  return <MarketSnapshotContext.Provider value={snapshot}>{children}</MarketSnapshotContext.Provider>;
}

function formatMoney(value: number | null, compact = false, stablecoin = false) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? undefined : stablecoin ? 4 : 2,
    maximumFractionDigits: compact ? 2 : stablecoin || Math.abs(value) < 1 ? 6 : 2,
  }).format(value);
}

function formatChange(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function Sparkline({ coin }: { coin: MarketCoin }) {
  const values = coin.sparkline7d;
  if (values.length < 2) return <span className={styles.sparkFallback} aria-label="Seven day chart unavailable" />;
  const actualMin = Math.min(...values);
  const actualMax = Math.max(...values);
  const stablecoin = coin.id === "paypal-usd";
  const padding = Math.max((actualMax - actualMin) * 0.12, 0.002);
  const min = stablecoin ? Math.min(actualMin - padding, 0.98) : actualMin;
  const max = stablecoin ? Math.max(actualMax + padding, 1.02) : actualMax;
  const span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 120},${35 - ((value - min) / span) * 28}`).join(" ");
  const pegY = stablecoin ? 35 - ((1 - min) / span) * 28 : null;
  return <svg className={styles.sparkline} viewBox="0 0 120 40" role="img" aria-label={`${coin.name} seven day price history${stablecoin ? " on a scale centered around the $1.00 peg" : ""}`}>{pegY !== null && <line x1="0" x2="120" y1={pegY} y2={pegY} stroke="#d59b3c" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}<polyline points={points} fill="none" stroke="#00CCFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
}

function AssetSymbol({ coin }: { coin: MarketCoin }) {
  const meta: Record<TrackedCoin, { symbol: string; className: string }> = {
    bitcoin: { symbol: "₿", className: styles.bitcoin },
    ethereum: { symbol: "◆", className: styles.ethereum },
    solana: { symbol: "S", className: styles.solana },
    chainlink: { symbol: "L", className: styles.chainlink },
    litecoin: { symbol: "Ł", className: styles.litecoin },
    "bitcoin-cash": { symbol: "B", className: styles.bitcoinCash },
    "paypal-usd": { symbol: "$", className: styles.paypalUsd },
  };
  const { symbol, className } = meta[coin.id];
  return <span className={`${styles.assetSymbol} ${className}`} aria-hidden="true">{symbol}</span>;
}

export default function LiveMarkets({ variant }: { variant: "hero" | "grid" }) {
  const snapshot = useContext(MarketSnapshotContext);
  if (!snapshot) throw new Error("LiveMarkets requires MarketSnapshotProvider");
  const { coins, retrievedAt, status } = snapshot;
  const retrievalTime = formatMarketRetrievalTime(retrievedAt);

  const heroCoin = coins.find((coin) => coin.id === "bitcoin");
  if (variant === "hero") {
    return <div className={styles.heroMarket} aria-live="polite">
      {heroCoin ? <>
        <div className={styles.heroCoinHeading}><AssetSymbol coin={heroCoin} /><div><strong>{heroCoin.name}</strong><span>{heroCoin.symbol} · Rank {heroCoin.rank ? `#${heroCoin.rank}` : "—"}</span></div></div>
        <div className={styles.heroCoinPrice}><strong>{formatMoney(heroCoin.priceUsd)}</strong><span className={heroCoin.change24hPct !== null && heroCoin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(heroCoin.change24hPct)} <small>24h</small></span></div>
        <Sparkline coin={heroCoin} />
        <div className={styles.heroMetrics}><span>Market cap <strong>{formatMoney(heroCoin.marketCapUsd, true)}</strong></span><span>24h volume <strong>{formatMoney(heroCoin.volume24hUsd, true)}</strong></span></div>
        <div className={styles.heroOthers}>{coins.filter((coin) => coin.id !== "bitcoin").map((coin) => <div key={coin.id}><span>{coin.symbol}{coin.id === "paypal-usd" ? " · USD stablecoin" : ""}</span><strong>{formatMoney(coin.priceUsd, false, coin.id === "paypal-usd")}</strong><small className={coin.change24hPct !== null && coin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(coin.change24hPct)}</small></div>)}</div>
        <span className={styles.heroTimestamp}>{retrievalTime ? `Snapshot retrieved ${retrievalTime}` : "Snapshot retrieval time unavailable"}</span>
      </> : <div className={styles.heroLoading} role="status">{status === "error" ? "Market prices are temporarily unavailable." : status === "ready" ? "Bitcoin is unavailable in this snapshot." : "Loading market snapshot…"}</div>}
    </div>;
  }

  return <div className={styles.marketCards} aria-live="polite">
    {coins.length ? coins.map((coin) => <article className={styles.marketCard} key={coin.id}>
      <div className={styles.marketCardHead}><AssetSymbol coin={coin} /><span className={styles.rankTag}>{coin.rank ? `RANK ${coin.rank}` : "MARKET"}</span></div>
      <p className={styles.marketName}>{coin.name}<span>{coin.symbol}</span>{coin.id === "paypal-usd" && <small className={styles.stablecoinTag}>USD STABLECOIN</small>}</p>
      <div className={styles.marketCardPrice}><strong>{formatMoney(coin.priceUsd, false, coin.id === "paypal-usd")}</strong><span className={coin.change24hPct !== null && coin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(coin.change24hPct)}</span></div>
      <Sparkline coin={coin} />
      <div className={styles.marketCardFoot}><span>Market cap <strong>{formatMoney(coin.marketCapUsd, true)}</strong></span><span>24h volume <strong>{formatMoney(coin.volume24hUsd, true)}</strong></span></div>
    </article>) : <div className={styles.marketState} role="status">{status === "error" ? "Market metrics are unavailable. Open the dashboard to retry." : status === "ready" ? "No market prices are available in this snapshot." : "Loading CoinGecko market metrics…"}</div>}
    {coins.length > 0 && <p className={styles.gridTimestamp}>{retrievalTime ? `Snapshot retrieved ${retrievalTime}` : "Snapshot retrieval time unavailable"} · CoinGecko</p>}
  </div>;
}
