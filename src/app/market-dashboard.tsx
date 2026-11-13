"use client";

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AgCharts } from "ag-charts-react";
import {
  AreaSeriesModule,
  CrossLinesModule,
  LineSeriesModule,
  NumberAxisModule,
  TimeAxisModule,
  type AgChartOptions,
  type AgLineSeriesOptions,
} from "ag-charts-community";
import { hasDistinctTrackedCoinIds, TRACKED_COINS, type TrackedCoin } from "@/lib/market-assets";
import { isMarketCurrency, type MarketCurrency } from "@/lib/market-currency";
import { chartPercentageChange, chronologicalChartPoints, visibleChartDomain } from "@/lib/chart-scale";
import { chartViewportAction, chartViewportWheelZoom, FULL_CHART_VIEWPORT, visibleChartPoints, type ChartViewport, type ChartViewportAction } from "@/lib/chart-viewport";
import { marketChartColorsFor, marketChartThemeFor } from "@/lib/market-chart-theme";
import { agChartPlotBounds } from "@/lib/chart-wheel";
import type { ChartDays, ChartPoint, MarketChart, MarketQuote, MarketQuotes } from "@/lib/market-data";
import { formatChartAxisTime, formatChartSampleTime, formatMarketMoney as money, formatMarketProviderUpdateTime, formatMarketRetrievalTime, formatPortfolioMoney, formatUsdtPrice } from "@/lib/market-format";
import { candleSelectionIdentity, preferredIntradayDays, supportsIntradayWindow, type CandleIntervalChoice } from "@/lib/web-candle-data";
import { selectMarketHeadline } from "@/lib/market-headline";
import { calculatePriceIndicators, hasPriceIndicators, indicatorSegments, lineIndicatorOverlays, needsCandleHistory, type LineIndicatorOverlay } from "@/lib/price-indicators";
import { calculateHoldingValue, calculatePortfolio, type PortfolioSummary } from "@/lib/portfolio-summary";
import { draftsForHoldings, handleResetStorageEvent, hasUnfinishedHoldings, LOCAL_DATA_RESET_SIGNAL, mayClearStorageWarning, parseHoldingDraft, previewHoldings, readStoredHoldings, readStoredWatchlist as parseStoredWatchlist, sameHoldings, saveBrowserSnapshot, type HoldingDrafts } from "@/lib/portfolio-input";
import type { BusinessPlanDraft } from "@/lib/business-plan-storage";
import { dashboardLocation, initialAccountExperience, type AccountExperience, type DashboardSection } from "@/lib/account-experience";

type Tab = DashboardSection;
type ChartMetric = "price" | "marketCap" | "volume";
type Amounts = Partial<Record<TrackedCoin, number>>;
import SiteShell from "./components/site-shell";
import Marketplace from "./components/marketplace";
import DataSettings from "./components/data-settings";
import BusinessMonitoring from "./components/business-monitoring";
import VenmoDraft from "./components/venmo-draft";
import ChartZoomControls from "./components/chart-zoom-controls";
import CandleHistoryPanel from "./components/candle-history-panel";
import CandleFeedControls from "./components/candle-feed-controls";
import { LineIndicatorStatus, PriceIndicatorControls, PriceLineRsi, TECHNICAL_AXIS_GUTTER, TECHNICAL_TIME_AXIS_HEIGHT, useMarketChartFont } from "./components/price-chart-indicators";
import { useCandleHistory } from "./components/use-candle-history";
import { usePlotWheelZoom } from "./components/use-plot-wheel-zoom";
import { CustomerSessionProvider, PrivateSessionNotice, useCustomerSession, usePrivateDataScope } from "./components/customer-session";
import { AccountSessionPanel, SessionHeaderControl } from "./components/customer-session-panel";
import { CustomerWorkspaceBoundary, usePublicChartControl, type CustomerWorkspaceProps } from "./components/customer-workspace-boundary";
import InsightPanel from "../../packages/ai-insights/ui/InsightPanel";
import PortfolioAllocation from "./components/portfolio-allocation";
import PersonalAccountingLite from "./components/personal-accounting-lite";
import AccountExperienceSwitch from "./components/account-experience-switch";
import { useAppearance } from "./components/theme-preference";

const STORAGE_KEY = "paypal-markets-manual-holdings-v1";
const WATCHLIST_KEY = "paypal-markets-watchlist-v1";
const CURRENCY_KEY = "paypal-markets-display-currency-v1";
const EMPTY_COINS: MarketQuote[] = [];
const ASSET_DETAILS: Record<TrackedCoin, { name: string; symbol: string; color: string; letters: string }> = {
  bitcoin: { name: "Bitcoin", symbol: "BTC", color: "#f5a623", letters: "₿" },
  ethereum: { name: "Ethereum", symbol: "ETH", color: "#6370d8", letters: "◆" },
  solana: { name: "Solana", symbol: "SOL", color: "#6d58d7", letters: "S" },
  chainlink: { name: "Chainlink", symbol: "LINK", color: "#4267d5", letters: "L" },
  litecoin: { name: "Litecoin", symbol: "LTC", color: "#68798e", letters: "Ł" },
  "bitcoin-cash": { name: "Bitcoin Cash", symbol: "BCH", color: "#28a87c", letters: "B" },
  "paypal-usd": { name: "PayPal USD", symbol: "PYUSD", color: "#008f79", letters: "$" },
};
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
const CHART_DATA_PAGE_SIZE = 100;
const metricChartModules = [AreaSeriesModule, CrossLinesModule, LineSeriesModule, NumberAxisModule, TimeAxisModule];

function compactMoney(value: number | null | undefined, currency: MarketCurrency) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function chartValue(value: number, metric: ChartMetric, currency: MarketCurrency, precisePrice = false) {
  return metric === "price" ? money(value, currency, precisePrice ? 4 : 0) : compactMoney(value, currency);
}

function preferredIntradayWindow(interval: CandleIntervalChoice): 1 | 7 {
  return interval !== "auto" ? preferredIntradayDays(interval) : 1;
}

