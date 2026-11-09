import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const cjs = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected candle test module: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}
const data = await load("../src/lib/web-candle-data.ts");
const math = await load("../src/lib/candle-series.ts");
const indicators = await load("../src/lib/price-indicators.ts", { "./candle-series": math });
const format = await load("../src/lib/market-format.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
function nodes(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}
function candles(count = 30) {
  return Array.from({ length: count }, (_, index) => ({ timestamp: Date.UTC(2026, 9, 1) + index * 4 * 60 * 60_000, open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index }));
}
function history(count = 30, overrides = {}) {
  return { coinId: "bitcoin", currency: "USD", days: 7, source: "CoinGecko", retrievedAt: "2026-11-06T12:00:00.000Z", candleIntervalMinutes: 240, timestampKind: "close", candles: candles(count), ...overrides };
}
function intraday(interval = "3m", days = 1, overrides = {}) {
  const minutes = Number(interval.slice(0, -1));
  const start = Date.UTC(2026, 10, 5, 12);
  const end = start + days * 86_400_000;
  const count = days * 1440 / minutes;
  return { coinId: "bitcoin", source: "Binance Spot", quote: "USDT", interval, intervalMinutes: minutes, days, timestampKind: "close", observedAt: new Date(end + 1000).toISOString(), retrievedAt: new Date(end + 1200).toISOString(), coveredStart: start, coveredEnd: end, count,
    candles: Array.from({ length: count }, (_, i) => ({ timestamp: start + (i + 1) * minutes * 60_000, open: 100 + i, high: 103 + i, low: 99 + i, close: 102 + i })), ...overrides };
}
const parsedIntraday = (interval = "3m", days = 1) => data.parseIntradayCandleHistory(intraday(interval, days), { coinId: "bitcoin", interval, days });
const identity = { coinId: "bitcoin", currency: "USD", days: 7 };

test("candle validation preserves full OHLC and enforces selected identity, ordering and interval", () => {
  assert.deepEqual(data.parseCandleHistory(history(), identity), history());
  assert.deepEqual(data.parseCandleHistory(history(0), identity).candles, []);
  for (const changed of [{ currency: "GBP" }, { coinId: "ethereum" }, { days: 1 }, { source: "fixture" }, { timestampKind: "open" }, { candleIntervalMinutes: 30 }, { retrievedAt: "invalid" }]) {
    assert.throws(() => data.parseCandleHistory(history(3, changed), identity));
  }
  for (const rows of [candles(3).reverse(), [candles(1)[0], candles(1)[0]], [{ ...candles(1)[0], high: 100 }], [{ ...candles(1)[0], low: 103 }], [{ ...candles(1)[0], close: Number.NaN }], [{ ...candles(1)[0], open: -1 }], [{ ...candles(1)[0], timestamp: 0 }], candles(1001)]) {
    assert.throws(() => data.parseCandleHistory(history(3, { candles: rows }), identity));
  }
});

test("candle windows remain integer, retain selection and reset the complete observed series", () => {
  let viewport = data.moveCandleWindow(17, null, "in", 16);
  assert.deepEqual(viewport, { start: 8, end: 17 });
  viewport = data.moveCandleWindow(17, viewport, "earlier", 16);
  assert.deepEqual(viewport, { start: 4, end: 13 });
  assert.deepEqual(data.moveCandleWindow(17, viewport, "later", 12), { start: 8, end: 17 });
  for (let i = 0; i < 8; i++) viewport = data.moveCandleWindow(17, viewport, "in", 12);
  assert.equal(viewport.end - viewport.start, 3);
  assert.ok(viewport.start <= 12 && viewport.end > 12);
  assert.deepEqual(data.moveCandleWindow(17, viewport, "reset", 12), { start: 0, end: 17 });
  assert.deepEqual(data.normalizedCandleWindow(2, { start: 10, end: 11 }), { start: 0, end: 2 });
});

test("price domain includes candle wicks, active averages and the USD stablecoin reference", () => {
  const result = data.candlePriceDomain(candles(3), false, [200, null]);
  assert.ok(result.low < 99 && result.high > 200);
  const stable = data.candlePriceDomain([{ timestamp: 1, open: 1, high: 1.0001, low: .9999, close: 1 }], true);
  assert.ok(stable.low <= .98 && stable.high >= 1.02);
  const flat = data.candlePriceDomain([{ timestamp: 1, open: 0, high: 0, low: 0, close: 0 }], false);
  assert.equal(flat.low, 0);
  assert.ok(flat.high > 0);
});

test("browser candle reads reject declared/chunked oversized or malformed bodies and cancel them", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await data.readCandleResponse(new Response(JSON.stringify(history(1))), signal), history(1));
  let declaredCanceled = false;
  const declared = new Response(new ReadableStream({ cancel() { declaredCanceled = true; } }), { headers: { "content-length": String(data.MAX_CANDLE_RESPONSE_BYTES + 1) } });
  await assert.rejects(data.readCandleResponse(declared, signal));
  assert.equal(declaredCanceled, true);
  let streamedCanceled = false;
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(data.MAX_CANDLE_RESPONSE_BYTES + 1)); }, cancel() { streamedCanceled = true; } }));
  await assert.rejects(data.readCandleResponse(streamed, signal));
  assert.equal(streamedCanceled, true);
  await assert.rejects(data.readCandleResponse(new Response(new Uint8Array([0xff, 0xfe])), signal));
  await assert.rejects(data.readCandleResponse(new Response("{invalid"), signal));
  await assert.rejects(data.readCandleResponse(new Response("private provider error", { status: 503 }), signal));
});

