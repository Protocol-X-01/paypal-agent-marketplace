import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/marketplace-request.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const cjsModule = { exports: {} };
new Function("exports", "module", javascript)(cjsModule.exports, cjsModule);
const { fetchMarketplaceJson, MarketplaceRequestTimeoutError } = cjsModule.exports;
const originalFetch = globalThis.fetch;

test.afterEach(() => { globalThis.fetch = originalFetch; });

test("returns a successful response and uses the requested storefront without caching", async () => {
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, options };
    return Response.json({ storefront: "US", currency: "USD", products: [] });
  };
  const controller = new AbortController();
  const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", {
    method: "POST", body: JSON.stringify({ query: "headphones", storefront: "US" }),
  }, controller.signal, 50);
  assert.equal(response.status, 200);
  assert.deepEqual(body, { storefront: "US", currency: "USD", products: [] });
  assert.deepEqual(JSON.parse(sent.options.body), { query: "headphones", storefront: "US" });
  assert.equal(sent.options.cache, "no-store");
  assert.notEqual(sent.options.signal, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(sent.options.signal.aborted, false, "the completed request's timer was cleared");
});

test("returns an HTTP error status even when its body is not JSON", async () => {
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 429 });
  const { response, body } = await fetchMarketplaceJson("/api/marketplace/catalog", {}, new AbortController().signal, 100);
  assert.equal(response.status, 429);
  assert.equal(body, null);
});

test("preserves only the explicit product-unavailable marker from a small JSON 404", async () => {
  globalThis.fetch = async () => Response.json({ error: "No current listing.", code: "PRODUCT_UNAVAILABLE", ignored: "private detail" }, { status: 404 });
  const { response, body } = await fetchMarketplaceJson("/api/marketplace/products/example?storefront=US", {}, new AbortController().signal, 100);
  assert.equal(response.status, 404);
  assert.deepEqual(body, { code: "PRODUCT_UNAVAILABLE" });
});

test("keeps legacy HTML and oversized JSON 404 bodies out of the result", async () => {
  const responses = [
    () => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }),
    () => new Response(JSON.stringify({ error: "x".repeat(5000), code: "PRODUCT_UNAVAILABLE" }), { status: 404, headers: { "Content-Type": "application/json" } }),
  ];
  for (const makeResponse of responses) {
    globalThis.fetch = async () => makeResponse();
    const { response, body } = await fetchMarketplaceJson("/api/marketplace/products/example?storefront=US", {}, new AbortController().signal, 100);
    assert.equal(response.status, 404);
    assert.equal(body, null);
  }
});

test("handles unreadable successful responses without exposing response text", async () => {
  globalThis.fetch = async () => new Response("not JSON", { status: 200 });
  await assert.rejects(
    fetchMarketplaceJson("/api/marketplace/search", {}, new AbortController().signal, 100),
    { message: "The shop returned an unreadable response. Please try again." },
  );
});

test("times out a stalled request even if the transport ignores abort", async () => {
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  };
  const controller = new AbortController();
  await assert.rejects(fetchMarketplaceJson("/api/marketplace/search", {}, controller.signal, 20), MarketplaceRequestTimeoutError);
  assert.equal(requestSignal.aborted, true);
  assert.equal(controller.signal.aborted, false, "timeout is not a customer region switch");
});

test("an abort-aware transport still reports the deadline as a timeout", async () => {
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  await assert.rejects(fetchMarketplaceJson("/api/marketplace/search", {}, controller.signal, 20), MarketplaceRequestTimeoutError);
  assert.equal(controller.signal.aborted, false);
});

test("times out while a response body is stalled", async () => {
  let requestSignal;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  };
  const controller = new AbortController();
  await assert.rejects(fetchMarketplaceJson("/api/marketplace/catalog", {}, controller.signal, 20), MarketplaceRequestTimeoutError);
  assert.equal(requestSignal.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

test("a body finishing after timeout cannot deliver stale results", async () => {
  let finishBody;
  let delivered = false;
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise((resolve) => { finishBody = resolve; }) });
  const pending = fetchMarketplaceJson("/api/marketplace/catalog?storefront=GB", {}, new AbortController().signal, 20);
  void pending.then(() => { delivered = true; }, () => {});
  await assert.rejects(pending, MarketplaceRequestTimeoutError);
  finishBody({ storefront: "GB", currency: "GBP", products: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false);
});

test("a storefront switch cancels promptly without becoming a timeout", async () => {
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const pending = fetchMarketplaceJson("/api/marketplace/catalog?storefront=GB", {}, controller.signal, 200);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
});

test("a request cancelled before starting does not call fetch", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Unexpected call"); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchMarketplaceJson("/api/marketplace/search", {}, controller.signal), { name: "AbortError" });
  assert.equal(called, false);
});

test("an ignored abort cannot deliver or parse an old region's late response", async () => {
  let finish;
  let parsed = false;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const controller = new AbortController();
  const pending = fetchMarketplaceJson("/api/marketplace/catalog?storefront=GB", {}, controller.signal, 200);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finish({ ok: true, json: async () => { parsed = true; return { storefront: "GB" }; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parsed, false);
});
