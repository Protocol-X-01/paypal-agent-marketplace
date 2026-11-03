"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AgCharts } from "ag-charts-react";
import {
  AreaSeriesModule,
  CrossLinesModule,
  NumberAxisModule,
  TimeAxisModule,
  type AgChartOptions,
} from "ag-charts-community";
import { TRACKED_COINS, type TrackedCoin } from "@/lib/market-assets";
import type { ChartDays, ChartPoint, MarketChart, MarketCoin, MarketOverview } from "@/lib/market-data";

type Tab = "overview" | "markets" | "portfolio" | "business" | "shop" | "settings";
type ChartMetric = "price" | "marketCap" | "volume";
type Amounts = Partial<Record<TrackedCoin, number>>;
import SiteShell from "./components/site-shell";
import Marketplace from "./components/marketplace";
import DataSettings from "./components/data-settings";
import BusinessMonitoring from "./components/business-monitoring";

const STORAGE_KEY = "paypal-markets-manual-holdings-v1";
const WATCHLIST_KEY = "paypal-markets-watchlist-v1";
const EMPTY_COINS: MarketCoin[] = [];
const ranges: Array<{ days: ChartDays; label: string }> = [
  { days: 1, label: "1D" },
  { days: 7, label: "1W" },
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 365, label: "1Y" },
];
const chartMetrics: Array<{ id: ChartMetric; label: string }> = [
  { id: "price", label: "Price" },
  { id: "marketCap", label: "Market cap" },
  { id: "volume", label: "24h volume" },
];
const metricChartModules = [AreaSeriesModule, CrossLinesModule, NumberAxisModule, TimeAxisModule];

function money(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value < 1 ? 2 : 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);
}

function compactMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function chartValue(value: number, metric: ChartMetric) {
  return metric === "price" ? money(value) : compactMoney(value);
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function timestamp(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function pointsPath(
  values: number[],
  width: number,
  height: number,
  close = false,
  domain?: { min: number; max: number },
) {
  if (values.length < 2) return "";
  const min = domain?.min ?? Math.min(...values);
  const max = domain?.max ?? Math.max(...values);
  const span = max - min || Math.abs(max) * 0.001 || 1;
  const coords = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 10) - 5;
    return [x, y] as const;
  });
  const path = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  if (!close) return path;
  return `${path} L${width},${height} L0,${height} Z`;
}

function stablecoinDomain(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.12, 0.002);
  return { min: Math.min(min - padding, 0.98), max: Math.max(max + padding, 1.02) };
}