test("aborting a stalled body settles its read without waiting for another chunk", async () => {
  let canceled = false;
  const controller = new AbortController();
  const request = data.readCandleResponse(new Response(new ReadableStream({ cancel() { canceled = true; } })), controller.signal);
  controller.abort();
  await assert.rejects(request);
  assert.equal(canceled, true);
});

async function harness(kind, initialProps) {
  const slots = [];
  const pending = [];
  let cursor = 0;
  let props = initialProps;
  const hooks = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === "function" ? initial() : initial; return [slots[id], (next) => { slots[id] = typeof next === "function" ? next(slots[id]) : next; }]; },
    useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id]; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, dependencies) {
      const id = cursor++;
      const previous = slots[id];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) pending.push(() => { previous?.cleanup?.(); slots[id] = { dependencies, cleanup: fn() }; });
    },
  };
  const indicatorModule = await load("../src/app/components/price-chart-indicators.tsx", {
    react: hooks, "react/jsx-runtime": jsx,
    "ag-charts-react": { AgCharts: "AgCharts" },
    "ag-charts-community": { CrossLinesModule: "cross-lines", LineSeriesModule: "line", NumberAxisModule: "number", TimeAxisModule: "time" },
    "@/lib/price-indicators": indicators, "@/lib/market-format": format,
    "./candle-history-panel.module.css": { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) },
  });
  const requestModule = await load("../src/app/components/use-candle-history.ts", { react: hooks, "@/lib/web-candle-data": data });
  const wheel = await load("../src/lib/chart-wheel.ts");
  const wheelModule = await load("../src/app/components/use-plot-wheel-zoom.ts", { react: hooks, "@/lib/chart-wheel": wheel });
  const componentModule = await load("../src/app/components/candle-history-panel.tsx", {
    react: hooks, "react/jsx-runtime": jsx, "@/lib/candle-series": math, "@/lib/market-format": format, "@/lib/web-candle-data": data,
    "@/lib/price-indicators": indicators, "./price-chart-indicators": indicatorModule, "./use-candle-history": requestModule,
    "./use-plot-wheel-zoom": wheelModule,
    "./candle-history-panel.module.css": { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) },
  });
  const feedModule = await load("../src/app/components/candle-feed-controls.tsx", { "react/jsx-runtime": jsx, "./candle-feed-controls.module.css": { __esModule: true, default: {} } });
  const Component = kind === "plot" ? componentModule.CandlePlot : kind === "hook" ? requestModule.useCandleHistory : kind === "controls" ? indicatorModule.PriceIndicatorControls : kind === "feed" ? feedModule.default : kind === "status" ? indicatorModule.LineIndicatorStatus : kind === "rsi" ? indicatorModule.PriceLineRsi : componentModule.default;
  function expandControls(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(expandControls);
    if (value.type === indicatorModule.PriceIndicatorControls) return expandControls(value.type(value.props));
    return value.props ? { ...value, props: { ...value.props, children: expandControls(value.props.children) } } : value;
  }
  function render(nextProps, mountRefs) { if (nextProps) props = nextProps; cursor = 0; const tree = expandControls(Component(props)); mountRefs?.(tree); while (pending.length) pending.shift()(); return tree; }
  return { render, close() { for (const value of slots) value?.cleanup?.(); } };
}
function control(tree, label) {
  const result = nodes(tree).find((node) => node.props?.["aria-label"] === label);
  assert.ok(result, `Missing ${label}`);
  return result;
}

