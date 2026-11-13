// Synthetic fixtures only. Run in an isolated network namespace with no real credentials.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
function load(source, aliases = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nodeRequire(name);
  new Function("exports", "require", "module", js)(loaded.exports, require, loaded);
  return loaded.exports;
}
async function source(path) { return readFile(new URL(path, import.meta.url), "utf8"); }

const storefront = load(await source("../src/lib/channel3-storefront.ts"));
const safety = load(await source("../src/lib/marketplace-safety.ts"));
const provider = load(await source("../src/lib/channel3.ts"), { "server-only": {}, "@/lib/channel3-storefront": storefront, "@/lib/marketplace-safety": safety });
const cors = load(await source("../src/lib/mobile-web-cors.ts"), { "server-only": {} });
const catalog = load(await source("../src/lib/channel3-catalog.ts"));
const priceRange = load(await source("../src/lib/marketplace-price-range.ts"));
const aliases = {
  "@/lib/channel3": provider,
  "@/lib/channel3-storefront": storefront,
  "@/lib/channel3-catalog": catalog,
  "@/lib/marketplace-price-range": priceRange,
  "@/lib/mobile-web-cors": cors,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => true },
  "@/lib/request-limits": { acquireClientSlot: () => () => {} },
};
const search = load(await source("../src/app/api/marketplace/search/route.ts"), aliases);
const browse = load(await source("../src/app/api/marketplace/catalog/route.ts"), aliases);
const { NextRequest } = nodeRequire("next/server");
const CAP = 2 * 1024 * 1024;
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;

// The test runner supplies a clean environment; no real value is loaded.
process.env.CHANNEL3_API_KEY = "simulation-only";
process.env.CHANNEL3_BASE_URL = "https://channel3.example.invalid";
process.env.CHANNEL3_COLLECTION_ID = "collection-fixture";
let makeResponse;
let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init, payload: JSON.parse(init.body) });
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  return makeResponse(init);
};
test.after(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });

function post(storefront = "GB", mode) {
  return search.POST(new NextRequest("http://localhost:3000/api/marketplace/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "headphones", limit: 8, storefront, ...(mode ? { mode } : {}) }),
  }));
}
function get(storefront = "US") {
  return browse.GET(new NextRequest(`http://localhost:3000/api/marketplace/catalog?section=audio&storefront=${storefront}`));
}
function bodyResponse(value, headers = {}) {
  return new Response(value, { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}
async function unavailable(request) {
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.match(body.error, /temporarily unavailable/i);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-private-marker/);
}
async function timedOut(request) {
  const response = await request();
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Product search took too long. Please try again." });
}

test("GB and US search and browse retain full product fields and existing provider options", async () => {
  const product = {
    id: "synthetic-product", title: "Synthetic headphones £",
    brands: [{ id: "brand-1", name: "Sample Brand" }],
    images: [{ url: "https://cdn.example.invalid/item.jpg", cleaned_url: null, is_main_image: true }],
    offers: [{ url: "https://store.example.invalid/item", domain: "store.example.invalid", availability: "InStock", price: { price: 12.5, currency: "GBP" } }],
    structured_attributes: { material: ["synthetic"] },
    additional_provider_field: { nested: ["retained", 42] },
  };
  const upstream = { products: [product], next_page_token: "synthetic-next-page" };
  makeResponse = () => bodyResponse(JSON.stringify(upstream));
  for (const [country, currency] of [["GB", "GBP"], ["US", "USD"]]) {
    for (const [kind, request] of [["search", () => post(country)], ["browse", () => get(country)]]) {
      calls = [];
      const response = await request();
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(body.storefront, country);
      assert.equal(body.currency, currency);
      assert.deepEqual(body.products, [product]);
      if (kind === "search") {
        assert.equal(typeof body.nextPageToken, "string");
        assert.notEqual(body.nextPageToken, upstream.next_page_token);
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].payload.config.country, country);
      assert.equal(calls[0].payload.config.currency, currency);
      assert.equal(calls[0].payload.config.language, "en");
    }
  }
});

