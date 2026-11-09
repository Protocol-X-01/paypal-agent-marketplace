import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}, suffix = "") {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source + suffix, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const cjs = { exports: {} };
  const require = (name) => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw new Error(`Unexpected dashboard test dependency: ${name}`); };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}
const data = await load("../src/lib/web-candle-data.ts");
const math = await load("../src/lib/candle-series.ts");
const indicators = await load("../src/lib/price-indicators.ts", { "./candle-series": math });
const state = await load("../src/lib/public-chart-state.ts");
const chartViewport = await load("../src/lib/chart-viewport.ts");
function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join("");
  return typeof node === "object" ? text(node.props?.children) : String(node);
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
}
const find = (tree, predicate) => { const value = nodes(tree).find(predicate); assert.ok(value, "Expected dashboard element"); return value; };

function referenceHistory(options) {
  const minute = options.intraday;
  const minutes = minute ? Number(minute.interval.slice(0, -1)) : 240;
  const days = minute?.days ?? options.days;
  const count = minute ? days * 1440 / minutes : 30;
  const start = Date.UTC(2026, 10, 5, 12);
  const candles = Array.from({ length: count }, (_, i) => ({ timestamp: start + (i + 1) * minutes * 60_000, open: 100 + i, high: 103 + i, low: 99 + i, close: 102 + i }));
  const end = start + days * 86_400_000;
  return minute ? data.parseIntradayCandleHistory({ coinId: options.coinId, source: "Binance Spot", quote: "USDT", interval: minute.interval, intervalMinutes: minutes, days, timestampKind: "close", observedAt: new Date(end + 1000).toISOString(), retrievedAt: new Date(end + 1200).toISOString(), coveredStart: start, coveredEnd: end, count, candles }, { coinId: options.coinId, ...minute }) : { coinId: options.coinId, currency: options.currency, days, source: "CoinGecko", retrievedAt: new Date(end + 1200).toISOString(), candleIntervalMinutes: 240, timestampKind: "close", candles };
}