test("plot scrubs actual candles and supports complete-candle zoom, pan and keyboard inspection", async () => {
  const app = await harness("plot", { history: history() });
  let tree = app.render();
  let plot = control(tree, "Inspect historical candles");
  assert.equal(plot.props["aria-valuenow"], 30);
  assert.match(plot.props["aria-valuetext"], /close time .* UTC\. Open \$129.00, high \$132.00, low \$128.00, close \$131.00/);
  plot.props.onKeyDown({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(control(app.render(), "Inspect historical candles").props["aria-valuenow"], 29);
  plot = control(app.render(), "Inspect historical candles");
  plot.props.onKeyDown({ key: "Home", preventDefault() {} });
  assert.equal(control(app.render(), "Inspect historical candles").props["aria-valuenow"], 1);
  control(app.render(), "Zoom into candles").props.onClick();
  assert.match(text(app.render()), /Showing 1–15 of 30/);
  plot = control(app.render(), "Inspect historical candles");
  const target = { getBoundingClientRect: () => ({ left: 100, width: 800 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  plot.props.onPointerMove({ pointerType: "mouse", currentTarget: target, clientX: 899 });
  assert.equal(control(app.render(), "Inspect historical candles").props["aria-valuenow"], 15);
  control(app.render(), "Show later candles").props.onClick();
  assert.match(text(app.render()), /Showing 8–22 of 30/);
  const reset = nodes(app.render()).find((node) => node.type === "button" && text(node) === "Reset");
  reset.props.onClick();
  assert.match(text(app.render()), /Showing 1–30 of 30/);
  app.close();
});

test("indicators start off, use full-history warmup and survive zoom without reseeding", async () => {
  const app = await harness("plot", { history: history() });
  let tree = app.render();
  const toggles = nodes(tree).filter((node) => node.type === "input");
  assert.equal(toggles.length, 3);
  assert.ok(toggles.every((node) => node.props.checked === false));
  toggles[0].props.onChange({ currentTarget: { checked: true } });
  toggles[2].props.onChange({ currentTarget: { checked: true } });
  tree = app.render();
  assert.match(text(tree), /SMA 20\$121.50/);
  assert.match(text(tree), /RSI 14100.00/);
  control(tree, "Zoom into candles").props.onClick();
  assert.match(text(app.render()), /SMA 20\$121.50/);
  const plot = control(app.render(), "Inspect historical candles");
  plot.props.onKeyDown({ key: "Home", preventDefault() {} });
  assert.match(text(app.render()), /SMA 20Warm-up/);
  assert.match(text(app.render()), /RSI 14Warm-up/);
  app.close();
  const short = await harness("plot", { history: history(10) });
  assert.ok(nodes(short.render()).filter((node) => node.type === "input").every((node) => node.props.disabled === true));
  short.close();
});

test("indicator lines break across missing intervals without resetting full-history values", async () => {
  const interval = 4 * 60 * 60_000;
  const rows = candles(30).map((candle, index) => index >= 25 ? { ...candle, timestamp: candle.timestamp + 2 * interval } : candle);
  const app = await harness("plot", { history: history(30, { candles: rows }) });
  let tree = app.render();
  for (const toggle of nodes(tree).filter((node) => node.type === "input")) toggle.props.onChange({ currentTarget: { checked: true } });
  tree = app.render();
  for (const className of ["smaLine", "emaLine", "rsiLine"]) {
    const line = nodes(tree).find((node) => node.type === "path" && node.props.className === className);
    assert.ok(line, `${className} is present`);
    assert.equal((line.props.d.match(/M/g) ?? []).length, 2, `${className} starts a new segment after the missing interval`);
  }
  assert.match(text(tree), /SMA 20\$121.50/);
  assert.match(text(tree), /EMA 20\$121.50/);
  assert.match(text(tree), /RSI 14100.00/);
  assert.match(text(tree), /Missing intervals are not filled/);
  app.close();
});

test("touching vertically keeps page scroll available; a horizontal drag selects complete candle slots", async () => {
  const app = await harness("plot", { history: history() });
  let captured = 0;
  const target = { getBoundingClientRect: () => ({ left: 0, width: 800 }), setPointerCapture() { captured++; }, hasPointerCapture: () => false };
  let plot = control(app.render(), "Inspect historical candles");
  plot.props.onPointerDown({ isPrimary: true, pointerType: "touch", pointerId: 1, clientX: 20, clientY: 100, currentTarget: target });
  plot.props.onPointerMove({ pointerType: "touch", pointerId: 1, clientX: 22, clientY: 150, currentTarget: target });
  assert.equal(captured, 0);
  assert.equal(control(app.render(), "Inspect historical candles").props["aria-valuenow"], 1);
  plot = control(app.render(), "Inspect historical candles");
  plot.props.onPointerDown({ isPrimary: true, pointerType: "touch", pointerId: 2, clientX: 20, clientY: 100, currentTarget: target });
  plot.props.onPointerMove({ pointerType: "touch", pointerId: 2, clientX: 780, clientY: 102, currentTarget: target, cancelable: true, preventDefault() {} });
  assert.equal(captured, 1);
  assert.equal(control(app.render(), "Inspect historical candles").props["aria-valuenow"], 30);
  app.close();
});

test("a changed currency aborts the older request and ignores its late response", async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  const timers = new Map();
  let timer = 0;
  globalThis.window = { setTimeout(fn) { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.fetch = (url, options) => new Promise((resolve) => calls.push({ url, options, resolve }));
  const app = await harness("request", identity);
  try {
    app.render();
    assert.match(calls[0].url, /days=7&currency=USD/);
    assert.equal(calls[0].options.cache, "no-store");
    app.render({ ...identity, currency: "GBP" });
    assert.equal(calls[0].options.signal.aborted, true);
    calls[1].resolve(new Response(JSON.stringify(history(30, { currency: "GBP" }))));
    await tick();
    assert.equal(app.render().props.history.currency, "GBP");
    calls[0].resolve(new Response(JSON.stringify(history())));
    await tick();
    assert.equal(app.render().props.history.currency, "GBP");
  } finally {
    app.close(); await tick();
    globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  }
});

test("line overlays retain full-history values and use candle timestamps inside a finer time window", () => {
  const source = history();
  const values = indicators.calculatePriceIndicators(source);
  assert.ok(values.sma.slice(0, 19).every((value) => value === null));
  assert.equal(values.sma[29], 121.5);
  assert.equal(values.ema[29], 121.5);
  const interval = 4 * 60 * 60_000;
  const window = { start: source.candles[25].timestamp + interval / 4, end: source.candles[28].timestamp - interval / 4 };
  const result = indicators.lineIndicatorOverlays(source, values, { sma: true, ema: true, rsi: true }, window);
  assert.deepEqual(result.map((item) => item.id), ["sma", "ema"]);
  const actualTimes = new Set(source.candles.map((candle) => candle.timestamp));
  for (const overlay of result) {
    const points = overlay.segments.flat();
    assert.deepEqual(points.map((point) => point.timestamp), [25, 26, 27, 28].map((index) => source.candles[index].timestamp));
    assert.ok(points.every((point) => actualTimes.has(point.timestamp)));
    assert.equal(points.find((point) => point.timestamp === source.candles[27].timestamp).value, 119.5);
  }
  assert.equal(indicators.lastVisibleCandleIndex(source, window), 27);
  assert.deepEqual(indicators.indicatorSegments(source, values.sma, { start: source.candles[0].timestamp, end: source.candles[10].timestamp }), []);
  assert.deepEqual(indicators.indicatorSegments(source, values.sma, { start: source.candles[29].timestamp + interval, end: source.candles[29].timestamp + 2 * interval }), []);
});

test("all line indicator paths split at absent intervals and never invent observations", () => {
  const interval = 4 * 60 * 60_000;
  const rows = candles(30).map((candle, index) => index >= 25 ? { ...candle, timestamp: candle.timestamp + 2 * interval } : candle);
  const source = history(30, { candles: rows });
  const values = indicators.calculatePriceIndicators(source);
  const window = { start: rows[0].timestamp, end: rows[29].timestamp };
  for (const id of ["sma", "ema", "rsi"]) {
    const segments = indicators.indicatorSegments(source, values[id], window);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].at(-1).timestamp, rows[24].timestamp);
    assert.equal(segments[1][0].timestamp, rows[25].timestamp);
    assert.ok(segments.flat().every((point) => rows.some((row) => row.timestamp === point.timestamp)));
  }
  assert.equal(values.sma[29], 121.5);
  assert.deepEqual(indicators.lineIndicatorOverlays(source, values, { ...indicators.EMPTY_PRICE_INDICATORS }, window), []);
});

test("ordinary lines, other metrics, approximate history and unhydrated currency make no OHLC demand", () => {
  const options = { currencyReady: true, metric: "price", style: "line", indicators: { ...indicators.EMPTY_PRICE_INDICATORS }, timestampedLine: true };
  assert.equal(indicators.needsCandleHistory(options), false);
  assert.equal(indicators.needsCandleHistory({ ...options, indicators: { sma: true, ema: false, rsi: false } }), true);
  assert.equal(indicators.needsCandleHistory({ ...options, indicators: { sma: true, ema: true, rsi: true }, timestampedLine: false }), false);
  assert.equal(indicators.needsCandleHistory({ ...options, style: "candles", timestampedLine: false }), true);
  for (const metric of ["marketCap", "volume"]) assert.equal(indicators.needsCandleHistory({ ...options, metric, style: "candles", indicators: { sma: true, ema: true, rsi: true } }), false);
  assert.equal(indicators.needsCandleHistory({ ...options, style: "candles", currencyReady: false }), false);
});

test("shared indicator choices survive Line/Candles remounts and can be turned off in short histories", async () => {
  let selected = { ...indicators.EMPTY_PRICE_INDICATORS };
  const onChange = (update) => { selected = typeof update === "function" ? update(selected) : update; };
  const controls = await harness("controls", { indicators: selected, onChange });
  const toggles = nodes(controls.render()).filter((node) => node.type === "input");
  assert.ok(toggles.every((node) => node.props.checked === false && node.props.disabled === false));
  for (const toggle of toggles) toggle.props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(selected, { sma: true, ema: true, rsi: true });
  const plot = await harness("plot", { history: history(), indicators: selected, onIndicatorsChange: onChange, showIndicatorControls: false });
  assert.match(text(plot.render()), /SMA 20\$121.50/);
  assert.match(text(plot.render()), /EMA 20\$121.50/);
  assert.match(text(plot.render()), /RSI 14100.00/);
  assert.equal(nodes(plot.render()).filter((node) => node.type === "input").length, 0);
  plot.close();
  const returned = controls.render({ indicators: selected, onChange, history: history(10) });
  assert.ok(nodes(returned).filter((node) => node.type === "input").every((node) => node.props.checked === true && node.props.disabled === false));
  for (const toggle of nodes(returned).filter((node) => node.type === "input")) toggle.props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(selected, indicators.EMPTY_PRICE_INDICATORS);
  controls.close();
});

test("one completed OHLC request is reused across styles and only Retry or Refresh requests it again", async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
  globalThis.fetch = (url, options) => new Promise((resolve) => calls.push({ url, options, resolve }));
  const app = await harness("hook", { ...identity, enabled: false });
  try {
    assert.equal(app.render().status, "idle");
    assert.equal(calls.length, 0);
    assert.equal(app.render({ ...identity, enabled: true }).status, "loading");
    assert.equal(calls.length, 1);
    calls[0].resolve(new Response(JSON.stringify(history())));
    await tick();
    assert.equal(app.render().status, "ready");
    assert.equal(app.render({ ...identity, enabled: true }).status, "ready");
    assert.equal(calls.length, 1);
    assert.equal(app.render({ ...identity, enabled: false }).status, "idle");
    assert.equal(app.render({ ...identity, enabled: true }).status, "ready");
    assert.equal(calls.length, 1);
    assert.equal(app.render({ ...identity, enabled: true, refresh: 1 }).status, "loading");
    assert.equal(calls.length, 2);
    calls[1].resolve(new Response("unavailable", { status: 503 }));
    await tick();
    assert.equal(app.render().status, "error");
    assert.equal(calls.length, 2);
    app.render().retry();
    assert.equal(app.render().status, "loading");
    assert.equal(calls.length, 3);
  } finally {
    app.close(); await tick();
    globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  }
});

test("the shared hook aborts changed range/asset identities and rejects late prior data", async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
  globalThis.fetch = (url, options) => new Promise((resolve) => calls.push({ url, options, resolve }));
  const app = await harness("hook", { ...identity, enabled: true });
  try {
    app.render();
    app.render({ ...identity, coinId: "ethereum", days: 30, enabled: true });
    assert.equal(calls[0].options.signal.aborted, true);
    assert.match(calls[1].url, /candles\/ethereum\?days=30/);
    calls[1].resolve(new Response(JSON.stringify(history(30, { coinId: "ethereum", days: 30 }))));
    await tick();
    assert.equal(app.render().history.coinId, "ethereum");
    calls[0].resolve(new Response(JSON.stringify(history())));
    await tick();
    assert.equal(app.render().history.coinId, "ethereum");
    assert.equal(app.render().history.days, 30);
  } finally {
    app.close(); await tick();
    globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  }
});

test("indicator errors and approximate price samples explain the limitation without a replacement price line", async () => {
  let retries = 0; let opened = 0;
  const props = { request: { status: "error", retry() { retries++; } }, indicators: { sma: true, ema: true, rsi: true }, values: null, window: { start: 1, end: 2 }, approximateLine: false, lineAvailable: true, onCandles() { opened++; } };
  const app = await harness("status", props);
  let tree = app.render();
  assert.match(text(tree), /ordinary price line is unchanged/);
  nodes(tree).find((node) => node.type === "button").props.onClick();
  assert.equal(retries, 1);
  tree = app.render({ ...props, approximateLine: true });
  assert.match(text(tree), /approximate times, so overlays are paused/);
  assert.match(text(tree), /Your choices are kept/);
  assert.equal(nodes(tree).filter((node) => node.type === "AgCharts").length, 0);
  nodes(tree).find((node) => node.type === "button").props.onClick();
  assert.equal(opened, 1);
  app.close();
});

test("RSI uses the same explicit price time window and fixed gutters with a separate 0–100 scale", async () => {
  const previous = globalThis.window;
  globalThis.window = { requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} };
  const source = history();
  const values = indicators.calculatePriceIndicators(source);
  const window = { start: source.candles[23].timestamp, end: source.candles[29].timestamp };
  const segments = indicators.indicatorSegments(source, values.rsi, window);
  const app = await harness("rsi", { segments, window, days: 7 });
  try {
    const chart = nodes(app.render()).find((node) => node.type === "AgCharts");
    assert.ok(chart);
    const { options } = chart.props;
    assert.equal(options.axes.x.min.getTime(), window.start);
    assert.equal(options.axes.x.max.getTime(), window.end);
    assert.equal(options.axes.x.nice, false);
    assert.equal(options.axes.x.thickness, 32);
    assert.equal(options.axes.x.label.formatter({ value: Date.UTC(2026, 10, 6, 12, 5) }), "06 Nov");
    assert.equal(options.axes.y.thickness, 92);
    assert.equal(options.axes.y.min, 0);
    assert.equal(options.axes.y.max, 100);
    assert.deepEqual(options.axes.y.crossLines.map((line) => line.value), [30, 70]);
    assert.ok(options.series.every((series) => series.connectMissingData === false));
    const datum = options.series[0].data.at(-1);
    const tooltip = options.series[0].tooltip.renderer({ datum });
    assert.equal(tooltip.heading, "2026-10-05 20:00:00 UTC");
    assert.equal(tooltip.data[0].value, "100.00");
  } finally {
    app.close();
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

test("a provided shared request makes no duplicate call and cannot display a foreign asset", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Shared request must not refetch"); };
  const app = await harness("request", { ...identity, request: { status: "ready", history: history(), retry() {} }, indicators: { sma: true, ema: true, rsi: false }, showIndicatorControls: false });
  try {
    assert.equal(app.render().props.history.coinId, "bitcoin");
    assert.equal(app.render().props.indicators.sma, true);
    assert.equal(calls, 0);
    const tree = app.render({ ...identity, coinId: "ethereum", request: { status: "ready", history: history(), retry() {} } });
    assert.match(text(tree), /Loading candle history/);
    assert.equal(tree.props.history, undefined);
    assert.equal(calls, 0);
  } finally { app.close(); globalThis.fetch = previous; }
});

test("candle wheel binding uses only the inner price SVG and selects the candle beneath the pointer", async () => {
  let listener;
  const element = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 250 }),
    addEventListener(type, fn, options) { assert.equal(type, "wheel"); assert.equal(options.passive, false); listener = fn; },
    removeEventListener(type, fn, capture) { assert.equal(type, "wheel"); assert.equal(fn, listener); assert.equal(capture, true); listener = null; },
  };
  const app = await harness("plot", { history: history() });
  try {
    app.render(undefined, (tree) => { nodes(tree).find((node) => node.type === "svg" && node.props.className === "priceSvg").props.ref.current = element; });
    assert.equal(typeof listener, "function");
    let prevented = false;
    const event = { clientX: 206, clientY: 100, deltaY: -48, deltaX: 0, deltaMode: 0, timeStamp: 100, cancelable: true, target: { closest: () => null }, preventDefault() { prevented = true; } };
    listener(event);
    assert.equal(prevented, true);
    let tree = app.render();
    assert.match(text(tree), /Showing 2–25 of 30/);
    assert.equal(control(tree, "Inspect historical candles").props["aria-valuenow"], 8);
    prevented = false;
    listener({ ...event, clientY: 10, timeStamp: 120 });
    assert.equal(prevented, false);
    tree = app.render();
    assert.match(text(tree), /Showing 2–25 of 30/);
  } finally { app.close(); assert.equal(listener, null); }
});

