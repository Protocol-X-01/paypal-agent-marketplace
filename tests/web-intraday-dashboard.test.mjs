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
    "./components/price-chart-indicators": { PriceIndicatorControls: "PriceIndicatorControls", LineIndicatorStatus: "LineIndicatorStatus", PriceLineRsi: "PriceLineRsi" },
    "./components/use-plot-wheel-zoom": {},
  };
  for (const name of ["site-shell", "marketplace", "data-settings", "business-monitoring", "venmo-draft", "chart-zoom-controls", "candle-history-panel", "candle-feed-controls", "portfolio-allocation", "personal-accounting-lite", "account-experience-switch"]) aliases[`./components/${name}`] = component(name);
  aliases["../../packages/ai-insights/ui/InsightPanel"] = component("InsightPanel");
  const dashboardModule = await load("../src/app/market-dashboard.tsx", aliases, "\nexport { MarketDashboardBody as DashboardUnderTest };\n");
  const change = (next) => { controls = typeof next === "function" ? next(controls) : next; };
  return { requests, render() { cursor = 0; return dashboardModule.DashboardUnderTest({ publicChart: controls, onPublicChartChange: change }); }, setControls: (next) => { controls = { ...controls, ...next }; }, get controls() { return controls; } };
}

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