function portfolioStatus(portfolio: PortfolioSummary, loading: boolean, currency: MarketCurrency, inputMessage = "") {
  if (inputMessage) return inputMessage;
  if (!portfolio.positions.length) return "No quantities entered";
  if (portfolio.total === null) return loading ? "Updating prices…" : "A price or estimate is unavailable for one or more holdings";
  if (portfolio.dailyChange === null) return "24h price movement unavailable";
  if (portfolio.dailyChange === 0) return "No net 24h price movement on current quantities";
  const amount = formatPortfolioMoney(Math.abs(portfolio.dailyChange), currency);
  return `24h price movement on current quantities: ${amount} ${portfolio.dailyChange > 0 ? "up" : "down"}`;
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
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function fullTimestamp(value: string | number | null) {
  if (value === null) return "time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
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

function MetricChart({ points, label, metric, days, currency, precisePrice = false, stablecoin = false, overlays = [], alignRsi = false, approximateTime = false, fullPoints, viewport, onViewportChange }: { points: ChartPoint[]; down: boolean; label: string; metric: ChartMetric; days: ChartDays; currency: MarketCurrency; precisePrice?: boolean; stablecoin?: boolean; overlays?: LineIndicatorOverlay[]; alignRsi?: boolean; approximateTime?: boolean; fullPoints: ChartPoint[]; viewport: ChartViewport; onViewportChange: (next: ChartViewport) => void }) {
  const { appearance } = useAppearance();
  const chartTheme = marketChartThemeFor(appearance);
  const chartColors = marketChartColorsFor(appearance);
  const dataFont = useMarketChartFont();
  const plotRef = useRef<HTMLDivElement | null>(null);
  usePlotWheelZoom({ elementRef: plotRef, view: viewport, getBounds: () => agChartPlotBounds(plotRef.current), project: (view, factor, ratio) => chartViewportWheelZoom(fullPoints, view, factor, ratio), onChange: (next) => onViewportChange(next) });
  const data = useMemo<MetricChartDatum[]>(
    () => points
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .map((point) => ({ timestamp: new Date(point.timestamp), value: point.value })),
    [points],
  );
  const firstPoint = data[0];
  const lastPoint = data[data.length - 1];
  const dataScopeSignature = JSON.stringify([
    label, metric, days, currency, data.length,
    firstPoint?.timestamp.getTime(), firstPoint?.value,
    lastPoint?.timestamp.getTime(), lastPoint?.value,
  ]);
  const [chartDataOpen, setChartDataOpen] = useState(false);
  const [chartDataPageState, setChartDataPageState] = useState({ signature: dataScopeSignature, page: 0 });
  const values = data.map((point) => point.value);
  const pageCount = Math.max(1, Math.ceil(data.length / CHART_DATA_PAGE_SIZE));
  const requestedPage = chartDataPageState.signature === dataScopeSignature ? chartDataPageState.page : 0;
  const pageIndex = Math.min(requestedPage, pageCount - 1);
  const pageStart = pageIndex * CHART_DATA_PAGE_SIZE;
  const pageEnd = Math.min(pageStart + CHART_DATA_PAGE_SIZE, data.length);
  const pageData = chartDataOpen ? data.slice(pageStart, pageEnd) : [];
  const color = appearance === "light" ? "#155eef" : "#00CCFF";
  const overlayValues = overlays.flatMap((overlay) => overlay.segments.flatMap((segment) => segment.map((point) => point.value)));
  const domain = visibleChartDomain([...values, ...overlayValues], stablecoin);
  const technical = overlays.length > 0 || alignRsi;
  const overlaySeries: AgLineSeriesOptions<MetricChartDatum>[] = overlays.flatMap((overlay) => overlay.segments.map((segment, index) => ({
    type: "line", id: `${overlay.id}-${index}`, data: segment.map((point) => ({ timestamp: new Date(point.timestamp), value: point.value })),
    xKey: "timestamp", yKey: "value", yName: `${overlay.label} · candle close`, stroke: appearance === "light" ? chartColors[overlay.id] : overlay.color, strokeWidth: 2,
    marker: { enabled: segment.length === 1, size: 4 }, connectMissingData: false,
    tooltip: { renderer: ({ datum }) => ({
      heading: formatChartSampleTime(datum.timestamp),
      data: [{ label: `${overlay.label} · candle close`, value: money(datum.value, currency, precisePrice ? 6 : 0) }],
    }) },
  })));
  const options: AgChartOptions<MetricChartDatum> = {
    theme: chartTheme,
    data,
    background: { visible: false },
    animation: { enabled: false },
    padding: { top: 10, right: 34, bottom: 8, left: 16 },
    legend: { enabled: false },
    axes: {
      x: {
        type: "time",
        position: "bottom",
        ...(technical && data.length >= 2 ? { min: data[0].timestamp, max: data[data.length - 1].timestamp, nice: false, thickness: TECHNICAL_TIME_AXIS_HEIGHT } : {}),
        label: {
          formatter: ({ value }) => formatChartAxisTime(value, days),
          color: chartColors.axisText,
          fontFamily: dataFont,
          fontSize: 11,
          minSpacing: 56,
        },
        gridLine: { enabled: false },
        tick: { enabled: false },
        line: { stroke: chartColors.axisLine },
      },
      y: {
        type: "number",
        position: "left",
        min: domain?.min,
        max: domain?.max,
        nice: false,
        ...(alignRsi ? { thickness: TECHNICAL_AXIS_GUTTER } : {}),
        label: {
          formatter: ({ value }) => chartValue(Number(value), metric, currency, precisePrice),
          color: chartColors.axisText,
          fontFamily: dataFont,
          fontSize: 11,
        },
        gridLine: { style: [{ stroke: chartColors.gridLine, strokeWidth: 1, lineDash: [4, 7] }] },
        crossLines: stablecoin
          ? [{
              type: "line",
              value: 1,
              stroke: "#d59b3c",
              strokeWidth: 1.5,
              lineDash: [6, 5],
              label: { text: "$1.00", position: "right", color: appearance === "light" ? "#8a641f" : "#f2cb76", fontSize: 9 },
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
      fillOpacity: 0.08,
      stroke: color,
      strokeWidth: 2.5,
      marker: { enabled: false },
      tooltip: {
        renderer: ({ datum }) => ({
          heading: formatChartSampleTime(datum.timestamp, approximateTime),
          data: [{ label, value: chartValue(datum.value, metric, currency, precisePrice) }],
        }),
      },
    }, ...overlaySeries],
  };
  if (data.length < 2) {
    return (
      <div className="chart-empty" role="status">
        Chart history is not available for this range yet.
      </div>
    );
  }
  const description = stablecoin
    ? `${label}. USD stablecoin chart with a $1.00 peg reference. From ${chartValue(values[0], metric, currency, precisePrice)} to ${chartValue(values[values.length - 1], metric, currency, precisePrice)}.`
    : `${label}. From ${chartValue(values[0], metric, currency, precisePrice)} to ${chartValue(values[values.length - 1], metric, currency, precisePrice)}.`;
  return (
    <div className="metric-chart" role="group" aria-label={`${label} line chart`}>
      <div ref={plotRef} className="metric-chart-plot" role="img" aria-label={`${description} Times are in UTC.${approximateTime ? " Sample times are estimated." : ""} The vertical scale follows ${overlays.length ? "the price and candle-close indicators" : "the visible data"}${domain && domain.min > 0 ? " and starts above zero" : ""}. Scroll over the plot to zoom; buttons are available below.`}>
        <AgCharts className="ag-market-chart" modules={metricChartModules} options={options} />
      </div>
      <details className="metric-chart-data" onToggle={(event) => setChartDataOpen(event.currentTarget.open)}>
        <summary>View chart data ({data.length} visible points)</summary>
        {chartDataOpen && (
          <div className="metric-chart-data-panel">
            <div className="metric-chart-pagination">
              <button type="button" aria-label={`Previous ${CHART_DATA_PAGE_SIZE} samples`} disabled={pageIndex === 0} onClick={() => setChartDataPageState({ signature: dataScopeSignature, page: Math.max(0, pageIndex - 1) })}>Previous</button>
              <span aria-live="polite" aria-atomic="true">Samples {pageStart + 1}–{pageEnd} of {data.length}</span>
              <button type="button" aria-label={`Next ${CHART_DATA_PAGE_SIZE} samples`} disabled={pageIndex >= pageCount - 1} onClick={() => setChartDataPageState({ signature: dataScopeSignature, page: Math.min(pageCount - 1, pageIndex + 1) })}>Next</button>
            </div>
            <div className="metric-chart-data-table" tabIndex={0} aria-label={`Visible data points for ${label}`}>
              <table>
                <caption>{label}; sample times in UTC{approximateTime ? " (estimated)" : ""}.</caption>
                <thead><tr><th scope="col">Sample time</th><th scope="col">{chartMetrics.find((item) => item.id === metric)?.label ?? "Value"} ({currency})</th></tr></thead>
                <tbody>{pageData.map((point, index) => (
                  <tr key={`${point.timestamp.getTime()}-${pageStart + index}`}>
                    <td>{formatChartSampleTime(point.timestamp, approximateTime)}</td>
                    <td>{chartValue(point.value, metric, currency, precisePrice)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}

function AssetMark({ id }: { id: TrackedCoin }) {
  const asset = ASSET_DETAILS[id];
  return <span className="asset-mark" aria-hidden="true" style={{ "--asset-color": asset.color } as CSSProperties}>{asset.letters}</span>;
}

function defaultWatchlist(): TrackedCoin[] {
  return [...TRACKED_COINS];
}

function readStoredWatchlist(raw: string | null): TrackedCoin[] {
  return parseStoredWatchlist(raw, TRACKED_COINS);
}

async function requestOverview(currency: MarketCurrency, signal: AbortSignal): Promise<MarketQuotes> {
  const response = await fetch(`/api/market/quotes?currency=${encodeURIComponent(currency)}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Market prices could not be refreshed.");
  const data = (await response.json()) as MarketQuotes;
  if (data.currency !== currency || data.provider !== "CoinGecko") {
    throw new Error("Market prices did not match the selected currency.");
  }
  if (!hasDistinctTrackedCoinIds(data.coins)) throw new Error("Market prices included duplicate or unsupported assets.");
  return data;
}

const MarketInsightAvailability = createContext(false);

export default function MarketDashboard({ aiInsightsAvailable = false }: { aiInsightsAvailable?: boolean }) {
  return <MarketInsightAvailability.Provider value={aiInsightsAvailable}><CustomerSessionProvider><CustomerWorkspaceBoundary Workspace={MarketDashboardBody} /></CustomerSessionProvider></MarketInsightAvailability.Provider>;
}

function MarketDashboardBody({ publicChart, onPublicChartChange }: CustomerWorkspaceProps) {
  const { appearance } = useAppearance();
  const chartColors = marketChartColorsFor(appearance);
  const aiInsightsAvailable = useContext(MarketInsightAvailability);
  const session = useCustomerSession();
  const privateData = usePrivateDataScope();
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const allowBusinessBookmark = privateData.ready && !(session.state.status === "ready" && session.state.session.authenticated && session.state.session.accountType === "unknown");
  const [tab, setTab] = useState<Tab>("overview");
  const [accountExperience, setAccountExperience] = useState<AccountExperience | null>(() => initialAccountExperience(session.state.status === "ready" ? session.state.session : null));
  const businessView = tab === "account" && accountExperience === "business";
  const [overview, setOverview] = useState<MarketQuotes | null>(null);
  const [chart, setChart] = useState<MarketChart | null>(null);
  const [currency, setCurrency] = useState<MarketCurrency>("USD");
  const [currencyReady, setCurrencyReady] = useState(true);
  const [currencyStorageError, setCurrencyStorageError] = useState("");
  const [selectedId, setSelectedId] = usePublicChartControl(publicChart, onPublicChartChange, "selectedId");
  const [days, setDays] = usePublicChartControl(publicChart, onPublicChartChange, "days");
  const [chartMetric, setChartMetric] = usePublicChartControl(publicChart, onPublicChartChange, "metric");
  const [priceStyle, setPriceStyle] = usePublicChartControl(publicChart, onPublicChartChange, "style");
  const [priceIndicators, setPriceIndicators] = usePublicChartControl(publicChart, onPublicChartChange, "indicators");
  const [candleView, setCandleView] = usePublicChartControl(publicChart, onPublicChartChange, "candleView");
  const [candleInterval, setCandleInterval] = usePublicChartControl(publicChart, onPublicChartChange, "candleInterval");
  const [intradayDays, setIntradayDays] = usePublicChartControl(publicChart, onPublicChartChange, "intradayDays");
  const lineHistoryEnabled = chartMetric !== "price" || priceStyle !== "candles";
  const [chartViewport, setChartViewport] = usePublicChartControl(publicChart, onPublicChartChange, "viewport");
  function chooseCandleInterval(next: CandleIntervalChoice) {
    if (next !== "auto" && !supportsIntradayWindow(next, intradayDays)) setIntradayDays(preferredIntradayWindow(next));
    setCandleInterval(next);
  }
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketFailure, setMarketFailure] = useState<{ currency: MarketCurrency; message: string } | null>(null);
  const [overviewRefresh, setOverviewRefresh] = useState(0);
  const [chartRefresh, setChartRefresh] = useState(0);
  const [chartFailure, setChartFailure] = useState<{ currency: MarketCurrency; coinId: TrackedCoin; days: ChartDays; message: string } | null>(null);
  const [amounts, setAmounts] = useState<Amounts>({});
  const [amountDrafts, setAmountDrafts] = useState<HoldingDrafts>({});
  const [watchlist, setWatchlist] = useState<TrackedCoin[]>(defaultWatchlist());
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [storageWritable, setStorageWritable] = useState(false);
  const amountSnapshot = useRef<Amounts>({});
  const draftSnapshot = useRef<HoldingDrafts>({});
  const dirtyHoldingDrafts = useRef(new Set<TrackedCoin>());
  const watchlistSnapshot = useRef<TrackedCoin[]>(defaultWatchlist());
  const holdingsPending = useRef(false);
  const watchlistPending = useRef(false);
  const holdingsGeneration = useRef(0);
  const [holdingsRevision, setHoldingsRevision] = useState(0);
  const watchlistGeneration = useRef(0);
  const [watchlistRevision, setWatchlistRevision] = useState(0);
  const holdingsBaseline = useRef<string | null>(null);
  const watchlistBaseline = useRef<string | null>(null);
  const conflict = useRef(false);
  const sawResetRemoval = useRef(false);
  const [holdingsConflict, setHoldingsConflict] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");
  const [storageRetry, setStorageRetry] = useState(0);
  const [storageRetryAvailable, setStorageRetryAvailable] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetSort, setAssetSort] = useState("rank");
  const [storageError, setStorageError] = useState("");
  const businessDraftRef = useRef<BusinessPlanDraft | null>(null);
  const [businessDraftPending, setBusinessDraftPending] = useState(false);
  const marketError = marketFailure?.currency === currency ? marketFailure.message : "";
  const chartError = chartFailure?.currency === currency && chartFailure.coinId === selectedId && chartFailure.days === days ? chartFailure.message : "";

  useEffect(() => {
    const unfinishedDrafts = dirtyHoldingDrafts.current;
    const clearDraft = () => { businessDraftRef.current = null; setBusinessDraftPending(false); };
    const onStorage = (event: StorageEvent) => {
      if (!(event.key === null || (event.key === LOCAL_DATA_RESET_SIGNAL && event.newValue !== null))) return;
      try { if (event.storageArea === window.localStorage) clearDraft(); } catch { /* The in-memory draft remains available. */ }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (businessDraftRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    privateEvents.addEventListener("paypal-markets-data-reset", clearDraft);
    privateEvents.addEventListener("storage", onStorage);
    privateEvents.addEventListener("beforeunload", beforeUnload);
    return () => {
      businessDraftRef.current = null;
      amountSnapshot.current = {};
      draftSnapshot.current = {};
      watchlistSnapshot.current = defaultWatchlist();
      unfinishedDrafts.clear();
      holdingsPending.current = false;
      watchlistPending.current = false;
      privateEvents.removeEventListener("paypal-markets-data-reset", clearDraft);
      privateEvents.removeEventListener("storage", onStorage);
      privateEvents.removeEventListener("beforeunload", beforeUnload);
    };
  }, [privateEvents]);

  const replaceHoldings = useCallback((next: Amounts, drafts = draftsForHoldings(next)) => {
    amountSnapshot.current = next;
    draftSnapshot.current = drafts;
    dirtyHoldingDrafts.current.clear();
    setAmounts(next);
    setAmountDrafts(drafts);
  }, []);

  function loadSavedQuantities() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = readStoredHoldings(raw, TRACKED_COINS);
      if (!saved.ok) throw new Error("Invalid saved holdings.");
      const rawWatchlist = localStorage.getItem(WATCHLIST_KEY);
      const nextWatchlist = readStoredWatchlist(rawWatchlist);
      if (watchlistPending.current && JSON.stringify(watchlistSnapshot.current) !== JSON.stringify(nextWatchlist)) {
        setHoldingsConflict(false);
        setStorageError("The watchlist also changed in another tab. Saving is paused; reload to use the saved version.");
        return;
      }
      const revision = ++holdingsGeneration.current;
      setHoldingsRevision(revision);
      holdingsBaseline.current = raw;
      holdingsPending.current = false;
      replaceHoldings(saved.amounts);
      watchlistBaseline.current = rawWatchlist;
      watchlistPending.current = false;
      watchlistSnapshot.current = nextWatchlist;
      setWatchlist(nextWatchlist);
      conflict.current = false;
      setHoldingsConflict(false);
      setStorageWritable(true);
      setStorageError("");
      setStorageRetryAvailable(false);
      setStorageNotice("Loaded the current saved quantities from this browser.");
    } catch {
      setStorageError("Saved quantities could not be read. They have been left untouched; export them or reset local data in Settings.");
    }
  }

  function navigate(next: Tab) {
    if (window.location.hash !== `#${next}`) window.history.pushState(null, "", `#${next}`);
    setTab(next);
    // Keep history traversal under the browser's scroll restoration. Explicit
    // section changes start immediately at the top without adding motion.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function chooseAccountExperience(next: AccountExperience) {
    setAccountExperience(next);
    if (window.location.hash === "#business") window.history.replaceState(null, "", "#account");
  }

  useEffect(() => {
    const readLocation = () => {
      const hasProductSearch = new URLSearchParams(window.location.search).has("q");
      const location = dashboardLocation(window.location.hash, hasProductSearch);
      setTab(location.section);
      if (location.businessBookmark && allowBusinessBookmark) setAccountExperience("business");
    };
    const resetData = () => {
      const nextWatchlist = defaultWatchlist();
      const holdingRevision = ++holdingsGeneration.current;
      const nextWatchlistRevision = ++watchlistGeneration.current;
      setHoldingsRevision(holdingRevision);
      setWatchlistRevision(nextWatchlistRevision);
      holdingsBaseline.current = null;
      watchlistBaseline.current = null;
      holdingsPending.current = false;
      watchlistPending.current = false;
      conflict.current = false;
      setHoldingsConflict(false);
      replaceHoldings({});
      watchlistSnapshot.current = nextWatchlist;
      setWatchlist(nextWatchlist);
      setStorageError("");
      setStorageRetryAvailable(false);
      setStorageNotice("");
      setStorageWritable(true);
      setCurrency("USD");
      setCurrencyStorageError("");
      setMarketFailure(null);
      setChartFailure(null);
      setChartViewport(FULL_CHART_VIEWPORT);
      setOverviewRefresh((current) => current + 1);
      setChartRefresh((current) => current + 1);
    };
    const storageFailed = () => {
      setStorageError("Browser storage is unavailable. Your changes may not be saved after you leave. Retry saving; exports contain only data already saved in this browser.");
      setStorageRetryAvailable(holdingsPending.current || watchlistPending.current || dirtyHoldingDrafts.current.size > 0);
    };
    const storageRecovered = () => {
      if (mayClearStorageWarning(conflict.current, holdingsPending.current, watchlistPending.current, dirtyHoldingDrafts.current.size > 0)) {
        setStorageError("");
        setStorageRetryAvailable(false);
      }
    };
    const storageCorrupt = () => {
      conflict.current = true;
      setHoldingsConflict(false);
      setStorageWritable(false);
      setStorageRetryAvailable(false);
      setStorageError("Saved browser data could not be read. It has been left untouched; export it or reset local data in Settings.");
    };
    const holdingsChanged = () => {
      conflict.current = true;
      setHoldingsConflict(true);
      setStorageWritable(false);
      setStorageRetryAvailable(false);
      setStorageError("Saved quantities changed in another tab. Your current input is still here and saving is paused.");
    };
    const watchlistChanged = () => {
      conflict.current = true;
      setHoldingsConflict(false);
      setStorageWritable(false);
      setStorageRetryAvailable(false);
      setStorageError("The watchlist changed in another tab while you were editing. Saving is paused; reload to use the saved version.");
    };
    const remoteReset = () => {
      const holdingRevision = ++holdingsGeneration.current;
      const nextWatchlistRevision = ++watchlistGeneration.current;
      setHoldingsRevision(holdingRevision);
      setWatchlistRevision(nextWatchlistRevision);
      try {
        const rawHoldings = localStorage.getItem(STORAGE_KEY);
        const rawWatchlist = localStorage.getItem(WATCHLIST_KEY);
        const saved = readStoredHoldings(rawHoldings, TRACKED_COINS);
        if (!saved.ok) throw new Error("Invalid saved holdings.");
        const nextWatchlist = readStoredWatchlist(rawWatchlist);
        holdingsBaseline.current = rawHoldings;
        watchlistBaseline.current = rawWatchlist;
        holdingsPending.current = false;
        watchlistPending.current = false;
        conflict.current = false;
        setHoldingsConflict(false);
        replaceHoldings(saved.amounts);
        watchlistSnapshot.current = nextWatchlist;
        setWatchlist(nextWatchlist);
        setStorageWritable(true);
        setStorageError("");
        setStorageRetryAvailable(false);
        setStorageNotice("Local data was reset in another tab. Any unfinished quantities were cleared.");
        return true;
      } catch {
        storageCorrupt();
        return false;
      }
    };
    const syncHoldings = (event: StorageEvent) => {
      if (event.key === LOCAL_DATA_RESET_SIGNAL && event.newValue !== null) {
        handleResetStorageEvent(event.newValue, sawResetRemoval, remoteReset);
        return;
      }
      if (event.key === null) { remoteReset(); return; }
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === null) { handleResetStorageEvent(null, sawResetRemoval, remoteReset); return; }
      const revision = ++holdingsGeneration.current;
      setHoldingsRevision(revision);
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const saved = readStoredHoldings(raw, TRACKED_COINS);
        if (!saved.ok) throw new Error("Invalid saved holdings.");
        readStoredWatchlist(localStorage.getItem(WATCHLIST_KEY));
        if (conflict.current) return;
        if ((holdingsPending.current || dirtyHoldingDrafts.current.size > 0 || hasUnfinishedHoldings(draftSnapshot.current)) && !sameHoldings(amountSnapshot.current, saved.amounts)) {
          holdingsChanged();
          return;
        }
        holdingsBaseline.current = raw;
        holdingsPending.current = false;
        if (!sameHoldings(amountSnapshot.current, saved.amounts)) replaceHoldings(saved.amounts);
      } catch {
        storageCorrupt();
      }
    };
    const syncWatchlist = (event: StorageEvent) => {
      if (event.key !== WATCHLIST_KEY) return;
      const revision = ++watchlistGeneration.current;
      setWatchlistRevision(revision);
      try {
        const raw = localStorage.getItem(WATCHLIST_KEY);
        const next = readStoredWatchlist(raw);
        if (!readStoredHoldings(localStorage.getItem(STORAGE_KEY), TRACKED_COINS).ok) throw new Error("Invalid saved holdings.");
        if (conflict.current) return;
        if (watchlistPending.current && JSON.stringify(watchlistSnapshot.current) !== JSON.stringify(next)) {
          watchlistChanged();
          return;
        }
        watchlistBaseline.current = raw;
        watchlistPending.current = false;
        watchlistSnapshot.current = next;
        setWatchlist(next);
      } catch {
        storageCorrupt();
      }
    };
    const syncCurrency = (event: StorageEvent) => {
      if (event.key !== CURRENCY_KEY && event.key !== null) return;
      try {
        const saved: unknown = event.newValue === null ? "USD" : JSON.parse(event.newValue);
        if (!isMarketCurrency(saved)) throw new Error("Invalid display currency");
        setCurrency(saved);
        setCurrencyStorageError("");
        setMarketFailure(null);
        setChartFailure(null);
        setChartViewport(FULL_CHART_VIEWPORT);
        setOverviewRefresh((current) => current + 1);
        setChartRefresh((current) => current + 1);
      } catch {
        setCurrencyStorageError("Saved display currency could not be read. Choose a currency to replace it, or export your data in Settings.");
      }
    };
    const timer = window.setTimeout(readLocation, 0);
    privateEvents.addEventListener("hashchange", readLocation);
    privateEvents.addEventListener("popstate", readLocation);
    privateEvents.addEventListener("paypal-markets-data-reset", resetData);
    privateEvents.addEventListener("paypal-markets-storage-error", storageFailed);
    privateEvents.addEventListener("paypal-markets-storage-recovered", storageRecovered);
    privateEvents.addEventListener("paypal-markets-storage-corrupt", storageCorrupt);
    privateEvents.addEventListener("paypal-markets-holdings-conflict", holdingsChanged);
    privateEvents.addEventListener("paypal-markets-watchlist-conflict", watchlistChanged);
    privateEvents.addEventListener("storage", syncCurrency);
    privateEvents.addEventListener("storage", syncHoldings);
    privateEvents.addEventListener("storage", syncWatchlist);
    return () => {
      window.clearTimeout(timer);
      privateEvents.removeEventListener("hashchange", readLocation);
      privateEvents.removeEventListener("popstate", readLocation);
      privateEvents.removeEventListener("paypal-markets-data-reset", resetData);
      privateEvents.removeEventListener("paypal-markets-storage-error", storageFailed);
      privateEvents.removeEventListener("paypal-markets-storage-recovered", storageRecovered);
      privateEvents.removeEventListener("paypal-markets-storage-corrupt", storageCorrupt);
      privateEvents.removeEventListener("paypal-markets-holdings-conflict", holdingsChanged);
      privateEvents.removeEventListener("paypal-markets-watchlist-conflict", watchlistChanged);
      privateEvents.removeEventListener("storage", syncCurrency);
      privateEvents.removeEventListener("storage", syncHoldings);
      privateEvents.removeEventListener("storage", syncWatchlist);
    };
  }, [replaceHoldings, localStorage, privateEvents, allowBusinessBookmark, setChartViewport]);

  useEffect(() => {
    if (!privateData.ready) return;
    const hydrateTimer = window.setTimeout(() => {
      let canWrite = true;
      try {
        const savedAmounts = localStorage.getItem(STORAGE_KEY);
        const savedWatchlist = localStorage.getItem(WATCHLIST_KEY);
        const saved = readStoredHoldings(savedAmounts, TRACKED_COINS);
        if (!saved.ok) throw new Error("Invalid saved holdings.");
        const nextWatchlist = readStoredWatchlist(savedWatchlist);
        holdingsBaseline.current = savedAmounts;
        watchlistBaseline.current = savedWatchlist;
        replaceHoldings(saved.amounts);
        watchlistSnapshot.current = nextWatchlist;
        setWatchlist(nextWatchlist);
      } catch {
        canWrite = false;
        conflict.current = true;
        setStorageError("Saved browser data could not be read. It has been left untouched; export it or reset local data in Settings.");
      }
      setStorageWritable(canWrite);
      setPreferencesLoaded(true);
      try {
        const rawCurrency = localStorage.getItem(CURRENCY_KEY);
        if (rawCurrency !== null) {
          const saved: unknown = JSON.parse(rawCurrency);
          if (!isMarketCurrency(saved)) throw new Error("Invalid display currency");
          setCurrency(saved);
        }
      } catch {
        setCurrencyStorageError("Saved display currency could not be read. Choose a currency to replace it, or export your data in Settings.");
      }
      setCurrencyReady(true);
    }, 0);
    return () => window.clearTimeout(hydrateTimer);
  }, [replaceHoldings, privateData.ready, localStorage]);

  useEffect(() => {
    if (!currencyReady) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadingMarket(true);
      setMarketFailure(null);
      requestOverview(currency, controller.signal)
        .then((data) => {
          if (!cancelled) setOverview(data);
        })
        .catch(() => {
          if (!cancelled) setMarketFailure({ currency, message: "Market reference prices are unavailable right now. Please try again shortly." });
        })
        .finally(() => {
          if (!cancelled) setLoadingMarket(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currency, currencyReady, overviewRefresh]);

  useEffect(() => {
    if (preferencesLoaded && storageWritable && !conflict.current && holdingsGeneration.current === holdingsRevision && holdingsPending.current) {
      let result;
      try { result = saveBrowserSnapshot(localStorage, STORAGE_KEY, holdingsBaseline.current, JSON.stringify(amounts), (raw) => readStoredHoldings(raw, TRACKED_COINS).ok, true); }
      catch { privateEvents.dispatchEvent(new Event("paypal-markets-storage-error")); return; }
      if (result.kind === "corrupt") privateEvents.dispatchEvent(new Event("paypal-markets-storage-corrupt"));
      else if (result.kind === "changed") privateEvents.dispatchEvent(new Event("paypal-markets-holdings-conflict"));
      else if (result.kind === "unavailable") privateEvents.dispatchEvent(new Event("paypal-markets-storage-error"));
      else {
        holdingsBaseline.current = result.baseline;
        holdingsPending.current = false;
        privateEvents.dispatchEvent(new Event("paypal-markets-storage-recovered"));
      }
    }
  }, [amounts, preferencesLoaded, storageWritable, holdingsRevision, storageRetry, localStorage, privateEvents]);

  useEffect(() => {
    if (preferencesLoaded && storageWritable && !conflict.current && watchlistGeneration.current === watchlistRevision && watchlistPending.current) {
      let result;
      try { result = saveBrowserSnapshot(localStorage, WATCHLIST_KEY, watchlistBaseline.current, JSON.stringify(watchlist), (raw) => { readStoredWatchlist(raw); return true; }); }
      catch { privateEvents.dispatchEvent(new Event("paypal-markets-storage-error")); return; }
      if (result.kind === "corrupt") privateEvents.dispatchEvent(new Event("paypal-markets-storage-corrupt"));
      else if (result.kind === "changed") privateEvents.dispatchEvent(new Event("paypal-markets-watchlist-conflict"));
      else if (result.kind === "unavailable") privateEvents.dispatchEvent(new Event("paypal-markets-storage-error"));
      else {
        watchlistBaseline.current = result.baseline;
        watchlistPending.current = false;
        privateEvents.dispatchEvent(new Event("paypal-markets-storage-recovered"));
      }
    }
  }, [watchlist, preferencesLoaded, storageWritable, watchlistRevision, storageRetry, localStorage, privateEvents]);

  useEffect(() => {
    if (!currencyReady || !lineHistoryEnabled) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/market/chart/${selectedId}?days=${days}&currency=${encodeURIComponent(currency)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Market chart data could not be loaded.");
        const result = (await response.json()) as MarketChart;
        if (result.currency !== currency || result.coinId !== selectedId || result.days !== days) {
          throw new Error("Market chart data did not match the selected currency or range.");
        }
        return result;
      })
      .then((result) => {
        if (!cancelled) {
          setChart(result);
          setChartFailure(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChart(null);
          setChartFailure({ currency, coinId: selectedId, days, message: "Chart history for this range is unavailable." });
        }
      })
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedId, days, currency, currencyReady, chartRefresh, lineHistoryEnabled]);

  const currentOverview = overview?.currency === currency ? overview : null;
  const coins = currentOverview?.coins ?? EMPTY_COINS;
  const marketLoading = !currencyReady || loadingMarket || (!currentOverview && !marketError);
  const selectedCoin = coins.find((coin) => coin.id === selectedId) ?? null;
  const coinById = useMemo(() => new Map(coins.map((coin) => [coin.id, coin])), [coins]);
  const selectedRangeLabel = ranges.find((range) => range.days === days)?.label ?? "1W";
  const chartMatches = chart?.coinId === selectedId && chart.days === days && chart.currency === currency;
  const chartIsLoading = !chartError && !chartMatches;
  const chartAvailableMetrics: MarketChart["availableMetrics"] = chartMatches && chart ? chart.availableMetrics : ["price", "marketCap", "volume"];
  const chartSeriesSource: MarketChart["seriesSource"] = chartMatches && chart ? chart.seriesSource : "market_chart";
  const selectedChartMetric = chartMatches && chart && !chartAvailableMetrics.includes(chartMetric) ? "price" : chartMetric;
  const selectedMetricLabel = chartMetrics.find((metric) => metric.id === selectedChartMetric)?.label ?? "Price";
  const minuteCandles = selectedChartMetric === "price" && priceStyle === "candles" && candleInterval !== "auto";
  const intradaySelection = minuteCandles ? { interval: candleInterval, days: intradayDays } : undefined;
  const chartSeries = useMemo(() => {
    if (!chartMatches || !chart) return [];
    const series = selectedChartMetric === "price" ? chart.prices : selectedChartMetric === "marketCap" ? chart.marketCaps : chart.volumes;
    return chronologicalChartPoints(series);
  }, [chart, chartMatches, selectedChartMetric]);
  const displayedChartSeries = visibleChartPoints(chartSeries, chartViewport);
  const chartValues = displayedChartSeries.map((point) => point.value);
  const seriesChange = chartPercentageChange(chartSeries);
  const chartChange = seriesChange !== null
    ? seriesChange
    : selectedChartMetric === "price"
      ? days === 1
        ? selectedCoin?.change24hPct ?? null
        : days === 7
          ? selectedCoin?.change7dPct ?? null
          : null
      : null;
  const quoteMetricValue = selectedChartMetric === "price"
    ? selectedCoin?.price
    : selectedChartMetric === "marketCap"
      ? selectedCoin?.marketCap
      : selectedCoin?.volume24h;
  const headline = selectMarketHeadline(
    quoteMetricValue,
    currentOverview?.retrievedAt,
    chartSeries.at(-1),
    chartMatches ? chart?.retrievedAt : null,
    selectedCoin?.lastUpdated,
  );
  const selectedMetricValue = headline.value;
  const headlineProvenance = headline.source === "quote"
    ? `${headline.updatedAt ? `CoinGecko data as of ${fullTimestamp(headline.updatedAt)}` : "CoinGecko asset update time unavailable"} · snapshot retrieved ${fullTimestamp(headline.retrievedAt)}`
    : headline.source === "chart"
      ? `${chartSeriesSource === "market_overview_sparkline" ? "Estimated chart sample" : "Chart sample"} ${fullTimestamp(headline.sampleAt)} · chart retrieved ${fullTimestamp(headline.retrievedAt)}`
      : (marketLoading || chartIsLoading)
        ? `Loading ${selectedMetricLabel.toLowerCase()}…`
        : "Market value unavailable";
  const selectedIsStablecoin = selectedId === "paypal-usd";
  const preciseStablecoinPrice = selectedChartMetric === "price" && selectedIsStablecoin;
  const stablecoinPriceChart = !minuteCandles && preciseStablecoinPrice && currency === "USD";
  const visibleDomain = visibleChartDomain(chartValues, stablecoinPriceChart);
  const chartLabel = `${selectedCoin?.name ?? "Crypto"} ${selectedMetricLabel.toLowerCase()} over ${selectedRangeLabel}`;
  const indicatorEnabled = hasPriceIndicators(priceIndicators);
  const timestampedPriceLine = Boolean(chartMatches && chartSeriesSource === "market_chart" && chartSeries.length >= 2 && chartSeries[0].timestamp < chartSeries[chartSeries.length - 1].timestamp);
  const candleRequest = useCandleHistory({
    coinId: selectedId, currency, days, intraday: intradaySelection, refresh: chartRefresh,
    enabled: (tab === "overview" || tab === "markets") && needsCandleHistory({ currencyReady, metric: selectedChartMetric, style: priceStyle, indicators: priceIndicators, timestampedLine: timestampedPriceLine }),
  });
  const candleHistory = candleRequest.status === "ready" ? candleRequest.history : null;
  const minuteHistory = minuteCandles && candleHistory?.source === "Binance Spot" ? candleHistory : null;
  const minuteLast = minuteHistory?.candles.at(-1);
  const displayedChange = minuteCandles ? minuteHistory ? chartPercentageChange(minuteHistory.candles.map((candle) => ({ timestamp: candle.timestamp, value: candle.close }))) : null : chartChange;
  const displayedRangeLabel = minuteCandles ? `${intradayDays}-day candle window` : selectedRangeLabel;
  const displayedProvenance = minuteCandles ? minuteLast ? `Last closed candle ${fullTimestamp(minuteLast.timestamp)} · retrieved ${fullTimestamp(minuteHistory?.retrievedAt ?? null)}` : "Complete Binance history unavailable until loaded" : headlineProvenance;
  const indicatorValues = useMemo(() => candleHistory ? calculatePriceIndicators(candleHistory) : null, [candleHistory]);
  const indicatorStart = displayedChartSeries[0]?.timestamp;
  const indicatorEnd = displayedChartSeries[displayedChartSeries.length - 1]?.timestamp;
  const indicatorWindow = indicatorStart !== undefined && indicatorEnd !== undefined && indicatorStart < indicatorEnd ? { start: indicatorStart, end: indicatorEnd } : null;
  const lineOverlays = selectedChartMetric === "price" && priceStyle === "line" && timestampedPriceLine && candleHistory?.source === "CoinGecko" && indicatorValues && indicatorWindow
    ? lineIndicatorOverlays(candleHistory, indicatorValues, priceIndicators, indicatorWindow, chartColors) : [];
  const lineRsiSegments = priceIndicators.rsi && timestampedPriceLine && candleHistory?.source === "CoinGecko" && indicatorValues && indicatorWindow
    ? indicatorSegments(candleHistory, indicatorValues.rsi, indicatorWindow) : [];

  const draftIssue = TRACKED_COINS.some((id) => {
    const draft = parseHoldingDraft(amountDrafts[id] ?? "");
    return draft.kind === "incomplete" || draft.kind === "invalid";
  });
  const portfolioInputMessage = !preferencesLoaded ? "Loading saved quantities…"
    : !storageWritable ? "Saved quantities are unavailable until browser data is reviewed"
      : draftIssue ? "Complete or correct your quantities to see an estimate" : "";
  const previewAmounts = useMemo(() => previewHoldings(amountDrafts, amounts, TRACKED_COINS), [amountDrafts, amounts]);
  const portfolio = useMemo(() => {
    const calculated = calculatePortfolio(previewAmounts, coinById, TRACKED_COINS);
    return portfolioInputMessage ? { ...calculated, total: null, dailyChange: null } : calculated;
  }, [previewAmounts, coinById, portfolioInputMessage]);

  function updateAmount(id: TrackedCoin, value: string) {
    if (!preferencesLoaded || !storageWritable || conflict.current) return;
    const drafts = { ...draftSnapshot.current, [id]: value };
    draftSnapshot.current = drafts;
    dirtyHoldingDrafts.current.add(id);
    setAmountDrafts(drafts);
    setStorageNotice("");
  }

  function commitAmount(id: TrackedCoin) {
    if (!preferencesLoaded || !storageWritable || conflict.current || !dirtyHoldingDrafts.current.has(id)) return;
    const draft = parseHoldingDraft(draftSnapshot.current[id] ?? "");
    if (draft.kind === "invalid" || draft.kind === "incomplete") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!readStoredHoldings(raw, TRACKED_COINS).ok) {
        privateEvents.dispatchEvent(new Event("paypal-markets-storage-corrupt"));
        return;
      }
      if (raw !== holdingsBaseline.current) {
        privateEvents.dispatchEvent(new Event("paypal-markets-holdings-conflict"));
        return;
      }
    } catch {
      privateEvents.dispatchEvent(new Event("paypal-markets-storage-error"));
      return;
    }
    const next = { ...amountSnapshot.current };
    if (draft.kind === "empty" || draft.amount === 0) delete next[id];
    else next[id] = draft.amount;
    dirtyHoldingDrafts.current.delete(id);
    if (sameHoldings(next, amountSnapshot.current)) return;
    holdingsPending.current = true;
    amountSnapshot.current = next;
    setAmounts(next);
  }

  function retrySaving() {
    if (!preferencesLoaded || !storageWritable || conflict.current) return;
    for (const id of [...dirtyHoldingDrafts.current]) commitAmount(id);
    setStorageRetry((current) => current + 1);
    privateEvents.dispatchEvent(new Event("paypal-markets-storage-recovered"));
  }

  function toggleWatchlist(id: TrackedCoin) {
    if (!preferencesLoaded || !storageWritable) return;
    const current = watchlistSnapshot.current;
    const next = current.includes(id) ? current.filter((coin) => coin !== id) : [...current, id];
    watchlistPending.current = true;
    watchlistSnapshot.current = next;
    setWatchlist(next);
  }

  function retryOverview() {
    setMarketFailure(null);
    setOverviewRefresh((current) => current + 1);
  }

  function refreshMarkets() {
    retryOverview();
    setChartFailure(null);
    setChartRefresh((current) => current + 1);
  }

  function changeCurrency(next: MarketCurrency) {
    setCurrency(next);
    setMarketFailure(null);
    setChartFailure(null);
    setChartViewport(FULL_CHART_VIEWPORT);
    setCandleView(null);
    if (!privateData.ready) return;
    try {
      localStorage.setItem(CURRENCY_KEY, JSON.stringify(next));
      setCurrencyStorageError("");
    } catch {
      setCurrencyStorageError("Your display currency changed for this visit, but the browser could not save it.");
    }
  }

  function chooseCoin(id: TrackedCoin) {
    setChartFailure(null);
    setChartViewport(FULL_CHART_VIEWPORT);
    setCandleView(null);
    setSelectedId(id);
  }

  function chooseDays(nextDays: ChartDays) {
    setChartFailure(null);
    setChartViewport(FULL_CHART_VIEWPORT);
    setCandleView(null);
    setDays(nextDays);
  }

  function chooseMetric(nextMetric: ChartMetric) {
    setChartViewport(FULL_CHART_VIEWPORT);
    setChartMetric(nextMetric);
  }

  function changeChartViewport(action: ChartViewportAction) {
    if (action === "reset") {
      setChartViewport(FULL_CHART_VIEWPORT);
      return;
    }
    setChartViewport((current) => chartViewportAction(current, action, chartSeries.length));
  }

  const visibleCoins = coins
    .filter((coin) => (tab === "markets" || watchlist.includes(coin.id)) &&
      `${coin.name} ${coin.symbol}`.toLowerCase().includes(assetQuery.trim().toLowerCase()))
    .sort((a, b) => assetSort === "price" ? (b.price ?? -Infinity) - (a.price ?? -Infinity) :
      assetSort === "change" ? (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity) :
        (a.rank ?? Infinity) - (b.rank ?? Infinity));

  return (
    <SiteShell activeSection={tab} onNavigate={navigate} refreshedAt={currentOverview?.retrievedAt} refreshing={marketLoading} onRefresh={refreshMarkets} currency={currency} currencyReady={currencyReady} onCurrencyChange={changeCurrency} sessionControl={<SessionHeaderControl onAccount={() => navigate("account")} />}>
      <div className="dashboard-content">
        <section className="page-heading">
          <div>
            <p className="eyebrow">{tab === "account" ? "YOUR ACCOUNT WORKSPACE" : "CLEAR PRICES. REAL MARKET CONTEXT."}</p>
            <h1>{tab === "account" ? "Your plans, in perspective." : tab === "shop" ? "Discover something good." : tab === "portfolio" ? "Your portfolio view." : tab === "settings" ? "Your data, your choice." : tab === "markets" ? "Explore the market." : "A clearer view of crypto."}</h1>
          </div>
          {tab !== "account" && <div className={tab === "overview" || tab === "markets" ? "updated-badge market-updated-badge" : "updated-badge"} aria-live="polite">
            <span className="live-pulse" />
            <span>{marketLoading ? "Requesting prices" : currentOverview ? `Snapshot retrieved ${formatMarketRetrievalTime(currentOverview.retrievedAt) ?? "time unavailable"}` : "Waiting for market prices"}</span>
          </div>}
        </section>

        {tab === "account" && <AccountSessionPanel experience={accountExperience} onChoose={chooseAccountExperience} />}
        {tab === "account" && privateData.ready && accountExperience !== null && <AccountExperienceSwitch experience={accountExperience} onChange={chooseAccountExperience} />}
        {!privateData.ready && tab !== "account" && <PrivateSessionNotice />}

        {storageError && <div className="notice error-notice" role="status"><span>{storageError}</span>{holdingsConflict && <button type="button" onClick={loadSavedQuantities}>Load saved quantities</button>}{storageRetryAvailable && storageWritable && <button type="button" onClick={retrySaving}>Retry saving</button>}</div>}
        {storageNotice && <div className="notice" role="status">{storageNotice}</div>}
        {businessDraftPending && !businessView && <div className="notice" role="status"><span>Your unsaved Business plan stays in memory while this dashboard is open. Leaving or reloading loses it; exports contain saved data only.</span><button type="button" onClick={() => { setAccountExperience("business"); navigate("account"); }}>View plan</button></div>}
        {currencyStorageError && <div className="notice error-notice" role="status"><span>{currencyStorageError}</span><button type="button" onClick={() => changeCurrency(currency)}>Save {currency} preference</button></div>}
        {marketError && tab !== "shop" && tab !== "settings" && tab !== "account" && (
          <div className="notice error-notice" role="alert">
            <span>{marketError}</span>
            <button onClick={retryOverview}>Retry</button>
          </div>
        )}

        {(["account", "portfolio", "shop", "settings"].includes(tab) && !privateData.ready) ? <div className="settings-card"><p>Saved holdings, collections, preferences and private drafts are held until this session is verified. You can continue browsing public markets.</p><button type="button" onClick={() => navigate("markets")}>Browse markets</button></div> : tab === "account" ? accountExperience === null ? null : accountExperience === "business"
          ? <BusinessMonitoring draftRef={businessDraftRef} onDraftChange={setBusinessDraftPending} />
          : currencyReady ? <PersonalAccountingLite currency={currency} portfolioTotal={portfolio.total} portfolioAvailable={portfolio.total !== null && !portfolioInputMessage} /> : <div className="list-loading" role="status">Loading your display currency…</div>
          : tab === "settings" ? <DataSettings currency={currency} currencyReady={currencyReady} onCurrencyChange={changeCurrency} /> : tab === "shop" ? (
          <Marketplace aiInsightsAvailable={aiInsightsAvailable} />
        ) : tab === "portfolio" ? (
          <PortfolioPanel coins={coins} amounts={previewAmounts} drafts={amountDrafts} editable={preferencesLoaded && storageWritable} inputMessage={portfolioInputMessage} updateAmount={updateAmount} commitAmount={commitAmount} portfolio={portfolio} loading={marketLoading} currency={currency} />
        ) : (
          <>
            <section className="dashboard-grid" aria-label="Crypto market overview">
              <article className="chart-card">
                <div className="market-masthead">
                  <div className="chart-card-top">
                    <div className="market-quote">
                      <p className="market-asset-title">{selectedCoin?.name ?? ASSET_DETAILS[selectedId].name} <span>{selectedCoin?.symbol ?? ASSET_DETAILS[selectedId].symbol}</span></p>
                      <p className="market-quote-label">{minuteCandles ? `Closed price · USDT · ${candleInterval} Binance Spot candles` : <>{selectedMetricLabel} · {currency} market reference{headline.source === "chart" ? " · chart sample" : ""}</>}</p>
                      <div className="primary-metric-row">
                        <h2>{minuteCandles ? formatUsdtPrice(minuteLast?.close) : selectedChartMetric === "price" ? money(selectedMetricValue, currency, preciseStablecoinPrice ? 4 : 0) : compactMoney(selectedMetricValue, currency)}</h2>
                        {displayedChange !== null && <span className={displayedChange >= 0 ? "change-chip positive" : "change-chip negative"} aria-label={`${selectedMetricLabel} change over ${displayedRangeLabel}: ${percent(displayedChange)}`}>{percent(displayedChange)}</span>}
                      </div>
                      <p className="chart-context">Change over {displayedRangeLabel}{!minuteCandles && selectedIsStablecoin ? " · USD stablecoin" : ""} · {displayedProvenance}</p>
                    </div>
                    <span className="market-source-label">{minuteCandles ? "Binance Spot · USDT" : "CoinGecko reference"}</span>
                  </div>
                  <div className="asset-picker-heading"><span>Choose asset</span><span className="asset-swipe-hint">Swipe to explore →</span></div>
                  <div className="coin-picker" role="group" aria-label="Select crypto asset">
                    {coins.length ? coins.map((coin) => (
                      <button
                        key={coin.id}
                        className={selectedId === coin.id ? "coin-picker-button selected" : "coin-picker-button"}
                        onClick={() => chooseCoin(coin.id)}
                        aria-pressed={selectedId === coin.id}
                        aria-label={`View ${coin.name}`}
                        title={coin.name}
                      >
                        {coin.symbol}
                      </button>
                    )) : <span className="asset-picker-empty">{marketLoading ? "Loading assets…" : "Assets unavailable"}</span>}
                  </div>
                </div>
                <div className="chart-body">
                <div className="chart-body-heading"><h3>Market chart</h3><span>{selectedMetricLabel} · {minuteCandles ? "Binance Spot · USDT" : "CoinGecko"}</span></div>
                <div className="chart-toolbar">
                  {!minuteCandles && <div className="chart-control-block"><span className="chart-control-label">Range</span><div className="range-picker" role="group" aria-label="Chart time range">
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
                  </div></div>}
                  <div className="chart-control-block"><span className="chart-control-label">Metric</span><div className="chart-metric-picker" role="group" aria-label="Chart metric">
                    {chartMetrics.map((metric) => (
                      <button
                        key={metric.id}
                        className={selectedChartMetric === metric.id ? "chart-metric-button active" : "chart-metric-button"}
                        onClick={() => chooseMetric(metric.id)}
                        aria-pressed={selectedChartMetric === metric.id}
                        disabled={Boolean(chartMatches && chart && !chartAvailableMetrics.includes(metric.id))}
                      >
                        {metric.label}
                      </button>
                    ))}
                  </div></div>
                  {selectedChartMetric === "price" && <div className="chart-control-block"><span className="chart-control-label">View</span><div className="range-picker" role="group" aria-label="Price chart style">
                    <button type="button" className={priceStyle === "line" ? "range-button active" : "range-button"} aria-pressed={priceStyle === "line"} onClick={() => setPriceStyle("line")}>Line</button>
                    <button type="button" className={priceStyle === "candles" ? "range-button active" : "range-button"} aria-pressed={priceStyle === "candles"} disabled={!currencyReady} onClick={() => setPriceStyle("candles")}>Candles</button>
                  </div></div>}
                </div>

                {selectedChartMetric === "price" && priceStyle === "candles" && <CandleFeedControls coinId={selectedId} interval={candleInterval} days={intradayDays} onIntervalChange={chooseCandleInterval} onDaysChange={setIntradayDays} />}

                <div className="chart-legend-row"><span className="chart-kind"><span className={displayedChange !== null && displayedChange < 0 ? "chart-kind-dot down" : "chart-kind-dot"} style={selectedChartMetric !== "price" || priceStyle === "line" ? { background: "#00CCFF" } : undefined} /> {selectedMetricLabel}{minuteCandles ? " · USDT" : stablecoinPriceChart ? <span className="peg-reference"> · $1.00 peg reference</span> : null}</span>{selectedChartMetric === "price" && <PriceIndicatorControls indicators={priceIndicators} onChange={setPriceIndicators} history={candleHistory} />}</div>
                {selectedChartMetric === "price" && priceStyle === "line" && indicatorEnabled && <LineIndicatorStatus request={candleRequest} indicators={priceIndicators} values={indicatorValues} window={indicatorWindow} approximateLine={chartMatches && chartSeriesSource === "market_overview_sparkline"} lineAvailable={timestampedPriceLine} precisePrice={selectedIsStablecoin} onCandles={() => setPriceStyle("candles")} />}

                {selectedChartMetric === "price" && priceStyle === "candles" ? <div className="candle-frame"><CandleHistoryPanel key={`${candleSelectionIdentity({ coinId: selectedId, currency, days, intraday: intradaySelection })}:${chartRefresh}`} coinId={selectedId} currency={currency} days={days} intraday={intradaySelection} precisePrice={selectedIsStablecoin} request={candleRequest} indicators={priceIndicators} onIndicatorsChange={setPriceIndicators} showIndicatorControls={false} viewSnapshot={candleView} onViewSnapshotChange={setCandleView} /></div> : <><div className="chart-frame">
                  {chartIsLoading ? <div className="chart-empty" role="status">Loading {selectedMetricLabel.toLowerCase()} history…</div> :
                    chartError ? <div className="chart-empty" role="status">{chartError}</div> :
                      <MetricChart points={displayedChartSeries} down={(chartChange ?? 0) < 0} label={chartLabel} metric={selectedChartMetric} days={days} currency={currency} precisePrice={preciseStablecoinPrice} stablecoin={stablecoinPriceChart} overlays={lineOverlays} alignRsi={selectedChartMetric === "price" && priceIndicators.rsi && timestampedPriceLine && Boolean(candleHistory)} approximateTime={chartSeriesSource === "market_overview_sparkline"} fullPoints={chartSeries} viewport={chartViewport} onViewportChange={setChartViewport} />}
                </div>
                {selectedChartMetric === "price" && priceIndicators.rsi && timestampedPriceLine && candleHistory && indicatorValues && indicatorWindow && <PriceLineRsi segments={lineRsiSegments} window={indicatorWindow} days={days} />}
                {chartMatches && chartSeriesSource === "market_overview_sparkline" && (
                  <p className="chart-data-note" role="status">
                    CoinGecko is limiting detailed history. Showing its cached 7-day price sparkline; sample times are spread evenly across the window. Market-cap and volume history are temporarily unavailable.
                  </p>
                )}
                <div className="chart-scale"><span>Visible low {chartValues.length ? chartValue(Math.min(...chartValues), selectedChartMetric, currency, preciseStablecoinPrice) : "—"}</span><span>Visible high {chartValues.length ? chartValue(Math.max(...chartValues), selectedChartMetric, currency, preciseStablecoinPrice) : "—"}</span></div>
                <p className="chart-scale-note">Times in UTC · Scale follows visible data{lineOverlays.length > 0 ? " and candle-close averages" : ""}{visibleDomain && visibleDomain.min > 0 ? " · starts above zero" : ""}</p>
                <ChartZoomControls viewport={chartViewport} points={chartSeries} visiblePoints={displayedChartSeries} onAction={changeChartViewport} />
                <div className="chart-footer">
                  <span>Source: <a href="https://www.coingecko.com/" target="_blank" rel="noreferrer">CoinGecko</a></span>
                  <span>Chart retrieved {timestamp(chartMatches ? chart?.retrievedAt : undefined)}</span>
                </div>
                </>}
                </div>
              </article>

              <aside className="side-stack">
                <article className="portfolio-card">
                  <div className="card-heading-row"><div><p className="eyebrow light-eyebrow">YOUR CRYPTO PORTFOLIO</p><h2>Track what you hold</h2></div><span className="sparkle-badge" aria-hidden="true">✳</span></div>
                  {!privateData.ready ? <><p className="portfolio-total empty-total">—</p><p className="portfolio-delta muted-text">Saved holdings stay hidden until your session is verified.</p></> : portfolio.positions.length ? (
                    <>
                      <p className={portfolio.total === null ? "portfolio-total empty-total" : "portfolio-total"}>{formatPortfolioMoney(portfolio.total, currency)}</p>
                      <p className={portfolio.dailyChange === null || portfolio.dailyChange === 0 ? "portfolio-delta muted-text" : portfolio.dailyChange > 0 ? "portfolio-delta positive-text" : "portfolio-delta negative-text"}>
                        {portfolioStatus(portfolio, marketLoading, currency, portfolioInputMessage)}
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
                  <div><strong className="wallet-note-title">Your wallet stays yours</strong></div>
                </article>
              </aside>
            </section>

            {minuteCandles && <p className="chart-data-note">Overview and portfolio: CoinGecko · {currency}. AI context: CoinGecko history · {days}-day range · {currency}, independently preserved from the USDT candle window.</p>}
            <InsightPanel kind="market" enabled={aiInsightsAvailable} selection={{ coinId: selectedId, currency, days }} />

            <section className="metrics-row" aria-label="Selected asset metrics">
              <Metric label="Market cap" value={compactMoney(selectedCoin?.marketCap, currency)} detail={selectedCoin?.rank ? `Rank #${selectedCoin.rank}` : "Market value"} />
              <Metric label="24h volume" value={compactMoney(selectedCoin?.volume24h, currency)} detail="Across tracked markets" />
              <Metric label="24h high" value={money(selectedCoin?.high24h, currency, selectedIsStablecoin ? 4 : 0)} detail={currency} />
              <Metric label="24h low" value={money(selectedCoin?.low24h, currency, selectedIsStablecoin ? 4 : 0)} detail={currency} />
            </section>

            <section className="assets-section">
              <div className="section-heading">
                <div><p className="eyebrow">MARKET WATCH</p><h2>{tab === "markets" ? "Tracked crypto assets" : privateData.ready ? "Your market watchlist" : "Public market list"}</h2></div>
                <button className="text-button" onClick={() => navigate("markets")}>View all assets <span aria-hidden="true">→</span></button>
              </div>
              <div className="asset-filters">
                <label>Find an asset<input type="search" value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder="Name or symbol" /></label>
                <label>Sort by<select value={assetSort} onChange={(event) => setAssetSort(event.target.value)}><option value="rank">Market cap rank</option><option value="price">Price, highest first</option><option value="change">24h change, highest first</option></select></label>
              </div>
              {marketLoading && !coins.length ? <div className="list-loading">Fetching market data…</div> : coins.length ? (
                <div className="asset-table">
                  <div className="asset-table-head"><span>Asset</span><span>Price</span><span>24h</span><span>7 day trend</span><span aria-label="Watchlist control" /></div>
                  {visibleCoins.map((coin) => (
                    <article key={coin.id} className={selectedId === coin.id ? "asset-row active-row" : "asset-row"}>
                      <button className="asset-main" onClick={() => { chooseCoin(coin.id); navigate("overview"); }}>
                        <AssetMark id={coin.id} />
                        <span className="asset-names"><strong>{coin.name}</strong><span>{coin.symbol}{coin.id === "paypal-usd" ? " · USD stablecoin" : ""}</span></span>
                      </button>
                      <button className="asset-price" onClick={() => { chooseCoin(coin.id); navigate("overview"); }}>{money(coin.price, currency, coin.id === "paypal-usd" ? 4 : 0)}</button>
                      <span className={coin.change24hPct !== null && coin.change24hPct < 0 ? "asset-change negative-text" : "asset-change positive-text"}>{percent(coin.change24hPct)}</span>
                      <Sparkline values={coin.sparkline7d} down={(coin.change7dPct ?? 0) < 0} label={coin.name} stablecoin={coin.id === "paypal-usd" && currency === "USD"} />
                      <button className={watchlist.includes(coin.id) ? "watch-button watching" : "watch-button"} onClick={() => toggleWatchlist(coin.id)} disabled={!privateData.ready || !preferencesLoaded || !storageWritable} aria-label={`${watchlist.includes(coin.id) ? "Remove" : "Add"} ${coin.name} ${watchlist.includes(coin.id) ? "from" : "to"} watchlist`} aria-pressed={watchlist.includes(coin.id)}>
                        {watchlist.includes(coin.id) ? "★" : "☆"}
                      </button>
                    </article>
                  ))}
                </div>
              ) : <div className="list-loading">Market assets are not available right now.</div>}
              {!marketLoading && coins.length > 0 && visibleCoins.length === 0 && <div className="list-loading">{assetQuery ? "No assets match your search. Try Bitcoin, Chainlink, Litecoin, Bitcoin Cash, or PYUSD." : <>Your watchlist is empty. <button className="text-button" onClick={() => navigate("markets")}>Browse assets to add</button></>}</div>}
              <p className="data-caption">Prices are market references and can differ from the price available through any payment provider.</p>
            </section>
          </>
        )}

        <footer className="disclosure"><details><summary>About this view</summary><p>
          {tab === "account" ? businessView
            ? "This Business preview uses fictional examples or your locally provided report. A PayPal account is not connected; live reporting requires authorized account access and a verified data source."
            : "Personal planning uses hypothetical amounts and an optional manually entered portfolio estimate. It does not read a cash balance, transfer money, or change an account."
            : tab === "settings" ? "Your saved information is local to this browser. This concept has no connected payment account." : tab === "shop"
            ? "Product prices and availability can change. Channel3 links open the retailer, where you can review the current offer and complete checkout."
            : "Crypto market information is for reference only. Tracked assets reflect PayPal's published crypto list; availability varies by region and account. Portfolio values use amounts entered manually on this device and do not represent Venmo balances or a connected wallet."}
          {tab === "portfolio" && " The 24h price movement assumes the same quantities throughout; it does not use transaction history."}
        </p></details></footer>
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
  drafts,
  editable,
  inputMessage,
  updateAmount,
  commitAmount,
  portfolio,
  loading,
  currency,
}: {
  coins: MarketQuote[];
  amounts: Amounts;
  drafts: HoldingDrafts;
  editable: boolean;
  inputMessage: string;
  updateAmount: (id: TrackedCoin, value: string) => void;
  commitAmount: (id: TrackedCoin) => void;
  portfolio: PortfolioSummary;
  loading: boolean;
  currency: MarketCurrency;
}) {
  const quotesById = new Map(coins.map((coin) => [coin.id, coin]));
  const hasNoHoldings = portfolio.positions.length === 0;
  return (
    <section className="portfolio-page">
      <div className={hasNoHoldings ? "portfolio-summary portfolio-summary--empty" : "portfolio-summary"}>
        <div><p className="eyebrow light-eyebrow">MANUAL PORTFOLIO VIEW</p><h2>Holdings estimate</h2>{hasNoHoldings && <a className="portfolio-empty-link" href="#portfolio-holdings" aria-controls="portfolio-holdings">Add quantities <span aria-hidden="true">↓</span></a>}</div>
        <div className="portfolio-summary-value"><span>Total value · {currency}</span><strong>{formatPortfolioMoney(portfolio.total, currency)}</strong><small className={portfolio.dailyChange === null || portfolio.dailyChange === 0 ? undefined : portfolio.dailyChange > 0 ? "positive-text" : "negative-text"}>{portfolioStatus(portfolio, loading, currency, inputMessage)}</small></div>
      </div>
      <PortfolioAllocation portfolio={portfolio} currency={currency} inputMessage={inputMessage} loading={loading} />
      <div id="portfolio-holdings" className="manual-holdings-card">
        <div className="section-heading"><div><p className="eyebrow">EDIT HOLDINGS</p><h2>Crypto quantities</h2></div><span className="local-badge">Saved on this device</span></div>
        <p id="holding-quantity-help" className="data-caption">Use a period for decimals. Quantities up to 1,000,000,000,000 save when you leave the field or press Enter. If a quantity would be rounded, shorten it before saving.</p>
        {TRACKED_COINS.map((id) => {
          const asset = ASSET_DETAILS[id];
          const coin = quotesById.get(id);
          const name = coin?.name ?? asset.name;
          const symbol = coin?.symbol ?? asset.symbol;
          const price = typeof coin?.price === "number" && Number.isFinite(coin.price) && coin.price >= 0 ? coin.price : null;
          const amount = amounts[id];
          const value = drafts[id] ?? (amount === undefined ? "" : String(amount));
          const draft = parseHoldingDraft(value);
          const rowValue = draft.kind === "valid" && amount !== undefined ? calculateHoldingValue(amount, price) : null;
          const precisionError = draft.kind === "invalid" && draft.reason === "precision";
          const providerUpdate = coin ? formatMarketProviderUpdateTime(coin.lastUpdated) : null;
          return <label className={precisionError ? "holding-row holding-row--precision-error" : "holding-row"} key={id}>
            <span className="holding-asset"><AssetMark id={id} /><span><strong>{name}</strong><small>{symbol}{id === "paypal-usd" ? " · USD stablecoin" : ""} · {price === null ? loading ? "Loading price…" : "Price unavailable" : `${money(price, currency, id === "paypal-usd" ? 4 : 0)} each`}</small>{providerUpdate && <small className="holding-quote-time">CoinGecko update: {providerUpdate === "time unavailable" ? providerUpdate : <><span className="holding-quote-part">{providerUpdate.slice(0, 10)}</span>{" "}<span className="holding-quote-part">{providerUpdate.slice(11)}</span></>}</small>}{precisionError && <small id={`holding-precision-${id}`} className="holding-precision-error">This quantity would be rounded and cannot be saved. Shorten it to continue.</small>}</span></span>
            <span className="holding-input-wrap"><input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={value} onChange={(event) => updateAmount(id, event.target.value)} onBlur={() => commitAmount(id)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} readOnly={!editable} aria-invalid={draft.kind === "invalid"} aria-describedby={`holding-quantity-help${precisionError ? ` holding-precision-${id}` : ""}`} aria-label={`Amount of ${name} to include in your manual portfolio`} placeholder="0" /><span>{symbol}</span></span>
            <strong className="holding-value">{rowValue !== null && Number.isFinite(rowValue) ? formatPortfolioMoney(rowValue, currency) : "—"}</strong>
          </label>;
        })}
        {!coins.length && <div className="list-loading">{loading ? "Updating market prices…" : "Prices are unavailable. Your quantities remain editable."}</div>}
      </div>
      <VenmoDraft />
      <div className="notice privacy-notice"><span className="privacy-mark" aria-hidden="true">✓</span><p><strong>Venmo remains your wallet.</strong> This manual estimate does not connect to, read from, or change Venmo or any payment account. Your entries stay in this browser on this device.</p></div>
    </section>
  );
}