test("a remounted candle plot restores a public zoom snapshot from actual candle timestamps", async () => {
  let snapshot = null;
  const first = await harness("plot", { history: history(), onViewSnapshotChange: (next) => { snapshot = next; } });
  control(first.render(), "Zoom into candles").props.onClick();
  control(first.render(), "Show earlier candles").props.onClick();
  const expected = text(first.render()).match(/Showing \d+–\d+ of 30/)[0];
  first.close();
  assert.ok(snapshot);
  const second = await harness("plot", { history: history(), viewSnapshot: snapshot });
  assert.match(text(second.render()), new RegExp(expected));
  second.close();
  const foreign = await harness("plot", { history: history(30, { currency: "GBP" }), viewSnapshot: snapshot });
  assert.match(text(foreign.render()), /Showing 1–30 of 30/);
  foreign.close();
});

test("minute history preserves native USDT and exact complete supported windows", () => {
  for (const [interval, days, count] of [["3m", 1, 480], ["5m", 1, 288], ["15m", 1, 96], ["15m", 7, 672]]) {
    const raw = intraday(interval, days);
    const value = data.parseIntradayCandleHistory(raw, { coinId: "bitcoin", interval, days });
    assert.equal(value.source, "Binance Spot");
    assert.equal(value.currency, "USDT");
    assert.equal(value.quote, "USDT");
    assert.equal(value.candleIntervalMinutes, Number(interval.slice(0, -1)));
    assert.equal(value.count, count);
    assert.deepEqual(value.candles, raw.candles);
    assert.equal(value.candles.at(-1).timestamp, value.coveredEnd);
    assert.equal(value.coveredEnd - value.coveredStart, days * 86_400_000);
    assert.equal(indicators.candleIntervalLabel(value.candleIntervalMinutes), `${Number(interval.slice(0, -1))}-minute candles`);
  }
  assert.equal(data.isSupportedIntradaySelection("bitcoin", { interval: "3m", days: 7 }), false);
  assert.equal(data.isSupportedIntradaySelection("paypal-usd", { interval: "15m", days: 1 }), false);
});