async function dashboard() {
  const slots = [];
  let cursor = 0;
  let controls = { ...state.createPublicChartControls(), style: "candles", days: 30 };
  const requests = [];
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    createContext(defaultValue) { return { defaultValue }; },
    useContext(context) { return context.defaultValue; },
    useMemo: (calculate) => calculate(), useCallback: (callback) => callback,
    useEffect() {}, // No lifecycle, storage, HTTP or browser effects are run in this render check.
  };
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const component = (name) => ({ __esModule: true, default: name });
  const aliases = {
    react: hooks, "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "ag-charts-react": { AgCharts: "AgCharts" }, "ag-charts-community": {},
    "@/lib/market-assets": await load("../src/lib/market-assets.ts"),
    "@/lib/market-currency": { isMarketCurrency: (value) => ["USD", "GBP"].includes(value) },
    "@/lib/chart-scale": await load("../src/lib/chart-scale.ts"),
    "@/lib/chart-viewport": await load("../src/lib/chart-viewport.ts"),
    "@/lib/chart-wheel": {}, "@/lib/market-format": await load("../src/lib/market-format.ts"),
    "@/lib/web-candle-data": data, "@/lib/price-indicators": indicators,
    "@/lib/market-headline": { selectMarketHeadline: () => ({ value: null, source: "unavailable", retrievedAt: null }) },
    "@/lib/portfolio-summary": { calculatePortfolio: () => ({ positions: [], total: null, dailyChange: null }) },
    "@/lib/portfolio-input": { parseHoldingDraft: () => ({ kind: "empty" }), previewHoldings: () => ({}) },
    "@/lib/account-experience": await load("../src/lib/account-experience.ts"),
    "./components/customer-session": { useCustomerSession: () => ({ state: { status: "uncertain" } }), usePrivateDataScope: () => ({ ready: false, storage: null, events: {} }), PrivateSessionNotice: "PrivateSessionNotice" },
    "./components/customer-session-panel": { AccountSessionPanel: "AccountSessionPanel", SessionHeaderControl: "SessionHeaderControl" },
    "./components/customer-workspace-boundary": { usePublicChartControl: (current, dispatch, key) => [current[key], (next) => dispatch((previous) => ({ ...previous, [key]: typeof next === "function" ? next(previous[key]) : next }))] },
    "./components/use-candle-history": { useCandleHistory: (options) => {
      requests.push(options);
      if (!options.enabled) return { status: "idle", retry() {} };
      if (options.intraday && !data.isSupportedIntradaySelection(options.coinId, options.intraday)) return { status: "error", message: "Unsupported minute selection", retry() {} };
      return { status: "ready", history: referenceHistory(options), retry() {} };
    } },
    "./components/price-chart-indicators": { PriceIndicatorControls: "PriceIndicatorControls", LineIndicatorStatus: "LineIndicatorStatus", PriceLineRsi: "PriceLineRsi", useMarketChartFont: () => "sans-serif" },
    "./components/use-plot-wheel-zoom": { usePlotWheelZoom() {} },
  };
  for (const name of ["site-shell", "marketplace", "data-settings", "business-monitoring", "venmo-draft", "chart-zoom-controls", "candle-history-panel", "candle-feed-controls", "portfolio-allocation", "personal-accounting-lite", "account-experience-switch"]) aliases[`./components/${name}`] = component(name);
  aliases["../../packages/ai-insights/ui/InsightPanel"] = component("InsightPanel");
  const dashboardModule = await load("../src/app/market-dashboard.tsx", aliases, "\nexport { MarketDashboardBody as DashboardUnderTest, PortfolioPanel as PortfolioPanelUnderTest, MetricChart as MetricChartUnderTest, requestOverview as requestOverviewUnderTest };\n");
  const change = (next) => { controls = typeof next === "function" ? next(controls) : next; };
  return { requests, requestOverview: dashboardModule.requestOverviewUnderTest, render() { cursor = 0; return dashboardModule.DashboardUnderTest({ publicChart: controls, onPublicChartChange: change }); }, renderPortfolioPanel(props) { return dashboardModule.PortfolioPanelUnderTest(props); }, renderMetricChart(props) { cursor = 0; return dashboardModule.MetricChartUnderTest(props); }, setControls: (next) => { controls = { ...controls, ...next }; }, get controls() { return controls; } };
}

test("dashboard rejects a snapshot with conflicting duplicate coin IDs", async () => {
  const app = await dashboard();
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ currency: "GBP", provider: "CoinGecko", coins: [{ id: "bitcoin", price: 100 }, { id: "bitcoin", price: 200 }] }) });
    await assert.rejects(app.requestOverview("GBP", new AbortController().signal), /duplicate or unsupported assets/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ currency: "GBP", provider: "CoinGecko", coins: [{ id: "bitcoin", price: 100 }] }) });
    assert.equal((await app.requestOverview("GBP", new AbortController().signal)).coins.length, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test("line chart tooltips distinguish same-day samples in UTC and label estimated times", async () => {
  const oldZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const app = await dashboard();
    const points = [
      { timestamp: Date.UTC(2026, 10, 6, 12, 5, 0), value: 100 },
      { timestamp: Date.UTC(2026, 10, 6, 13, 5, 6, 250), value: 101 },
    ];
    const props = { points, fullPoints: points, viewport: { start: 0, end: 1 }, onViewportChange() {}, label: "Bitcoin price", metric: "price", days: 7, currency: "USD" };
    let chart = find(app.renderMetricChart(props), (node) => node.type === "AgCharts").props.options;
    const tooltip = chart.series[0].tooltip.renderer;
    assert.equal(tooltip({ datum: chart.data[0] }).heading, "2026-11-06 12:05:00 UTC");
    assert.equal(tooltip({ datum: chart.data[1] }).heading, "2026-11-06 13:05:06.250 UTC");
    assert.equal(chart.axes.x.label.formatter({ value: points[0].timestamp }), "06 Nov");
    chart = find(app.renderMetricChart({ ...props, days: 1, approximateTime: true }), (node) => node.type === "AgCharts").props.options;
    assert.equal(chart.axes.x.label.formatter({ value: new Date(points[0].timestamp) }), "12:05");
    assert.equal(chart.series[0].tooltip.renderer({ datum: chart.data[0] }).heading, "Estimated sample time · 2026-11-06 12:05:00 UTC");
  } finally {
    if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone;
  }
});