function Sparkline({ values, down = false, label, stablecoin = false }: { values: number[]; down?: boolean; label: string; stablecoin?: boolean }) {
  if (values.length < 2) return <div className="sparkline-empty" aria-label={`${label}: chart data unavailable`} />;
  const domain = stablecoin ? stablecoinDomain(values) : undefined;
  const line = pointsPath(values, 120, 38, false, domain);
  const pegY = domain ? 38 - ((1 - domain.min) / (domain.max - domain.min)) * 28 - 5 : null;
  return (
    <svg className="sparkline" viewBox="0 0 120 38" role="img" aria-label={`${label}: 7 day price trend${stablecoin ? " on a scale centered around the $1.00 peg" : ""}`}>
      {pegY !== null && <line x1="0" x2="120" y1={pegY} y2={pegY} stroke="#d59b3c" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
      <path d={line} fill="none" stroke={down ? "#e87972" : "#5478e9"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type MetricChartDatum = { timestamp: Date; value: number };

function MetricChart({ points, down, label, metric, days, stablecoin = false }: { points: ChartPoint[]; down: boolean; label: string; metric: ChartMetric; days: ChartDays; stablecoin?: boolean }) {
  const data = useMemo<MetricChartDatum[]>(
    () => points
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .map((point) => ({ timestamp: new Date(point.timestamp), value: point.value })),
    [points],
  );
  const values = data.map((point) => point.value);
  const color = down ? "#e87972" : "#4f77ea";
  const domain = stablecoin && values.length > 0 ? stablecoinDomain(values) : undefined;
  const options: AgChartOptions<MetricChartDatum> = {
    data,
    background: { visible: false },
    animation: { enabled: false },
    padding: { top: 10, right: 12, bottom: 4, left: 8 },
    legend: { enabled: false },
    axes: {
      x: {
        type: "time",
        position: "bottom",
        label: {
          format: days === 1 ? "%H:%M" : days === 365 ? "%b %y" : "%d %b",
          color: "#9ba7b8",
          fontSize: 9,
          minSpacing: 42,
        },
        gridLine: { enabled: false },
        tick: { enabled: false },
        line: { stroke: "#e9edf5" },
      },
      y: {
        type: "number",
        position: "left",
        min: domain?.min,
        max: domain?.max,
        label: {
          formatter: ({ value }) => chartValue(Number(value), metric),
          color: "#9ba7b8",
          fontSize: 9,
        },
        gridLine: { style: [{ stroke: "#e9edf5", strokeWidth: 1, lineDash: [4, 7] }] },
        crossLines: stablecoin
          ? [{
              type: "line",
              value: 1,
              stroke: "#d59b3c",
              strokeWidth: 1.5,
              lineDash: [6, 5],
              label: { text: "$1.00", position: "right", color: "#a57322", fontSize: 9 },
            }]
          : undefined,
      },
    },
    series: [{
      type: "area",
      xKey: "timestamp",
      yKey: "value",
      yName: label,
      fill: color,
      fillOpacity: 0.12,
      stroke: color,
      strokeWidth: 2.5,
      marker: { enabled: false },
      tooltip: {
        renderer: ({ datum }) => ({
          heading: new Intl.DateTimeFormat("en-GB", days === 1
            ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
            : { day: "2-digit", month: "short", year: days === 365 ? "numeric" : undefined },
          ).format(datum.timestamp),
          data: [{ label, value: chartValue(datum.value, metric) }],
        }),
      },
    }],
  };
  if (data.length < 2) {
    return (
      <div className="chart-empty" role="status">
        Chart history is not available for this range yet.
      </div>
    );
  }
  const description = stablecoin
    ? `${label}. USD stablecoin chart with a $1.00 peg reference. From ${chartValue(values[0], metric)} to ${chartValue(values[values.length - 1], metric)}.`
    : `${label}. From ${chartValue(values[0], metric)} to ${chartValue(values[values.length - 1], metric)}.`;
  return (
    <div className="metric-chart" role="img" aria-label={description}>
      <AgCharts className="ag-market-chart" modules={metricChartModules} options={options} />
    </div>
  );
}

function AssetMark({ id }: { id: TrackedCoin }) {
  const meta: Record<TrackedCoin, { symbol: string; color: string; letters: string }> = {
    bitcoin: { symbol: "BTC", color: "#f5a623", letters: "₿" },
    ethereum: { symbol: "ETH", color: "#6370d8", letters: "◆" },
    solana: { symbol: "SOL", color: "#6d58d7", letters: "S" },
    chainlink: { symbol: "LINK", color: "#4267d5", letters: "L" },
    litecoin: { symbol: "LTC", color: "#68798e", letters: "Ł" },
    "bitcoin-cash": { symbol: "BCH", color: "#28a87c", letters: "B" },
    "paypal-usd": { symbol: "PYUSD", color: "#008f79", letters: "$" },
  };
  return <span className="asset-mark" style={{ "--asset-color": meta[id].color } as CSSProperties}>{meta[id].letters}</span>;
}

function defaultWatchlist(): TrackedCoin[] {
  return [...TRACKED_COINS];
}

async function requestOverview(): Promise<MarketOverview> {
  const response = await fetch("/api/market/coins", { cache: "no-store" });
  if (!response.ok) throw new Error("Market prices could not be refreshed.");
  return (await response.json()) as MarketOverview;
}

export default function MarketDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [chart, setChart] = useState<MarketChart | null>(null);
  const [selectedId, setSelectedId] = useState<TrackedCoin>("bitcoin");
  const [days, setDays] = useState<ChartDays>(7);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("price");
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [chartRefresh, setChartRefresh] = useState(0);
  const [chartError, setChartError] = useState("");
  const [amounts, setAmounts] = useState<Amounts>({});
  const [watchlist, setWatchlist] = useState<TrackedCoin[]>(defaultWatchlist());
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [storageWritable, setStorageWritable] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetSort, setAssetSort] = useState("rank");
  const [storageError, setStorageError] = useState("");

  function navigate(next: Tab) {
    setTab(next);
    if (window.location.hash !== `#${next}`) window.history.pushState(null, "", `#${next}`);
  }

  useEffect(() => {
    const readLocation = () => {
      const section = window.location.hash.slice(1);
      const hasProductSearch = new URLSearchParams(window.location.search).has("q");
      setTab(["overview", "markets", "portfolio", "business", "shop", "settings"].includes(section) ? section as Tab : hasProductSearch ? "shop" : "overview");
    };
    const resetData = () => { setAmounts({}); setWatchlist(defaultWatchlist()); setStorageError(""); setStorageWritable(true); };
    const storageFailed = () => setStorageError("Browser storage is unavailable. Your changes may not be saved after you leave.");
    const storageRecovered = () => setStorageError("");
    const timer = window.setTimeout(readLocation, 0);
    window.addEventListener("hashchange", readLocation);
    window.addEventListener("popstate", readLocation);
    window.addEventListener("paypal-markets-data-reset", resetData);
    window.addEventListener("paypal-markets-storage-error", storageFailed);
    window.addEventListener("paypal-markets-storage-recovered", storageRecovered);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", readLocation);
      window.removeEventListener("popstate", readLocation);
      window.removeEventListener("paypal-markets-data-reset", resetData);
      window.removeEventListener("paypal-markets-storage-error", storageFailed);
      window.removeEventListener("paypal-markets-storage-recovered", storageRecovered);
    };
  }, []);

  const loadOverview = useCallback(async () => {
    setLoadingMarket(true);
    setMarketError("");
    try {
      setOverview(await requestOverview());
    } catch {
      setMarketError("Live market prices are unavailable right now. Please try again shortly.");
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestOverview()
      .then((data) => {
        if (!cancelled) {
          setOverview(data);
          setMarketError("");
        }
      })
      .catch(() => {
        if (!cancelled) setMarketError("Live market prices are unavailable right now. Please try again shortly.");
      })
      .finally(() => {
        if (!cancelled) setLoadingMarket(false);
      });
    const hydrateTimer = window.setTimeout(() => {
      let canWrite = true;
      try {
        const savedAmounts = localStorage.getItem(STORAGE_KEY);
        const savedWatchlist = localStorage.getItem(WATCHLIST_KEY);
        if (savedAmounts) {
          const parsed: unknown = JSON.parse(savedAmounts);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid saved holdings.");
          const sanitized: Amounts = {};
          for (const id of TRACKED_COINS) {
            const amount = (parsed as Record<string, unknown>)[id];
            if (typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount <= 1e12) sanitized[id] = amount;
          }
          setAmounts(sanitized);
        }
        if (savedWatchlist) {
          const parsed = JSON.parse(savedWatchlist) as unknown;
          if (!Array.isArray(parsed)) throw new Error("Invalid saved watchlist.");
          const sanitized = Array.from(new Set(parsed.filter((id): id is TrackedCoin =>
            typeof id === "string" && TRACKED_COINS.includes(id as TrackedCoin),
          )));
          const previousDefault = ["bitcoin", "ethereum", "solana"];
          const wasPreviousDefault = sanitized.length === previousDefault.length && previousDefault.every((id) => sanitized.includes(id as TrackedCoin));
          setWatchlist(wasPreviousDefault ? [...TRACKED_COINS] : sanitized);
        }
      } catch {
        canWrite = false;
        setStorageError("Saved browser data could not be read. It has been left untouched; export it or reset local data in Settings.");
      }
      setStorageWritable(canWrite);
      setPreferencesLoaded(true);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(hydrateTimer);
    };
  }, []);

  useEffect(() => {
    if (preferencesLoaded && storageWritable) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(amounts));
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
        window.dispatchEvent(new Event("paypal-markets-storage-recovered"));
      } catch {
        window.dispatchEvent(new Event("paypal-markets-storage-error"));
      }
    }
  }, [amounts, watchlist, preferencesLoaded, storageWritable]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/chart/${selectedId}?days=${days}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Market chart data could not be loaded.");
        return (await response.json()) as MarketChart;
      })
      .then((result) => {
        if (!cancelled) {
          setChart(result);
          setChartError("");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChart(null);
          setChartError("Chart history for this range is unavailable.");
        }
      })
    return () => {
      cancelled = true;
    };
  }, [selectedId, days, chartRefresh]);

  const coins = overview?.coins ?? EMPTY_COINS;
  const selectedCoin = coins.find((coin) => coin.id === selectedId) ?? null;
  const coinById = useMemo(() => new Map(coins.map((coin) => [coin.id, coin])), [coins]);
  const selectedRangeLabel = ranges.find((range) => range.days === days)?.label ?? "1W";
  const chartMatches = chart?.coinId === selectedId && chart.days === days;
  const chartIsLoading = !chartError && !chartMatches;
  const selectedMetricLabel = chartMetrics.find((metric) => metric.id === chartMetric)?.label ?? "Price";
  const chartSeries = chartMatches && chart
    ? chartMetric === "price" ? chart.prices : chartMetric === "marketCap" ? chart.marketCaps : chart.volumes
    : [];
  const chartValues = chartSeries.map((point) => point.value);
  const chartChange = chartValues.length > 1 && chartValues[0] !== 0
    ? ((chartValues[chartValues.length - 1] / chartValues[0]) - 1) * 100
    : chartMetric === "price"
      ? days === 1
        ? selectedCoin?.change24hPct ?? null
        : days === 7
          ? selectedCoin?.change7dPct ?? null
          : null
      : null;
  const latestChartValue = chartValues.length ? chartValues[chartValues.length - 1] : null;
  const selectedMetricValue = chartMetric === "price"
    ? selectedCoin?.priceUsd ?? latestChartValue
    : chartMetric === "marketCap"
      ? selectedCoin?.marketCapUsd ?? latestChartValue
      : selectedCoin?.volume24hUsd ?? latestChartValue;
  const stablecoinPriceChart = chartMetric === "price" && selectedId === "paypal-usd";
  const chartLabel = `${selectedCoin?.name ?? "Crypto"} ${selectedMetricLabel.toLowerCase()} over ${selectedRangeLabel}`;

  const portfolio = useMemo(() => {
    const positions = Object.entries(amounts).flatMap(([id, amount]) => {
      const coin = coinById.get(id as TrackedCoin);
      if (!coin || !amount || coin.priceUsd === null) return [];
      return [{ id: id as TrackedCoin, amount, coin, value: amount * coin.priceUsd }];
    });
    const total = positions.reduce((sum, position) => sum + position.value, 0);
    const dailyChange = positions.reduce((sum, position) => {
      const rate = (position.coin.change24hPct ?? 0) / 100;
      if (rate <= -1) return sum - position.value;
      return sum + position.value * (rate / (1 + rate));
    }, 0);
    return { positions, total, dailyChange };
  }, [amounts, coinById]);

  function updateAmount(id: TrackedCoin, value: string) {
    setAmounts((current) => {
      const amount = Number(value);
      if (!value || !Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: amount };
    });
  }

  function toggleWatchlist(id: TrackedCoin) {
    setWatchlist((current) => {
      if (!current.includes(id)) return [...current, id];
      return current.filter((coin) => coin !== id);
    });
  }

  function refreshMarkets() {
    void loadOverview();
    setChartError("");
    setChartRefresh((current) => current + 1);
  }

  function chooseCoin(id: TrackedCoin) {
    setChartError("");
    setSelectedId(id);
  }

  function chooseDays(nextDays: ChartDays) {
    setChartError("");
    setDays(nextDays);
  }

  const visibleCoins = coins
    .filter((coin) => (tab === "markets" || watchlist.includes(coin.id)) &&
      `${coin.name} ${coin.symbol}`.toLowerCase().includes(assetQuery.trim().toLowerCase()))
    .sort((a, b) => assetSort === "price" ? (b.priceUsd ?? -Infinity) - (a.priceUsd ?? -Infinity) :
      assetSort === "change" ? (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity) :
        (a.rank ?? Infinity) - (b.rank ?? Infinity));

  return (
    <SiteShell activeSection={tab} onNavigate={navigate} refreshedAt={overview?.retrievedAt} refreshing={loadingMarket} onRefresh={refreshMarkets}>
      <div className="dashboard-content">
        <section className="page-heading">
          <div>
            <p className="eyebrow">{tab === "business" ? "CUSTOMER COMPANY MONITORING" : "CLEAR PRICES. REAL MARKET CONTEXT."}</p>
            <h1>{tab === "business" ? "A clearer view of business activity." : tab === "shop" ? "Discover something good." : tab === "portfolio" ? "Your portfolio view." : tab === "settings" ? "Your data, your choice." : tab === "markets" ? "Explore the market." : "A clearer view of crypto."}</h1>
            <p className="page-subtitle">
              {tab === "business"
                ? "A workspace for business teams and leaders, ready for consented merchant data when access and retention rules are in place."
                : tab === "settings" ? "Manage the information you save in this browser." : tab === "shop"
                ? "Find products, compare retailer offers, and build your collections."
                : tab === "portfolio"
                  ? "Track quantities you enter yourself, with live market pricing."
                  : "Live market metrics and charting, alongside the wallet you already use."}
            </p>
          </div>
          {tab !== "business" && <div className="updated-badge" aria-live="polite">
            <span className="live-pulse" />
            <span>{loadingMarket ? "Updating" : overview ? `Updated ${timestamp(overview.retrievedAt)}` : "Waiting for live prices"}</span>
          </div>}
        </section>

        {storageError && <div className="notice error-notice" role="status">{storageError}</div>}
        {marketError && tab !== "shop" && tab !== "settings" && tab !== "business" && (
          <div className="notice error-notice" role="alert">
            <span>{marketError}</span>
            <button onClick={() => void loadOverview()}>Retry</button>
          </div>
        )}

        {tab === "business" ? <BusinessMonitoring /> : tab === "settings" ? <DataSettings /> : tab === "shop" ? (
          <Marketplace />
        ) : tab === "portfolio" ? (
          <PortfolioPanel coins={coins} amounts={amounts} updateAmount={updateAmount} portfolio={portfolio} loading={loadingMarket} />
        ) : (
          <>
            <section className="dashboard-grid" aria-label="Crypto market overview">
              <article className="chart-card">
                <div className="chart-card-top">
                  <div>
                    <p className="eyebrow">{selectedCoin?.name ?? "CRYPTO ASSET"} · {selectedMetricLabel} · USD</p>
                    <div className="primary-metric-row">
                      <h2>{chartMetric === "price" ? money(selectedMetricValue) : compactMoney(selectedMetricValue)}</h2>
                      {chartChange !== null && <span className={chartChange >= 0 ? "change-chip positive" : "change-chip negative"} aria-label={`${selectedMetricLabel} change over ${selectedRangeLabel}: ${percent(chartChange)}`}>{percent(chartChange)}</span>}
                    </div>
                    <p className="chart-context">{selectedCoin?.symbol ?? "—"}{stablecoinPriceChart ? " · USD stablecoin" : ""} · {selectedMetricLabel.toLowerCase()} change over {selectedRangeLabel} · market reference</p>
                  </div>
                  <div className="coin-picker" aria-label="Select crypto asset">
                    {coins.map((coin) => (
                      <button
                        key={coin.id}
                        className={selectedId === coin.id ? "coin-picker-button selected" : "coin-picker-button"}
                        onClick={() => chooseCoin(coin.id)}
                        aria-pressed={selectedId === coin.id}
                        title={coin.name}
                      >
                        {coin.symbol}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="chart-toolbar">
                  <div className="range-picker" aria-label="Chart time range">
                    {ranges.map((range) => (
                      <button
                        key={range.days}
                        onClick={() => chooseDays(range.days)}
                        className={days === range.days ? "range-button active" : "range-button"}
                        aria-pressed={days === range.days}
                      >
                        {range.label}
                      </button>
                    ))}
                  </div>
                  <div className="chart-metric-picker" role="group" aria-label="Chart metric">
                    {chartMetrics.map((metric) => (
                      <button
                        key={metric.id}
                        className={chartMetric === metric.id ? "chart-metric-button active" : "chart-metric-button"}
                        onClick={() => setChartMetric(metric.id)}
                        aria-pressed={chartMetric === metric.id}
                      >
                        {metric.label}
                      </button>
                    ))}
                  </div>
                  <span className="chart-kind"><span className="chart-kind-dot" /> {selectedMetricLabel}{stablecoinPriceChart ? <span className="peg-reference"> · $1.00 peg reference</span> : null}</span>
                </div>

                <div className="chart-frame">
                  {chartIsLoading ? <div className="chart-empty" role="status">Loading {selectedMetricLabel.toLowerCase()} history…</div> :
                    chartError ? <div className="chart-empty" role="status">{chartError}</div> :
                      <MetricChart points={chartSeries} down={(chartChange ?? 0) < 0} label={chartLabel} metric={chartMetric} days={days} stablecoin={stablecoinPriceChart} />}
                </div>
                <div className="chart-scale"><span>Low {selectedMetricLabel.toLowerCase()} {chartValues.length ? chartValue(Math.min(...chartValues), chartMetric) : "—"}</span><span>High {selectedMetricLabel.toLowerCase()} {chartValues.length ? chartValue(Math.max(...chartValues), chartMetric) : "—"}</span></div>
                <div className="chart-footer">
                  <span>Source: <a href="https://www.coingecko.com/" target="_blank" rel="noreferrer">CoinGecko</a></span>
                  <span>Chart refreshed {timestamp(chart?.retrievedAt)}</span>
                </div>
              </article>

              <aside className="side-stack">
                <article className="portfolio-card">
                  <div className="card-heading-row"><div><p className="eyebrow light-eyebrow">YOUR CRYPTO PORTFOLIO</p><h2>Track what you hold</h2></div><span className="sparkle-badge" aria-hidden="true">✳</span></div>
                  {portfolio.positions.length ? (
                    <>
                      <p className="portfolio-total">{money(portfolio.total)}</p>
                      <p className={portfolio.dailyChange >= 0 ? "portfolio-delta positive-text" : "portfolio-delta negative-text"}>
                        {money(Math.abs(portfolio.dailyChange))} {portfolio.dailyChange >= 0 ? "up" : "down"} today
                      </p>
                    </>
                  ) : (
                    <><p className="portfolio-total empty-total">—</p><p className="portfolio-delta muted-text">Add amounts to see an estimate</p></>
                  )}
                  <button className="light-button" onClick={() => navigate("portfolio")}>Manage portfolio <span aria-hidden="true">→</span></button>
                  <p className="portfolio-caption">Manual estimates only · Venmo remains your wallet</p>
                </article>

                <article className="wallet-note">
                  <span className="wallet-note-icon" aria-hidden="true">↗</span>
                  <div><p className="wallet-note-title">Your wallet stays yours</p><p>Use Venmo for wallet and payment activity. This view adds market context and charts.</p></div>
                </article>
              </aside>
            </section>

            <section className="metrics-row" aria-label="Selected asset metrics">
              <Metric label="Market cap" value={compactMoney(selectedCoin?.marketCapUsd)} detail={selectedCoin?.rank ? `Rank #${selectedCoin.rank}` : "Market value"} />
              <Metric label="24h volume" value={compactMoney(selectedCoin?.volume24hUsd)} detail="Across tracked markets" />
              <Metric label="24h high" value={money(selectedCoin?.high24hUsd)} detail="USD" />
              <Metric label="24h low" value={money(selectedCoin?.low24hUsd)} detail="USD" />
            </section>

            <section className="assets-section">
              <div className="section-heading">
                <div><p className="eyebrow">MARKET WATCH</p><h2>{tab === "markets" ? "Tracked crypto assets" : "Your market watchlist"}</h2></div>
                <button className="text-button" onClick={() => navigate("markets")}>View all assets <span aria-hidden="true">→</span></button>
              </div>
              <div className="asset-filters">
                <label>Find an asset<input type="search" value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder="Name or symbol" /></label>
                <label>Sort by<select value={assetSort} onChange={(event) => setAssetSort(event.target.value)}><option value="rank">Market cap rank</option><option value="price">Price, highest first</option><option value="change">24h change, highest first</option></select></label>
              </div>
              {loadingMarket && !coins.length ? <div className="list-loading">Fetching live market data…</div> : coins.length ? (
                <div className="asset-table">
                  <div className="asset-table-head"><span>Asset</span><span>Price</span><span>24h</span><span>7 day trend</span><span aria-label="Watchlist control" /></div>
                  {visibleCoins.map((coin) => (
                    <article key={coin.id} className={selectedId === coin.id ? "asset-row active-row" : "asset-row"}>
                      <button className="asset-main" onClick={() => { chooseCoin(coin.id); navigate("overview"); }}>
                        <AssetMark id={coin.id} />
                        <span className="asset-names"><strong>{coin.name}</strong><span>{coin.symbol}{coin.id === "paypal-usd" ? " · USD stablecoin" : ""}</span></span>
                      </button>
                      <button className="asset-price" onClick={() => { chooseCoin(coin.id); navigate("overview"); }}>{money(coin.priceUsd)}</button>
                      <span className={coin.change24hPct !== null && coin.change24hPct < 0 ? "asset-change negative-text" : "asset-change positive-text"}>{percent(coin.change24hPct)}</span>
                      <Sparkline values={coin.sparkline7d} down={(coin.change7dPct ?? 0) < 0} label={coin.name} stablecoin={coin.id === "paypal-usd"} />
                      <button className={watchlist.includes(coin.id) ? "watch-button watching" : "watch-button"} onClick={() => toggleWatchlist(coin.id)} aria-label={`${watchlist.includes(coin.id) ? "Remove" : "Add"} ${coin.name} ${watchlist.includes(coin.id) ? "from" : "to"} watchlist`} aria-pressed={watchlist.includes(coin.id)}>
                        {watchlist.includes(coin.id) ? "★" : "☆"}
                      </button>
                    </article>
                  ))}
                </div>
              ) : <div className="list-loading">Market assets are not available right now.</div>}
              {!loadingMarket && coins.length > 0 && visibleCoins.length === 0 && <div className="list-loading">{assetQuery ? "No assets match your search. Try Bitcoin, Chainlink, Litecoin, Bitcoin Cash, or PYUSD." : <>Your watchlist is empty. <button className="text-button" onClick={() => navigate("markets")}>Browse assets to add</button></>}</div>}
              <p className="data-caption">Prices are market references and can differ from the price available through any payment provider.</p>
            </section>
          </>
        )}

        <footer className="disclosure">
          {tab === "business" ? "No merchant account or company activity is connected in this preview. Live monitoring requires merchant consent, verified account ownership, and an approved data retention approach." : tab === "settings" ? "Your saved information is local to this browser. This concept has no connected payment account." : tab === "shop"
            ? "Product prices and availability can change. Channel3 links open the retailer, where you can review the current offer and complete checkout."
            : "Crypto market information is for reference only. Tracked assets reflect PayPal's published U.S. list; local availability can vary. Portfolio values use amounts entered manually on this device and do not represent Venmo balances or a connected wallet."}
        </footer>
      </div>

    </SiteShell>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="metric-card"><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>;
}

function PortfolioPanel({
  coins,
  amounts,
  updateAmount,
  portfolio,
  loading,
}: {
  coins: MarketCoin[];
  amounts: Amounts;
  updateAmount: (id: TrackedCoin, value: string) => void;
  portfolio: { positions: Array<{ id: TrackedCoin; amount: number; coin: MarketCoin; value: number }>; total: number; dailyChange: number };
  loading: boolean;
}) {
  return (
    <section className="portfolio-page">
      <div className="portfolio-summary">
        <div><p className="eyebrow light-eyebrow">MANUAL PORTFOLIO VIEW</p><h2>Holdings estimate</h2><p>Enter quantities to see an estimate using current market prices.</p></div>
        <div className="portfolio-summary-value"><span>Total value</span><strong>{portfolio.positions.length ? money(portfolio.total) : "—"}</strong><small className={portfolio.dailyChange >= 0 ? "positive-text" : "negative-text"}>{portfolio.positions.length ? `${money(Math.abs(portfolio.dailyChange))} ${portfolio.dailyChange >= 0 ? "up" : "down"} in the last 24h` : "No quantities entered"}</small></div>
      </div>
      <div className="manual-holdings-card">
        <div className="section-heading"><div><p className="eyebrow">EDIT HOLDINGS</p><h2>Crypto quantities</h2></div><span className="local-badge">Saved on this device</span></div>
        {coins.map((coin) => (
          <label className="holding-row" key={coin.id}>
            <span className="holding-asset"><AssetMark id={coin.id} /><span><strong>{coin.name}</strong><small>{coin.symbol}{coin.id === "paypal-usd" ? " · USD stablecoin" : ""} · {money(coin.priceUsd)} each</small></span></span>
            <span className="holding-input-wrap"><input type="number" inputMode="decimal" min="0" max="1000000000000" step="any" value={amounts[coin.id] ?? ""} onChange={(event) => updateAmount(coin.id, event.target.value)} aria-label={`Amount of ${coin.name} to include in your manual portfolio`} placeholder="0" /><span>{coin.symbol}</span></span>
            <strong className="holding-value">{amounts[coin.id] && coin.priceUsd !== null ? money(amounts[coin.id]! * coin.priceUsd) : "—"}</strong>
          </label>
        ))}
        {!coins.length && <div className="list-loading">{loading ? "Waiting for live prices…" : "Prices are unavailable. Refresh market data to edit your quantities."}</div>}
      </div>
      {portfolio.positions.length > 0 && portfolio.total > 0 && <div className="allocation-panel"><div className="section-heading"><div><p className="eyebrow">PORTFOLIO MIX</p><h2>Where your value sits</h2></div><span className="local-badge">Based on your entered quantities</span></div><div className="allocation-track" aria-hidden="true">{portfolio.positions.map((position) => <span key={position.id} className={`allocation-${position.id}`} style={{width: `${position.value / portfolio.total * 100}%`}} />)}</div><ul className="allocation-legend">{portfolio.positions.map((position) => <li key={position.id}><AssetMark id={position.id}/><span>{position.coin.name}</span><strong>{(position.value / portfolio.total * 100).toFixed(1)}%</strong><span>{money(position.value)}</span></li>)}</ul><p className="data-caption">Allocation is a snapshot of current value, not a return on investment.</p></div>}
      <div className="notice privacy-notice"><span className="privacy-mark" aria-hidden="true">✓</span><p><strong>Venmo remains your wallet.</strong> This manual estimate does not connect to, read from, or change Venmo or any payment account. Your entries stay in this browser on this device.</p></div>
    </section>
  );
}
