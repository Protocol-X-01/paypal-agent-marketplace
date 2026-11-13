// Synthetic responses only. This verifies shared-budget ordering and route mapping without a provider call.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
function load(source, aliases = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const localRequire = name => Object.hasOwn(aliases, name) ? aliases[name] : nativeRequire(name);
  new Function("exports", "require", "module", js)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}
async function source(path) { return readFile(new URL(path, import.meta.url), "utf8"); }

const events = [];
let denyBudget = false;
class Channel3BudgetExceededError extends Error {
  constructor(retryAfterSeconds) { super("budget exhausted"); this.retryAfterSeconds = retryAfterSeconds; }
}
const budget = {
  Channel3BudgetExceededError,
  reserveChannel3ProviderRequest: async () => {
    events.push("reserve");
    if (denyBudget) throw new Channel3BudgetExceededError(17);
  },
};
const storefront = load(await source("../src/lib/channel3-storefront.ts"));
const safety = load(await source("../src/lib/marketplace-safety.ts"));
const priceRange = load(await source("../src/lib/marketplace-price-range.ts"));
const channel3 = load(await source("../src/lib/channel3.ts"), {
  "server-only": {},
  "@/lib/channel3-storefront": storefront,
  "@/lib/marketplace-safety": safety,
  "@/lib/channel3-request-budget": budget,
});
const cors = load(await source("../src/lib/mobile-web-cors.ts"), { "server-only": {} });
const catalog = load(await source("../src/lib/channel3-catalog.ts"));
const aliases = {
  "@/lib/channel3": channel3,
  "@/lib/channel3-storefront": storefront,
  "@/lib/channel3-catalog": catalog,
  "@/lib/marketplace-price-range": priceRange,
  "@/lib/marketplace-safety": safety,
  "@/lib/mobile-web-cors": cors,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => true },
  "@/lib/request-limits": { acquireClientSlot: () => () => {} },
};
const searchRoute = load(await source("../src/app/api/marketplace/search/route.ts"), aliases);
const catalogRoute = load(await source("../src/app/api/marketplace/catalog/route.ts"), aliases);
const productRoute = load(await source("../src/app/api/marketplace/products/[productId]/route.ts"), aliases);
const similarRoute = load(await source("../src/app/api/marketplace/products/[productId]/similar/route.ts"), aliases);
const { NextRequest } = nativeRequire("next/server");
const originalFetch = globalThis.fetch;
const envKeys = ["CHANNEL3_API_KEY", "CHANNEL3_BASE_URL", "CHANNEL3_COLLECTION_ID"];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.CHANNEL3_API_KEY = "synthetic-key";
process.env.CHANNEL3_BASE_URL = "https://channel3.example.invalid";
process.env.CHANNEL3_COLLECTION_ID = "synthetic-collection";
globalThis.fetch = async (_input, init = {}) => {
  events.push("fetch");
  if (init.method === "GET") {
    return new Response(JSON.stringify({ id: "product-1", title: "Synthetic item", offers: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({ products: [] }), { status: 200 });
};
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

const locale = { country: "US", currency: "USD", language: "en" };
test("search and exact-product requests reserve immediately before provider fetch", async () => {
  denyBudget = false;
  events.length = 0;
  await channel3.search({ query: "headphones", locale });
  assert.deepEqual(events, ["reserve", "fetch"]);

  events.length = 0;
  await channel3.retrieveProduct("product-1", locale);
  assert.deepEqual(events, ["reserve", "fetch"]);
});

test("failed reservation prevents every Channel3 fetch and maps to retryable 429", async () => {
  denyBudget = true;
  const requests = [
    () => searchRoute.POST(new NextRequest("http://localhost:3000/api/marketplace/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "headphones", storefront: "US" }),
    })),
    () => catalogRoute.GET(new NextRequest("http://localhost:3000/api/marketplace/catalog?section=audio&storefront=US")),
    () => productRoute.GET(new NextRequest("http://localhost:3000/api/marketplace/products/product-1?storefront=US"), { params: Promise.resolve({ productId: "product-1" }) }),
    () => similarRoute.GET(new NextRequest("http://localhost:3000/api/marketplace/products/product-1/similar?storefront=US"), { params: Promise.resolve({ productId: "product-1" }) }),
  ];

  for (const request of requests) {
    events.length = 0;
    const response = await request();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(events, ["reserve"]);
  }
});