test("minute validation rejects quote swaps, wrong source/window, unclosed slots and incomplete coverage", () => {
  const expected = { coinId: "bitcoin", interval: "3m", days: 1 };
  const raw = intraday();
  for (const changed of [
    { quote: "USD" }, { quote: "GBP" }, { source: "CoinGecko" }, { coinId: "ethereum" }, { interval: "5m" }, { intervalMinutes: "3" }, { days: 7 }, { timestampKind: "open" },
    { observedAt: "invalid" }, { retrievedAt: "invalid" }, { observedAt: new Date(raw.coveredEnd).toISOString() },
    { coveredStart: raw.coveredStart + 1 }, { coveredEnd: raw.coveredEnd + 180_000 }, { count: 479 },
    { candles: raw.candles.slice(1) }, { candles: [...raw.candles, raw.candles.at(-1)] },
    { candles: raw.candles.map((candle, i) => i === 1 ? raw.candles[0] : candle) },
    { candles: raw.candles.map((candle, i) => i === 1 ? { ...candle, timestamp: candle.timestamp + 1 } : candle) },
    { candles: raw.candles.map((candle, i) => i === 1 ? { ...candle, high: 1 } : candle) },
    { candles: raw.candles.map((candle, i) => i === 1 ? { ...candle, close: Infinity } : candle) },
  ]) assert.throws(() => data.parseIntradayCandleHistory({ ...raw, ...changed }, expected));
  assert.throws(() => data.parseIntradayCandleHistory(raw, { ...expected, coinId: "paypal-usd" }));
  assert.throws(() => data.parseIntradayCandleHistory(intraday("3m", 7), { ...expected, days: 7 }));
  assert.throws(() => data.parseCandleHistory(raw, identity));
});

