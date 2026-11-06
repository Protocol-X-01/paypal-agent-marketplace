import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(file, aliases = {}) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const cjs = { exports: {} };
  const require = (name) => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw new Error(`Unexpected continuity test dependency: ${name}`); };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}
const storage = await load("../src/lib/customer-session-storage.ts");
const client = await load("../src/lib/customer-session-client.ts", { "./customer-session-storage": storage });
const publicState = await load("../src/lib/public-chart-state.ts");
const candleData = await load("../src/lib/web-candle-data.ts");
const account = (letter) => ({ authenticated: true, loginAvailable: true, accountType: "personal", dataScope: `v1_${letter.repeat(43)}` });
const response = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
function history() {
  return { coinId: "ethereum", currency: "USD", days: 30, source: "CoinGecko", retrievedAt: "2026-11-06T12:00:00Z", candleIntervalMinutes: 240, timestampKind: "close", candles: Array.from({ length: 30 }, (_, i) => ({ timestamp: Date.UTC(2026, 9, 1) + i * 14_400_000, open: 100 + i, high: 103 + i, low: 99 + i, close: 102 + i })) };
}
function intradayHistory() {
  const coveredStart = Date.UTC(2026, 9, 30);
  const coveredEnd = coveredStart + 7 * 86_400_000;
  const candles = Array.from({ length: 672 }, (_, index) => ({ timestamp: coveredStart + (index + 1) * 900_000, open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index }));
  return candleData.parseIntradayCandleHistory({ coinId: "ethereum", source: "Binance Spot", quote: "USDT", interval: "15m", intervalMinutes: 15, days: 7, timestampKind: "close", observedAt: new Date(coveredEnd + 1000).toISOString(), retrievedAt: new Date(coveredEnd + 1200).toISOString(), coveredStart, coveredEnd, count: candles.length, candles }, { coinId: "ethereum", interval: "15m", days: 7 });
}

test("strict same-identity checks preserve public chart controls while remounting private work", async () => {
  let value = account("A");
  let resolveNext;
  const controller = client.createCustomerSessionController({ fetcher: () => new Promise((resolve) => { resolveNext = resolve; }) });
  const slots = [];
  let cursor = 0;
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const boundary = await load("../src/app/components/customer-workspace-boundary.tsx", {
    react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; }, useCallback: (fn) => fn },
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "@/lib/public-chart-state": publicState,
    "./customer-session": { useCustomerSession: () => ({ state: controller.getSnapshot() }) },
  });
  let previousKey;
  let privateInstance;
  const render = () => {
    cursor = 0;
    const tree = boundary.CustomerWorkspaceBoundary({ Workspace: "ActualDashboardWorkspace" });
    // React replaces the keyed workspace instance; this models its private state.
    if (tree.key !== previousKey) { privateInstance = { draft: null, report: null, collections: [] }; previousKey = tree.key; }
    return tree;
  };
  try {
    const first = controller.check(); resolveNext(response(value)); await first;
    let tree = render();
    const source = intradayHistory();
    const chosen = { selectedId: "ethereum", days: 30, metric: "price", style: "candles", indicators: { sma: true, ema: true, rsi: true }, viewport: { start: .3, end: .6 }, candleView: candleData.captureCandleView(source, { start: 10, end: 25 }, 23), candleInterval: "15m", intradayDays: 7 };
    tree.props.onPublicChartChange(chosen);
    tree = render();
    const oldKey = tree.key;
    const oldLease = controller.getSnapshot().lease;
    privateInstance.draft = "A private payment draft";
    privateInstance.report = { privateTotal: 1234 };
    privateInstance.collections.push("A private saved collection");
    const checking = controller.check();
    tree = render();
    assert.equal(oldLease.active, false);
    assert.notEqual(tree.key, oldKey);
    assert.deepEqual(privateInstance, { draft: null, report: null, collections: [] });
    assert.deepEqual(tree.props.publicChart, chosen);
    resolveNext(response(value)); await checking;
    tree = render();
    assert.notEqual(tree.key, oldKey);
    assert.deepEqual(tree.props.publicChart, chosen);
    assert.deepEqual(candleData.restoreCandleView(source, tree.props.publicChart.candleView), { window: { start: 10, end: 25 }, selected: 23 });
    assert.deepEqual(privateInstance, { draft: null, report: null, collections: [] });
    privateInstance.draft = "A second private draft";
    const aLease = controller.getSnapshot().lease;
    const switchUser = controller.check(); render();
    value = account("B"); resolveNext(response(value)); await switchUser;
    tree = render();
    assert.equal(aLease.active, false);
    assert.equal(controller.getSnapshot().lease.scope, value.dataScope);
    assert.deepEqual(privateInstance, { draft: null, report: null, collections: [] });
    assert.deepEqual(tree.props.publicChart, chosen);
    assert.doesNotMatch(JSON.stringify(tree.props.publicChart), /private|1234|collection/i);
    assert.deepEqual(Object.keys(tree.props.publicChart).sort(), ["candleInterval", "candleView", "days", "indicators", "intradayDays", "metric", "selectedId", "style", "viewport"]);
  } finally { controller.dispose(); }
});

test("candle continuity never maps a snapshot across asset, currency, range or missing timestamps", () => {
  const source = history();
  const snapshot = candleData.captureCandleView(source, { start: 10, end: 25 }, 23);
  const empty = { window: null, selected: null };
  for (const changed of [{ coinId: "bitcoin" }, { currency: "GBP" }, { days: 7 }, { candles: source.candles.map((candle) => ({ ...candle, timestamp: candle.timestamp + 1000 })) }]) {
    assert.deepEqual(candleData.restoreCandleView({ ...source, ...changed }, snapshot), empty);
  }
  const full = candleData.captureCandleView(source, { start: 0, end: 30 }, 29);
  const extra = { ...source.candles.at(-1), timestamp: source.candles.at(-1).timestamp + 14_400_000 };
  assert.deepEqual(candleData.restoreCandleView({ ...source, candles: [...source.candles, extra] }, full).window, { start: 0, end: 31 });
});
