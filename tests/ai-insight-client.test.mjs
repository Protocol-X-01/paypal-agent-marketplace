import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const localRequire = createRequire(import.meta.url);
const exports = {};
new Function("exports", "require", ts.transpileModule(readFileSync(new URL("../packages/ai-insights/ui/client.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, localRequire);
const { isSelectedInsight, requestInsight } = exports;
const selection = { coinId: "bitcoin", currency: "GBP", days: 7 };
const shopSelection = { query: "wireless headphones", storefront: "US", products: [{ title: "Studio headphones", brand: "North Audio" }] };
function market() {
  return { kind: "market", generatedAt: "2026-11-06T13:00:00Z", model: "example-model", insight: { headline: "Observed changes", summary: "This describes the reference history.", observations: ["Prices varied in the observed period."], caution: "History does not establish a future outcome." }, disclaimer: "Example AI explanation.", source: { ...selection, provider: "CoinGecko", retrievedAt: "2026-11-06T12:59:00Z", sampleCount: 42, firstTimestamp: 1793350800000, lastTimestamp: 1793941200000, firstPrice: 20, lastPrice: 22, low: 19, high: 23, changePercent: 10, priceBasis: "candle_close", rangeBasis: "candle_high_low", timestampKind: "close", candleIntervalMinutes: 240 } };
}
function shop(chosen = shopSelection) {
  return { kind: "product-discovery", generatedAt: "2026-11-06T13:00:00Z", model: "example-model", insight: { headline: "A clear search", summary: "The shown results share a product theme.", observations: ["Product names point to a focused search.", "The separate offers contain the current details."], caution: "Check the retailer page for final terms." }, disclaimer: "AI commentary is fallible.", source: { provider: "Displayed Channel3 result labels", storefront: chosen.storefront, productCount: chosen.products.length } };
}
const signal = () => new AbortController().signal;

test("valid response is bound to the exact selected public candle context", () => {
  assert.equal(isSelectedInsight(market(), "market", selection), true);
  for (const changed of [{ ...selection, currency: "USD" }, { ...selection, coinId: "ethereum" }, { ...selection, days: 30 }]) assert.equal(isSelectedInsight(market(), "market", changed), false);
  assert.equal(isSelectedInsight(market(), "fictional-report", selection), false);
});

test("Shop commentary is bound to the current visible result count and storefront", () => {
  assert.equal(isSelectedInsight(shop(), "product-discovery", shopSelection), true);
  assert.equal(isSelectedInsight(shop(), "product-discovery", { ...shopSelection, storefront: "GB" }), false);
  assert.equal(isSelectedInsight(shop(), "product-discovery", { ...shopSelection, products: [] }), false);
  assert.equal(isSelectedInsight({ ...shop(), source: { ...shop().source, products: shopSelection.products } }, "product-discovery", shopSelection), false);
  assert.equal(isSelectedInsight(shop(), "market", shopSelection), false);
});

test("source provenance, finite values and bounded narrative are required", () => {
  for (const change of [
    { source: { ...market().source, provider: "Unverified" } },
    { source: { ...market().source, priceBasis: "line_samples" } },
    { source: { ...market().source, lastTimestamp: market().source.firstTimestamp } },
    { source: { ...market().source, lastPrice: Infinity } },
    { source: { ...market().source, low: 21 } },
    { generatedAt: "not-a-date" },
    { insight: { ...market().insight, summary: "x".repeat(4001) } },
    { insight: { ...market().insight, observations: [] } },
  ]) assert.equal(isSelectedInsight({ ...market(), ...change }, "market", selection), false);
});

test("candle timestamps must be safe positive and renderable, and cadence matches the selected range", () => {
  for (const timestamp of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001, 1e30]) {
    for (const key of ["firstTimestamp", "lastTimestamp"]) {
      const value = market();
      value.source[key] = timestamp;
      assert.equal(isSelectedInsight(value, "market", selection), false, `${key}: ${timestamp}`);
    }
  }
  for (const [days, expected] of [[1, 30], [7, 240], [30, 240], [90, 5760], [365, 5760]]) {
    const chosen = { ...selection, days };
    for (const cadence of [30, 240, 5760, String(expected)]) {
      const value = market();
      Object.assign(value.source, chosen, { candleIntervalMinutes: cadence });
      assert.equal(isSelectedInsight(value, "market", chosen), cadence === expected, `${days} days: ${cadence}`);
    }
  }
});

test("transport uses only the same-origin fixed endpoint and selected IDs", async () => {
  let observed;
  const value = await requestInsight("market", selection, signal(), async (url, init) => { observed = { url, init }; return Response.json(market()); });
  assert.equal(value.kind, "market");
  assert.equal(observed.url, "/api/ai/market-insight");
  assert.equal(observed.init.mode, "same-origin");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.cache, "no-store");
  assert.deepEqual(JSON.parse(observed.init.body), selection);
  assert.equal(Object.keys(observed.init.headers).join(), "Content-Type");
});

test("Shop transport sends only the selected label preview to its fixed same-origin route", async () => {
  let observed;
  const value = await requestInsight("product-discovery", shopSelection, signal(), async (url, init) => { observed = { url, init }; return Response.json(shop()); });
  assert.equal(value.kind, "product-discovery");
  assert.equal(observed.url, "/api/ai/shop-discover");
  assert.equal(observed.init.mode, "same-origin");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.cache, "no-store");
  assert.deepEqual(JSON.parse(observed.init.body), shopSelection);
  assert.doesNotMatch(observed.init.body, /productId|https?:\/\/|price|commission|wallet|contact|balance/i);
});

test("a response for a different selection is not exposed as the requested view", async () => {
  await assert.rejects(requestInsight("market", { ...selection, days: 30 }, signal(), async () => Response.json(market())), /did not match/);
});

test("provider details are not copied into errors and rate timing is useful", async () => {
  await assert.rejects(requestInsight("market", selection, signal(), async () => Response.json({ error: { message: "private upstream details" } }, { status: 503 })), (error) => error.message.includes("unavailable") && !error.message.includes("private"));
  await assert.rejects(requestInsight("market", selection, signal(), async () => Response.json({ error: {} }, { status: 429, headers: { "Retry-After": "20" } })), /20 seconds/);
  await assert.rejects(requestInsight("market", selection, signal(), async () => Response.json({ error: {} }, { status: 504 })), /too long/);
});

test("malformed UTF-8, JSON and oversized responses fail within the client cap", async () => {
  for (const body of [new Uint8Array([0xff]), "{", "x".repeat(32769)]) await assert.rejects(requestInsight("market", selection, signal(), async () => new Response(body)), /could not be read/);
});

test("cancellation ends an already pending body read", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const pending = requestInsight("market", selection, controller.signal, async () => new Response(body));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(cancelled, true);
});