test("candle viewport identity includes source, quote, interval and window", () => {
  const first = parsedIntraday();
  const snapshot = data.captureCandleView(first, { start: 20, end: 80 }, 50);
  assert.match(snapshot.identity, /^Binance Spot:bitcoin:USDT:1:3m$/);
  assert.deepEqual(data.restoreCandleView(first, snapshot), { window: { start: 20, end: 80 }, selected: 50 });
  for (const foreign of [parsedIntraday("5m"), parsedIntraday("15m", 7), { ...first, coinId: "ethereum" }, history()]) {
    assert.deepEqual(data.restoreCandleView(foreign, snapshot), { window: null, selected: null });
  }
  const minuteSelection = { ...identity, intraday: { interval: "3m", days: 1 } };
  assert.equal(data.candleSelectionIdentity(minuteSelection), snapshot.identity);
  assert.equal(data.candleSelectionIdentity({ ...minuteSelection, currency: "GBP", days: 365 }), snapshot.identity, "fiat display and Auto lookback do not relabel a native quote");
  assert.notEqual(data.candleSelectionIdentity(identity), snapshot.identity);
});

test("minute controls expose explicit windows and retain an unsupported choice without truncating", async () => {
  const changes = [];
  const props = { coinId: "bitcoin", interval: "auto", days: 1, onIntervalChange: (value) => changes.push(["interval", value]), onDaysChange: (value) => changes.push(["days", value]) };
  const app = await harness("feed", props);
  try {
    let tree = app.render();
    assert.equal(nodes(tree).filter((node) => node.type === "button").length, 4);
    assert.ok(nodes(tree).some((node) => node.type === "button" && text(node) === "Auto · CoinGecko" && node.props["aria-pressed"]));
    nodes(tree).find((node) => node.type === "button" && text(node) === "3m").props.onClick();
    assert.deepEqual(changes, [["interval", "3m"]]);
    tree = app.render({ ...props, interval: "15m", days: 7 });
    assert.equal(nodes(tree).find((node) => node.type === "button" && text(node).startsWith("7 days")).props.disabled, false);
    nodes(tree).find((node) => node.type === "button" && text(node) === "5m").props.onClick();
    assert.deepEqual(changes, [["interval", "3m"], ["interval", "5m"]], "interval activation never silently changes 7 days to 1 day");
    tree = app.render({ ...props, interval: "5m", days: 7 });
    assert.equal(nodes(tree).find((node) => node.type === "button" && text(node).startsWith("7 days")).props.disabled, true);
    nodes(tree).find((node) => node.type === "button" && text(node) === "1 day").props.onClick();
    assert.deepEqual(changes.at(-1), ["days", 1]);
    tree = app.render({ ...props, coinId: "paypal-usd" });
    assert.ok(nodes(tree).filter((node) => node.type === "button" && text(node) !== "Auto · CoinGecko").every((node) => node.props.disabled));
    assert.match(text(tree), /no PYUSD pair/);
  } finally { app.close(); }
});

