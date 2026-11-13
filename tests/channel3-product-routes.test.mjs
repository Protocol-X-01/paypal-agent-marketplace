// Synthetic provider responses only; no network, account, or retailer data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
function load(source, aliases = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nativeRequire(name);
  new Function("exports", "require", "module", js)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}
async function source(path) { return readFile(new URL(path, import.meta.url), "utf8"); }

const storefront = load(await source("../src/lib/channel3-storefront.ts"));
const safety = load(await source("../src/lib/marketplace-safety.ts"));
const budgetError = class Channel3BudgetExceededError extends Error { constructor(retryAfterSeconds) { super("budget exhausted"); this.retryAfterSeconds = retryAfterSeconds; } };
const budget = { Channel3BudgetExceededError: budgetError, reserveChannel3ProviderRequest: async () => {} };
const provider = load(await source("../src/lib/channel3.ts"), { "server-only": {}, "@/lib/channel3-storefront": storefront, "@/lib/marketplace-safety": safety, "@/lib/channel3-request-budget": budget });
const cors = load(await source("../src/lib/mobile-web-cors.ts"), { "server-only": {} });
const aliases = {
  "@/lib/channel3": provider,
  "@/lib/channel3-storefront": storefront,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => true },
  "@/lib/mobile-web-cors": cors,
  "@/lib/marketplace-safety": safety,
};
const productRoute = load(await source("../src/app/api/marketplace/products/[productId]/route.ts"), aliases);
const similarRoute = load(await source("../src/app/api/marketplace/products/[productId]/similar/route.ts"), aliases);
const { NextRequest } = nativeRequire("next/server");
const originalFetch = globalThis.fetch;
const originalKey = process.env.CHANNEL3_API_KEY;
const originalBase = process.env.CHANNEL3_BASE_URL;
process.env.CHANNEL3_API_KEY = "simulation-only";
process.env.CHANNEL3_BASE_URL = "https://api.example.invalid";
let upstreamStatus = 200;
let upstreamBody;
let calls = [];
globalThis.fetch = async (url, options) => {
  const endpoint = new URL(url);
  assert.equal(endpoint.host, "api.example.invalid");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  calls.push({ endpoint, options });
  return new Response(upstreamStatus === 404 ? null : JSON.stringify(upstreamBody), {
    status: upstreamStatus,
    headers: { "Content-Type": "application/json" },
  });
};
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CHANNEL3_API_KEY; else process.env.CHANNEL3_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.CHANNEL3_BASE_URL; else process.env.CHANNEL3_BASE_URL = originalBase;
});

function request(route, productId = "product-1", storefrontValue = "US") {
  const url = `http://localhost:3000/api/marketplace/products/${encodeURIComponent(productId)}${route === similarRoute ? "/similar" : ""}?storefront=${storefrontValue}`;
  return route.GET(new NextRequest(url), { params: Promise.resolve({ productId }) });
}
function offer(domain = "store.example", availability = "InStock", condition = "new", url = `https://${domain}/item`) {
  return { domain, url, availability, condition, price: { price: 25, currency: "USD" } };
}
async function unavailable(response) {
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "This product is not currently listed for the selected storefront.",
    code: "PRODUCT_UNAVAILABLE",
  });
}

test("a provider-confirmed missing product has a distinguishable no-store response", async () => {
  calls = [];
  upstreamStatus = 404;
  await unavailable(await request(productRoute));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].endpoint.pathname, "/v1/products/product-1");
  assert.equal(calls[0].endpoint.searchParams.get("country"), "US");
  assert.equal(calls[0].endpoint.searchParams.get("currency"), "USD");
});

test("foreign-only offers are unavailable while a local sold-out offer remains visible", async () => {
  calls = [];
  upstreamStatus = 200;
  upstreamBody = { id: "product-1", title: "Headphones", offers: [offer("shop.co.uk")] };
  await unavailable(await request(productRoute));
  upstreamBody = { id: "product-1", title: "Headphones", offers: [offer("store.example", "OutOfStock")] };
  const response = await request(productRoute);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.product.offers.length, 1);
  assert.equal(body.product.offers[0].availability, "OutOfStock");
});

test("a different product ID is rejected without leaking the provider response", async () => {
  upstreamStatus = 200;
  upstreamBody = { id: "different-product", title: "synthetic-private-marker", offers: [offer()] };
  const response = await request(productRoute);
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /synthetic-private-marker/);
});

test("exact product refresh rejects mismatched links without claiming the item is unavailable", async () => {
  upstreamStatus = 200;
  upstreamBody = { id: "product-1", title: "Headphones", offers: [offer("bestbuy.com", "InStock", "new", "https://other.example/item")] };
  const response = await request(productRoute);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /safe retailer link could not be confirmed/i);
  assert.equal(body.code, undefined);
  assert.doesNotMatch(JSON.stringify(body), /other\.example/);
});

test("exact and similar product checks retain safe normalized retailer and Channel3 links", async () => {
  upstreamStatus = 200;
  const offers = [
    offer("WWW.BESTBUY.COM.", "InStock", "new", "https://www.bestbuy.com/item"),
    offer("bestbuy.com", "InStock", "new", "https://buy.trychannel3.com/offer"),
    offer("bestbuy.com", "InStock", "new", "https://other.example/item"),
  ];
  upstreamBody = { id: "product-1", title: "Headphones", offers };
  const exact = await request(productRoute);
  assert.equal(exact.status, 200);
  assert.deepEqual((await exact.json()).product.offers.map(item => item.url), ["https://www.bestbuy.com/item", "https://buy.trychannel3.com/offer"]);
  upstreamBody = { products: [{ id: "alternative-1", title: "Alternative", offers }] };
  const similar = await request(similarRoute);
  assert.equal(similar.status, 200);
  assert.deepEqual((await similar.json()).products[0].offers.map(item => item.url), ["https://www.bestbuy.com/item", "https://buy.trychannel3.com/offer"]);
});

test("similar recommendations keep only distinct in-stock safe offers for the storefront", async () => {
  calls = [];
  upstreamStatus = 200;
  upstreamBody = { products: [
    { id: "product-1", title: "Source", offers: [offer()] },
    { id: "alternative-1", title: "Alternative", offers: [offer(), offer("store.example", "OutOfStock"), offer("store.example", "InStock", "new", "https://other.example/item")] },
    { id: "alternative-1", title: "Duplicate", offers: [offer()] },
    { id: "alternative-2", title: "Used", offers: [offer("store.example", "InStock", "used")] },
    { id: "alternative-3", title: "Foreign", offers: [offer("shop.co.uk")] },
  ] };
  const response = await request(similarRoute);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.products.map((product) => product.id), ["alternative-1"]);
  assert.deepEqual(body.products[0].offers.map((item) => item.url), ["https://store.example/item"]);
  assert.equal(calls[0].endpoint.pathname, "/v1/similar");
  assert.deepEqual(JSON.parse(calls[0].options.body).filters, { conditions: ["new"], availability: ["InStock"] });
});

test("invalid product IDs are rejected before contacting Channel3", async () => {
  calls = [];
  const response = await request(productRoute, "bad.id");
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