test("Channel3 search gets a bounded longer deadline, with more time for agentic search", async () => {
  const deadlines = [];
  AbortSignal.timeout = (milliseconds) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  };
  makeResponse = () => bodyResponse(JSON.stringify({ products: [] }));
  try {
    assert.equal((await post("GB")).status, 200);
    assert.equal((await post("US", "agentic")).status, 200);
    assert.deepEqual(deadlines, [12_000, 20_000]);
    assert.equal(calls.at(-1).payload.config.mode, "agentic");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("a provider request deadline returns a safe gateway-timeout response", async () => {
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    return controller.signal;
  };
  makeResponse = () => { throw new Error("synthetic transport abort"); };
  try {
    await timedOut(() => post("US", "agentic"));
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("accepts exactly 2 MiB of decoded JSON and UTF-8 split between chunks", async () => {
  const prefix = '{"products":[],"extra":"';
  const suffix = '"}';
  const padding = "x".repeat(CAP - Buffer.byteLength(prefix + suffix) - Buffer.byteLength("£"));
  const bytes = Buffer.from(prefix + padding + "£" + suffix);
  assert.equal(bytes.byteLength, CAP);
  const split = bytes.indexOf(Buffer.from("£")) + 1;
  makeResponse = () => bodyResponse(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  }), { "Content-Length": String(CAP) });
  assert.equal((await post()).status, 200);
});

test("rejects an oversized declared length without reading the body and cancels it", async () => {
  for (const request of [post, get]) {
    let pulls = 0;
    let cancelled = false;
    makeResponse = () => bodyResponse(new ReadableStream({
      pull() { pulls += 1; },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { "Content-Length": String(CAP + 1) });
    await unavailable(request);
    assert.equal(pulls, 0);
    assert.equal(cancelled, true);
  }
});

test("rejects an oversized chunked decoded body and cancels the stream", async () => {
  for (const request of [post, get]) {
    let remaining = CAP + 1;
    let cancelled = false;
    makeResponse = () => bodyResponse(new ReadableStream({
      pull(controller) {
        const size = Math.min(64 * 1024, remaining);
        if (!size) return;
        remaining -= size;
        controller.enqueue(new Uint8Array(size));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await unavailable(request);
    assert.equal(cancelled, true);
  }
});

test("rejects invalid lengths, missing bodies, malformed UTF-8 and malformed JSON", async () => {
  const responses = [
    () => bodyResponse("{}", { "Content-Length": "invalid" }),
    () => bodyResponse("{}", { "Content-Length": "9007199254740993" }),
    () => new Response(null, { status: 200 }),
    () => bodyResponse(Uint8Array.from([123, 34, 112, 114, 111, 100, 117, 99, 116, 115, 34, 58, 91, 93, 44, 34, 120, 34, 58, 34, 195, 40, 34, 125])),
    () => bodyResponse('{"products": ["synthetic-private-marker"'),
  ];
  for (const response of responses) {
    makeResponse = response;
    await unavailable(post);
    await unavailable(get);
  }
});

test("the same request deadline rejects and cancels a stalled body", async () => {
  let cancelled = false;
  let timer;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 12_000);
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 20);
    return controller.signal;
  };
  makeResponse = () => bodyResponse(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"products":')); },
    cancel() { cancelled = true; },
  }));
  try {
    await timedOut(post);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timer);
    AbortSignal.timeout = originalTimeout;
  }
});

test("a non-settling read and cancellation cannot hold the route past the deadline", async () => {
  let cancelled = false;
  let released = false;
  let timer;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 8_000);
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 20);
    return controller.signal;
  };
  makeResponse = () => ({
    ok: true, status: 200, headers: new Headers(),
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: () => { cancelled = true; return new Promise(() => {}); },
      releaseLock: () => { released = true; },
    }) },
  });
  try {
    await unavailable(get);
    assert.equal(cancelled, true);
    assert.equal(released, true);
  } finally {
    clearTimeout(timer);
    AbortSignal.timeout = originalTimeout;
  }
});

test("upstream redirects and failures remain generic unavailable responses", async () => {
  for (const status of [307, 429, 500]) {
    makeResponse = () => new Response("synthetic-private-marker", { status });
    await unavailable(post);
    await unavailable(get);
  }
});