test("USDT inspector, indicators and wheel use native prices and real minute slots", async () => {
  const source = parsedIntraday();
  let snapshot;
  let listener;
  const element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 250 }), addEventListener(_name, fn) { listener = fn; }, removeEventListener() { listener = null; } };
  const app = await harness("plot", { history: source, indicators: { sma: true, ema: true, rsi: true }, onViewSnapshotChange: (next) => { snapshot = next; } });
  try {
    let tree = app.render(undefined, (tree) => { nodes(tree).find((node) => node.type === "svg" && node.props.className === "priceSvg").props.ref.current = element; });
    const allText = text(tree);
    assert.match(allText, /581.00 USDT/);
    assert.match(allText, /SMA 20571.50 USDT/);
    assert.match(allText, /EMA 20571.50 USDT/);
    assert.match(allText, /RSI 14100.00/);
    assert.match(allText, /3-minute candles/);
    assert.match(allText, /Binance Spot · USDT quote · 3m trade candles/);
    assert.match(allText, /exclusive close time/);
    assert.doesNotMatch(allText, /[$£€]/);
    assert.match(control(tree, "Inspect historical candles").props["aria-valuetext"], /Open 579.00 USDT.*close 581.00 USDT/);
    let prevented = false;
    listener({ clientX: 206, clientY: 100, deltaY: -48, deltaX: 0, deltaMode: 0, timeStamp: 100, cancelable: true, target: { closest: () => null }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    tree = app.render();
    assert.equal(control(tree, "Inspect historical candles").props["aria-valuenow"], 121);
    assert.equal(snapshot.identity, data.candleHistoryIdentity(source));
    assert.equal(snapshot.selectedTimestamp, source.candles[120].timestamp);
    const plot = control(tree, "Inspect historical candles");
    plot.props.onKeyDown({ key: "End", preventDefault() {} });
    assert.match(text(app.render()), /SMA 20571.50 USDT/);
  } finally { app.close(); }
  assert.equal(format.formatUsdtPrice(.00001234), "0.00001234 USDT");
  assert.equal(format.formatUsdtPrice(null), "— USDT");
});

