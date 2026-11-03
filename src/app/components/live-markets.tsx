"use client";

import { useEffect, useState } from "react";
import type { MarketCoin, MarketOverview, TrackedCoin } from "@/lib/market-data";
import styles from "../home.module.css";

function formatMoney(value: number | null, compact = false, stablecoin = false) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: stablecoin ? 4 : undefined,
    maximumFractionDigits: compact ? 2 : stablecoin ? 6 : value < 1 ? 4 : 0,
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
  const up = values[values.length - 1] >= values[0];
  return <svg className={styles.sparkline} viewBox="0 0 120 40" role="img" aria-label={`${coin.name} seven day price history${stablecoin ? " on a scale centered around the $1.00 peg" : ""}`}>{pegY !== null && <line x1="0" x2="120" y1={pegY} y2={pegY} stroke="#d59b3c" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}<polyline points={points} fill="none" stroke={up ? "#62c5a6" : "#f08a7e"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
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
  const [coins, setCoins] = useState<MarketCoin[]>([]);
  const [retrievedAt, setRetrievedAt] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/market/coins", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Market data unavailable");
        return response.json() as Promise<MarketOverview>;
      })
      .then((data) => {
        if (!Array.isArray(data.coins)) throw new Error("Market data unavailable");
        setCoins(data.coins);
        setRetrievedAt(data.retrievedAt);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, []);

  const heroCoin = coins.find((coin) => coin.id === "bitcoin");
  if (variant === "hero") {
    return <div className={styles.heroMarket} aria-live="polite">
      {heroCoin ? <>
        <div className={styles.heroCoinHeading}><AssetSymbol coin={heroCoin} /><div><strong>{heroCoin.name}</strong><span>{heroCoin.symbol} · Rank {heroCoin.rank ? `#${heroCoin.rank}` : "—"}</span></div></div>
        <div className={styles.heroCoinPrice}><strong>{formatMoney(heroCoin.priceUsd)}</strong><span className={heroCoin.change24hPct !== null && heroCoin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(heroCoin.change24hPct)} <small>24h</small></span></div>
        <Sparkline coin={heroCoin} />
        <div className={styles.heroMetrics}><span>Market cap <strong>{formatMoney(heroCoin.marketCapUsd, true)}</strong></span><span>24h volume <strong>{formatMoney(heroCoin.volume24hUsd, true)}</strong></span></div>
        <div className={styles.heroOthers}>{coins.filter((coin) => coin.id !== "bitcoin").map((coin) => <div key={coin.id}><span>{coin.symbol}{coin.id === "paypal-usd" ? " · USD stablecoin" : ""}</span><strong>{formatMoney(coin.priceUsd, false, coin.id === "paypal-usd")}</strong><small className={coin.change24hPct !== null && coin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(coin.change24hPct)}</small></div>)}</div>
        <span className={styles.heroTimestamp}>{retrievedAt ? `Updated ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(retrievedAt))}` : "Live market snapshot"}</span>
      </> : <div className={styles.heroLoading} role="status">{status === "error" ? "Market prices are temporarily unavailable." : "Loading market snapshot…"}</div>}
    </div>;
  }

  return <div className={styles.marketCards} aria-live="polite">
    {coins.length ? coins.map((coin) => <article className={styles.marketCard} key={coin.id}>
      <div className={styles.marketCardHead}><AssetSymbol coin={coin} /><span className={styles.rankTag}>{coin.rank ? `RANK ${coin.rank}` : "MARKET"}</span></div>
      <p className={styles.marketName}>{coin.name}<span>{coin.symbol}</span>{coin.id === "paypal-usd" && <small className={styles.stablecoinTag}>USD STABLECOIN</small>}</p>
      <div className={styles.marketCardPrice}><strong>{formatMoney(coin.priceUsd, false, coin.id === "paypal-usd")}</strong><span className={coin.change24hPct !== null && coin.change24hPct < 0 ? styles.down : styles.up}>{formatChange(coin.change24hPct)}</span></div>
      <Sparkline coin={coin} />
      <div className={styles.marketCardFoot}><span>Market cap <strong>{formatMoney(coin.marketCapUsd, true)}</strong></span><span>24h volume <strong>{formatMoney(coin.volume24hUsd, true)}</strong></span></div>
    </article>) : <div className={styles.marketState} role="status">{status === "error" ? "Live market metrics are unavailable. Open the dashboard to retry." : "Loading verified market metrics…"}</div>}
    {retrievedAt && <p className={styles.gridTimestamp}>Market snapshot updated {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(retrievedAt))} · CoinGecko</p>}
  </div>;
}