test("line chart data pages mount on demand, expose middle and later points, and reset safely with the window", async () => {
  const app = await dashboard();
  const points = Array.from({ length: 205 }, (_, index) => ({
    timestamp: Date.UTC(2026, 10, 6, 12, 5, 0) + index * 60_000,
    value: 0.9997 + index * 0.0001,
  }));
  const baseProps = { fullPoints: points, onViewportChange() {}, label: "PayPal USD price over 1W", metric: "price", days: 7, currency: "USD", precisePrice: true, stablecoin: true, approximateTime: false };
  const visibleRows = (tree) => {
    const disclosure = find(tree, (node) => node.type === "details" && node.props.className === "metric-chart-data");
    const summary = find(disclosure, (node) => node.type === "summary");
    const table = nodes(disclosure).find((node) => node.type === "table");
    const rows = table ? nodes(table).filter((node) => node.type === "tr") : [];
    const buttons = nodes(disclosure).filter((node) => node.type === "button");
    const pageStatus = nodes(disclosure).find((node) => node.type === "span" && node.props["aria-live"] === "polite");
    return { disclosure, summary, table, rows, buttons, pageStatus };
  };

  const fullViewport = { start: 0, end: 1 };
  let tree = app.renderMetricChart({ ...baseProps, points, viewport: fullViewport });
  let result = visibleRows(tree);
  assert.equal(text(result.summary), "View chart data (205 visible points)");
  assert.equal(result.disclosure.props.open, undefined, "the native disclosure starts collapsed");
  assert.equal(result.table, undefined, "closed chart data does not construct table rows");
  assert.equal(nodes(result.disclosure).some((node) => node.type === "tr"), false);

  result.disclosure.props.onToggle({ currentTarget: { open: true } });
  const freshPoints = points.map((point) => ({ ...point }));
  tree = app.renderMetricChart({ ...baseProps, points: freshPoints, viewport: fullViewport });
  result = visibleRows(tree);
  assert.equal(result.rows.length, 101, "one page renders only 100 sample rows");
  assert.equal(text(result.pageStatus), "Samples 1–100 of 205");
  assert.equal(result.buttons[0].props.disabled, true);
  assert.equal(result.buttons[1].props["aria-label"], "Next 100 samples");
  assert.equal(result.buttons[1].props.disabled, false);
  assert.equal(find(result.disclosure, (node) => node.type === "div" && node.props.className === "metric-chart-data-table").props.tabIndex, 0);
  assert.deepEqual(nodes(result.rows[51]).filter((node) => node.type === "td").map(text), ["2026-11-06 12:55:00 UTC", "$1.0047"]);
  assert.ok(text(result.table).includes("sample times in UTC"));

  result.buttons[1].props.onClick();
  tree = app.renderMetricChart({ ...baseProps, points: points.map((point) => ({ ...point })), viewport: fullViewport });
  result = visibleRows(tree);
  assert.equal(text(result.pageStatus), "Samples 101–200 of 205", "fresh array identities do not reset the selected page");
  assert.deepEqual(nodes(result.rows[1]).filter((node) => node.type === "td").map(text), ["2026-11-06 13:45:00 UTC", "$1.0097"]);

  result.buttons[1].props.onClick();
  tree = app.renderMetricChart({ ...baseProps, points: points.map((point) => ({ ...point })), viewport: fullViewport });
  result = visibleRows(tree);
  assert.equal(text(result.pageStatus), "Samples 201–205 of 205");
  assert.equal(result.rows.length, 6, "the last page contains the remaining five samples");
  assert.deepEqual(nodes(result.rows[5]).filter((node) => node.type === "td").map(text), ["2026-11-06 15:29:00 UTC", "$1.0201"]);
  assert.equal(result.buttons[1].props.disabled, true);

  const zoomViewport = { start: 0.5, end: 0.6 };
  const zoomPoints = chartViewport.visibleChartPoints(points, zoomViewport);
  assert.ok(zoomPoints.length > 0 && zoomPoints.length < 100);
  tree = app.renderMetricChart({ ...baseProps, points: zoomPoints, viewport: zoomViewport });
  result = visibleRows(tree);
  assert.equal(text(result.summary), `View chart data (${zoomPoints.length} visible points)`);
  assert.equal(text(result.pageStatus), `Samples 1–${zoomPoints.length} of ${zoomPoints.length}`, "a new zoom window returns to its first valid page");
  assert.equal(result.rows.length, zoomPoints.length + 1);
  assert.deepEqual(nodes(result.rows[1]).filter((node) => node.type === "td").map(text), [new Date(zoomPoints[0].timestamp).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC"), "$1.0099"]);
  assert.equal(text(result.table).includes("2026-11-06 15:29:00 UTC"), false, "old later-page samples never survive a zoom-window change");

  const quotePoints = zoomPoints.slice(0, 3).map((point, index) => ({ ...point, value: 1_000_000 + index * 250_000 }));
  tree = app.renderMetricChart({ ...baseProps, points: quotePoints, fullPoints: quotePoints, viewport: fullViewport, label: "Litecoin market cap over 1M", metric: "marketCap", days: 30, currency: "GBP", precisePrice: false, stablecoin: false, approximateTime: true });
  result = visibleRows(tree);
  assert.equal(text(result.pageStatus), "Samples 1–3 of 3", "an asset, metric, range, and currency change cannot leave an invalid page selected");
  assert.ok(text(result.table).includes("Market cap (GBP)"));
  assert.ok(text(result.table).includes("Estimated sample time ·"));
});

test("Home and Markets share minute controls, native quote headline and an independently preserved AI range", async () => {
  const previous = globalThis.window;
  globalThis.window = { location: { hash: "#overview" }, history: { pushState(_state, _title, hash) { globalThis.window.location.hash = hash; } }, scrollTo() {} };
  try {
    const app = await dashboard();
    let tree = app.render();
    let feed = find(tree, (node) => node.type === "candle-feed-controls");
    assert.equal(feed.props.interval, "auto");
    feed.props.onIntervalChange("3m");
    tree = app.render();
    assert.equal(app.controls.days, 30);
    assert.match(text(tree), /581.00 USDT/);
    assert.match(text(tree), /Closed price · USDT · 3m Binance Spot candles/);
    assert.match(text(tree), /AI context: CoinGecko history · 30-day range · USD/);
    assert.equal(find(tree, (node) => node.type === "InsightPanel").props.selection.days, 30);
    assert.equal(find(tree, (node) => node.type === "InsightPanel").props.selection.currency, "USD");
    const panel = find(tree, (node) => node.type === "candle-history-panel");
    assert.equal(panel.props.request.history.currency, "USDT");
    assert.deepEqual(panel.props.intraday, { interval: "3m", days: 1 });
    assert.match(panel.key, /^Binance Spot:bitcoin:USDT:1:3m:/);
    assert.equal(nodes(tree).some((node) => node.props["aria-label"] === "Chart time range"), false);
    tree.props.onNavigate("markets");
    tree = app.render();
    assert.equal(tree.props.activeSection, "markets");
    assert.match(text(tree), /Explore the market/);
    assert.equal(find(tree, (node) => node.type === "candle-feed-controls").props.interval, "3m");
    assert.match(text(tree), /581.00 USDT/);
    const line = find(tree, (node) => node.type === "button" && text(node) === "Line");
    line.props.onClick();
    tree = app.render();
    assert.equal(app.controls.candleInterval, "3m");
    assert.equal(app.controls.days, 30);
    assert.equal(nodes(tree).some((node) => node.type === "candle-feed-controls"), false);
    assert.ok(nodes(tree).some((node) => node.props["aria-label"] === "Chart time range"));
    assert.doesNotMatch(text(tree), /Closed price · USDT|581.00 USDT/);
    assert.equal(app.requests.at(-1).intraday, undefined);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test("fiat preference never relabels minute prices and PYUSD never substitutes an Auto result", async () => {
  const app = await dashboard();
  app.setControls({ candleInterval: "5m", intradayDays: 1 });
  let tree = app.render();
  const before = text(find(tree, (node) => node.type === "h2"));
  assert.equal(before, "389.00 USDT");
  tree.props.onCurrencyChange("GBP");
  tree = app.render();
  assert.equal(text(find(tree, (node) => node.type === "h2")), before);
  assert.match(text(tree), /Overview and portfolio: CoinGecko · GBP/);
  assert.equal(find(tree, (node) => node.type === "InsightPanel").props.selection.currency, "GBP");
  app.setControls({ selectedId: "paypal-usd" });
  tree = app.render();
  assert.equal(find(tree, (node) => node.type === "candle-feed-controls").props.coinId, "paypal-usd");
  assert.equal(find(tree, (node) => node.type === "candle-history-panel").props.request.status, "error");
  assert.equal(text(find(tree, (node) => node.type === "h2")), "— USDT");
  assert.equal(app.controls.candleInterval, "5m");
});

test("portfolio rows show the CoinGecko provider update separately from snapshot retrieval", async () => {
  const app = await dashboard();
  const tree = app.renderPortfolioPanel({
    coins: [{ id: "bitcoin", name: "Bitcoin", symbol: "BTC", rank: 1, price: 60_000, marketCap: 1, volume24h: 1,
      change24hPct: null, change7dPct: null, high24h: 60_000, low24h: 60_000, sparkline7d: [], lastUpdated: "2026-11-06T12:34:56Z" }],
    amounts: { bitcoin: 0.5 }, drafts: {}, editable: true, inputMessage: "", updateAmount() {}, commitAmount() {},
    portfolio: { positions: [], total: 30_000, dailyChange: null }, loading: false, currency: "GBP",
  });
  assert.match(text(tree), /CoinGecko update: 2026-11-06 12:34:56 UTC/);
  assert.match(text(tree), /£60,000/);
  assert.match(text(tree), /£30,000/);
  const update = find(tree, (node) => node.type === "small" && text(node).startsWith("CoinGecko update:"));
  assert.equal(update.props["aria-hidden"], undefined, "provider timing remains in the accessibility tree");
});

test("portfolio explains the hypothetical 24h movement and does not round a tiny move to zero", async () => {
  const app = await dashboard();
  const props = {
    coins: [], amounts: { bitcoin: 0.5 }, drafts: {}, editable: true, inputMessage: "",
    updateAmount() {}, commitAmount() {}, loading: false, currency: "USD",
    portfolio: { positions: [{ id: "bitcoin", amount: 0.5, coin: null, value: 30_000 }], total: 30_000, dailyChange: 2.5 },
  };
  let rendered = text(app.renderPortfolioPanel(props));
  assert.match(rendered, /assumes the same quantities throughout; it does not use transaction history/i);
  assert.match(rendered, /24h price movement on current quantities: \$2\.50 up/);
  rendered = text(app.renderPortfolioPanel({ ...props, portfolio: { ...props.portfolio, dailyChange: -0.0000001 } }));
  assert.match(rendered, /Less than \$0\.000001 down/);
  rendered = text(app.renderPortfolioPanel({ ...props, portfolio: { ...props.portfolio, dailyChange: 0 } }));
  assert.match(rendered, /No net 24h price movement on current quantities/);
  rendered = text(app.renderPortfolioPanel({ ...props, portfolio: { ...props.portfolio, dailyChange: null } }));
  assert.match(rendered, /24h price movement unavailable/);
  rendered = text(app.renderPortfolioPanel({ ...props, portfolio: { ...props.portfolio, total: 1e-9 } }));
  assert.match(rendered, /Total value · USDLess than \$0\.000001/);
});