test("switching Auto, minute intervals and windows cancels old work and never reuses a foreign quote", async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
  globalThis.fetch = (url, options) => new Promise((resolve) => calls.push({ url, options, resolve }));
  const app = await harness("hook", { ...identity, enabled: true });
  try {
    app.render();
    const firstMinute = { ...identity, currency: "GBP", days: 365, enabled: true, intraday: { interval: "3m", days: 1 } };
    assert.equal(app.render(firstMinute).status, "loading");
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].url, "/api/market/intraday/bitcoin?interval=3m&days=1");
    assert.equal(calls[1].options.redirect, "error");
    assert.equal(calls[1].options.mode, "same-origin");
    assert.equal(app.render({ ...firstMinute, currency: "EUR", days: 30 }).status, "loading");
    assert.equal(calls.length, 2, "fiat preference or Auto range changes do not restart an in-flight USDT request");
    assert.equal(calls[1].options.signal.aborted, false);
    const secondMinute = { ...firstMinute, intraday: { interval: "15m", days: 7 } };
    assert.equal(app.render(secondMinute).status, "loading");
    assert.equal(calls[1].options.signal.aborted, true);
    assert.equal(calls[2].url, "/api/market/intraday/bitcoin?interval=15m&days=7");
    calls[2].resolve(new Response(JSON.stringify(intraday("15m", 7)))); await tick();
    assert.equal(app.render().history.currency, "USDT");
    assert.equal(app.render().history.days, 7);
    calls[0].resolve(new Response(JSON.stringify(history())));
    calls[1].resolve(new Response(JSON.stringify(intraday()))); await tick();
    assert.equal(app.render().history.interval, "15m");
    assert.equal(app.render({ ...identity, enabled: true }).status, "loading");
    assert.equal(calls[3].url, "/api/market/candles/bitcoin?days=7&currency=USD");
    calls[3].resolve(new Response(JSON.stringify(history()))); await tick();
    assert.equal(app.render().history.source, "CoinGecko");
    assert.equal(app.render().history.currency, "USD");
  } finally {
    app.close(); await tick(); globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  }
});

test("unsupported minute windows/PYUSD and provider errors make no synthetic or Auto fallback", async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
  globalThis.fetch = (url, options) => new Promise((resolve) => calls.push({ url, options, resolve }));
  const options = { ...identity, enabled: true, intraday: { interval: "3m", days: 7 } };
  const app = await harness("hook", options);
  try {
    let result = app.render();
    assert.equal(result.status, "error");
    assert.match(result.message, /one-day window/);
    assert.equal(calls.length, 0);
    result = app.render({ ...options, coinId: "paypal-usd", intraday: { interval: "15m", days: 1 } });
    assert.match(result.message, /unavailable for PayPal USD/);
    assert.equal(calls.length, 0);
    assert.equal(app.render({ ...options, intraday: { interval: "3m", days: 1 } }).status, "loading");
    calls[0].resolve(new Response("private provider message", { status: 503 })); await tick();
    result = app.render();
    assert.equal(result.status, "error");
    assert.match(result.message, /No candles are filled or replaced/);
    assert.doesNotMatch(JSON.stringify(result), /private provider/);
    assert.equal(calls.length, 1);
    assert.equal(result.history, undefined);
    result.retry(); app.render();
    calls[1].resolve(new Response("private provider message", { status: 429 })); await tick();
    assert.match(app.render().message, /rate limited/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url.includes("/intraday/")));
  } finally {
    app.close(); await tick(); globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
  }
});

test("a provided request cannot place Auto data in a minute plot or minute data on the fiat Line", async () => {
  const app = await harness("request", { ...identity, intraday: { interval: "3m", days: 1 }, request: { status: "ready", history: history(), retry() {} } });
  try {
    assert.match(text(app.render()), /Loading candle history/);
    assert.equal(app.render().props.history, undefined);
    const source = parsedIntraday();
    assert.equal(app.render({ ...identity, intraday: { interval: "3m", days: 1 }, request: { status: "ready", history: source, retry() {} } }).props.history.currency, "USDT");
    assert.match(text(app.render({ ...identity, intraday: { interval: "5m", days: 1 }, request: { status: "ready", history: source, retry() {} } })), /Loading candle history/);
    const status = await harness("status", { request: { status: "ready", history: source }, indicators: { sma: true, ema: true, rsi: true }, values: indicators.calculatePriceIndicators(source), window: { start: source.coveredStart, end: source.coveredEnd }, approximateLine: false, lineAvailable: true, onCandles() {} });
    assert.match(text(status.render()), /need matching CoinGecko candle history/);
    status.close();
  } finally { app.close(); }
});
