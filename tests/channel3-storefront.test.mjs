import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const requireNode = createRequire(import.meta.url);
function load(source, aliases = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : requireNode(name);
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
const { NextRequest } = requireNode("next/server");
const originalFetch = global.fetch;
const keys = ["CHANNEL3_API_KEY", "CHANNEL3_BASE_URL", "CHANNEL3_COUNTRY", "CHANNEL3_CURRENCY", "CHANNEL3_LANGUAGE", "CHANNEL3_COLLECTION_ID"];
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let calls = [];
let providerPayload = { products: [{ id: "synthetic", title: "Example" }] };
global.fetch = async (url, options) => {
  calls.push({ url: String(url), body: JSON.parse(options.body) });
  return new Response(JSON.stringify(providerPayload), { status: 200, headers: { "Content-Type": "application/json" } });
};
process.env.CHANNEL3_API_KEY = "simulation-only";
process.env.CHANNEL3_BASE_URL = "https://api.example.invalid";
process.env.CHANNEL3_COLLECTION_ID = "collection-fixture";

test("US PayPal retailer markers require an exact verified retailer host", () => {
  assert.equal(storefront.isPayPalListedAtRetailer("www.bestbuy.com", "US"), true);
  assert.equal(storefront.isPayPalListedAtRetailer("shop.walmart.com", "US"), true);
  assert.equal(storefront.isPayPalListedAtRetailer("target.com", "US"), true);
  assert.equal(storefront.isPayPalListedAtRetailer("cvs.com", "US"), false);
  assert.equal(storefront.isPayPalListedAtRetailer("notbestbuy.com", "US"), false);
  assert.equal(storefront.isPayPalListedAtRetailer("bestbuy.com", "GB"), false);
});

test("explicit retailer filters use the same website IDs as the curated catalog", () => {
  for (const [id, phrase] of [["target", "from Target"], ["cvs", "at CVS"], ["walmart", "via Walmart"], ["bestbuy", "from Best Buy"]]) {
    assert.equal(provider.requestedChannel3Retailer(`headphones ${phrase}`)?.websiteId, catalog.findChannel3CuratedRetailer(id)?.websiteId);
  }
});

test("legacy extra search fields are ignored and never forwarded to Channel3", async () => {
  calls = [];
  const response = await post({ query: "headphones", mode: "agentic", storefront: "US", unknownOption: "local-only-fixture" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).searchMode, "agentic");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes("local-only-fixture"), false);
});

test("legacy search requests keep their original response shape", async () => {
  calls = [];
  const response = await post({ query: "headphones", storefront: "US" });
  assert.equal(response.status, 200);
  assert.equal("searchMode" in await response.json(), false);
  assert.equal(calls[0].body.config.mode, "default");
});

test("search and catalog never return offer links that mismatch their listed retailer", async () => {
  const originalPayload = providerPayload;
  providerPayload = { products: [{ id: "safe-link-fixture", title: "Headphones", offers: [
    { domain: "WWW.BESTBUY.COM.", url: "https://www.bestbuy.com/item", availability: "InStock", price: { price: 12, currency: "USD" } },
    { domain: "bestbuy.com", url: "https://buy.trychannel3.com/item", availability: "InStock", price: { price: 12, currency: "USD" } },
    { domain: "bestbuy.com", url: "https://other.example/item", availability: "InStock", price: { price: 12, currency: "USD" } },
  ] }] };
  try {
    for (const request of [() => post({ query: "headphones", storefront: "US" }), () => get("section=audio&storefront=US")]) {
      const response = await request();
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).products[0].offers.map(item => item.url), ["https://www.bestbuy.com/item", "https://buy.trychannel3.com/item"]);
    }
  } finally {
    providerPayload = originalPayload;
  }
});

function post(body) {
  return search.POST(new NextRequest("http://localhost:3000/api/marketplace/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
function get(query) { return browse.GET(new NextRequest(`http://localhost:3000/api/marketplace/catalog?${query}`)); }
function locale(country, currency, language) {
  process.env.CHANNEL3_COUNTRY = country;
  process.env.CHANNEL3_CURRENCY = currency;
  process.env.CHANNEL3_LANGUAGE = language;
}
test.after(() => {
  global.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("explicit storefronts map to the correct provider config in search and browse", async () => {
  locale("DE", "EUR", "de");
  for (const [country, currency] of [["GB", "GBP"], ["US", "USD"]]) {
    for (const request of [() => post({ query: "headphones", storefront: country }), () => get(`section=audio&storefront=${country}`)]) {
      calls = [];
      const response = await request();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.storefront, country);
      assert.equal(body.currency, currency);
      assert.equal(calls.length, 1);
      assert.deepEqual({ ...calls[0].body.config, mode: undefined }, { country, currency, language: "en", collection_id: "collection-fixture", mode: undefined });
    }
  }
});

test("agentic search forwards the full brief, applies budget bounds, and binds continuations to mode", async () => {
  const originalPayload = providerPayload;
  const brief = "Please help me find comfortable over-ear headphones for travel under $150";
  providerPayload = { products: [{ id: "agentic-example", title: "Travel headphones" }], next_page_token: "agentic-page-2" };
  calls = [];
  try {
    const response = await post({ query: brief, mode: "agentic", storefront: "US" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.searchMode, "agentic");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.query, brief, "agentic mode receives the complete shopper brief");
    assert.equal(calls[0].body.config.mode, "agentic");
    assert.deepEqual(calls[0].body.filters.price, { max_price: 150 });
    assert.ok(body.nextPageToken);

    const callsBeforeMismatch = calls.length;
    const mismatchedContinuation = await post({ query: brief, mode: "default", storefront: "US", pageToken: body.nextPageToken });
    assert.equal(mismatchedContinuation.status, 400);
    assert.match((await mismatchedContinuation.json()).error, /restart this search/i);
    assert.equal(calls.length, callsBeforeMismatch, "a mode-mismatched token never reaches Channel3");
  } finally {
    providerPayload = originalPayload;
  }
});

test("explicit supported retailer requests constrain Channel3 and returned offers", async () => {
  const originalPayload = providerPayload;
  const offer = (domain) => ({ domain, url: `https://${domain}/headphones`, price: { price: 79, currency: "USD" }, availability: "InStock" });
  providerPayload = { products: [
    { id: "bestbuy-item", title: "Wireless headphones", offers: [offer("www.bestbuy.com"), offer("walmart.com")] },
    { id: "walmart-only", title: "Another pair", offers: [offer("walmart.com")] },
  ], next_page_token: "bestbuy-page-2" };
  calls = [];
  try {
    const response = await post({ query: "Please order headphones from Best Buy under $100", mode: "agentic", storefront: "US" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.searchMode, "agentic");
    assert.deepEqual(calls[0].body.filters, { price: { max_price: 100 }, website_ids: ["p1PB"] });
    assert.deepEqual(body.products.map(({ id }) => id), ["bestbuy-item"]);
    assert.deepEqual(body.products[0].offers.map(({ domain }) => domain), ["www.bestbuy.com"]);
    assert.equal(typeof body.nextPageToken, "string", "the user receives an opaque continuation token");
    providerPayload = { products: [{ id: "bestbuy-page-two", title: "Another Best Buy result", offers: [offer("bestbuy.com"), offer("walmart.com")] }], next_page_token: null };
    const nextPage = await post({ query: "Please order headphones from Best Buy under $100", mode: "agentic", storefront: "US", pageToken: body.nextPageToken });
    assert.equal(nextPage.status, 200);
    assert.equal(calls[1].body.page_token, "bestbuy-page-2", "the application-wrapped cursor reaches Channel3 only in its original search context");
    assert.deepEqual(calls[1].body.filters, { price: { max_price: 100 }, website_ids: ["p1PB"] }, "the exact retailer and budget filters persist to later pages");
    assert.deepEqual((await nextPage.json()).products.map(({ id }) => id), ["bestbuy-page-two"]);

    for (const [phrase, id, domain] of [
      ["from Target", "target", "target.com"],
      ["at CVS", "cvs", "cvs.com"],
      ["via Walmart", "walmart", "walmart.com"],
    ]) {
      assert.deepEqual(provider.requestedChannel3Retailer(`headphones ${phrase}`), {
        id,
        title: id === "target" ? "Target" : id === "cvs" ? "CVS" : "Walmart",
        websiteId: id === "target" ? "QnTm" : id === "cvs" ? "oeWt" : "BsaX",
        domain,
        storefront: "US",
      });
    }
    assert.equal(provider.requestedChannel3Retailer("Best Buy headphones"), null, "a retailer name without an explicit store phrase is not treated as a constraint");
  } finally {
    providerPayload = originalPayload;
  }
});

test("recognized US retailer requests fail closed on the GB storefront", async () => {
  calls = [];
  const response = await post({ query: "Please find headphones from Best Buy", mode: "agentic", storefront: "GB" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Best Buy offers are only available in the US storefront/i);
  assert.equal(calls.length, 0, "unsupported storefronts never reach Channel3");
});

test("search removes known foreign retailer hosts for explicit storefronts", async () => {
  const originalPayload = providerPayload;
  const offer = (domain, currency) => ({ domain, url: `https://${domain}/item`, price: { price: 12, currency }, availability: "InStock" });
  providerPayload = { products: [
    { id: "mixed", title: "Mixed offers", offers: [
      offer("target.com", "USD"), offer("store.target.com", "USD"), offer("cvs.com", "USD"), offer("walmart.com", "USD"), offer("bestbuy.com", "USD"), offer("store.example.us", "USD"), offer("staples.ca", "USD"), offer("bestbuy.co.uk", "USD"), offer("retailer.eu", "USD"),
    ] },
    { id: "canada-only", title: "Canada only", offers: [offer("retailer.ca", "USD")] },
  ] };
  try {
    const usResponse = await post({ query: "calculator", storefront: "US" });
    assert.equal(usResponse.status, 200);
    const usProducts = (await usResponse.json()).products;
    assert.deepEqual(usProducts.map(({ id }) => id), ["mixed", "canada-only"]);
    assert.deepEqual(usProducts[0].offers.map(({ domain }) => domain), ["target.com", "store.target.com", "cvs.com", "walmart.com", "bestbuy.com", "store.example.us", "retailer.eu"]);
    assert.deepEqual(usProducts[1].offers, []);

    providerPayload = { products: [{ id: "mixed", title: "Mixed offers", offers: [
      offer("amazon.co.uk", "GBP"), offer("retailer.ca", "GBP"), offer("store.example.us", "GBP"), offer("target.com", "GBP"), offer("cvs.com", "GBP"), offer("walmart.com", "GBP"), offer("bestbuy.com", "GBP"), offer("brand.com", "GBP"), offer("brand.eu", "GBP"),
    ] }] };
    const gbResponse = await post({ query: "calculator", storefront: "GB" });
    assert.equal(gbResponse.status, 200);
    assert.deepEqual((await gbResponse.json()).products[0].offers.map(({ domain }) => domain), ["amazon.co.uk", "brand.com", "brand.eu"]);

    calls = [];
    const wrongRegionRetailer = await get("retailer=target&storefront=GB");
    assert.equal(wrongRegionRetailer.status, 400);
    assert.match((await wrongRegionRetailer.json()).error, /not available in the GB storefront/i);
    assert.equal(calls.length, 0);

    calls = [];
    const usRetailer = await get("retailer=target&storefront=US");
    assert.equal(usRetailer.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.config.country, "US");
  } finally {
    providerPayload = originalPayload;
  }
});

test("US search ranks in-stock USD offers from recognized local retailers first", async () => {
  const originalPayload = providerPayload;
  const offer = (domain, currency, availability = "InStock") => ({
    domain,
    url: `https://${domain}/item`,
    price: { price: 12, currency },
    availability,
  });
  providerPayload = { products: [{ id: "ranked", title: "Ranked offers", offers: [
    offer("generic.example", "USD"),
    offer("target.com", "USD", "OutOfStock"),
    offer("walmart.com", "USD"),
    offer("store.example.us", "USD"),
    offer("retailer.co.uk", "USD"),
    offer("bestbuy.com", "GBP"),
  ] }] };
  try {
    const response = await post({ query: "backpack", storefront: "US" });
    assert.equal(response.status, 200);
    const products = await response.json();
    assert.deepEqual(products.products[0].offers.map(({ domain }) => domain), [
      "walmart.com",
      "store.example.us",
      "generic.example",
      "bestbuy.com",
      "target.com",
    ]);

    providerPayload = { products: [{ id: "ranked-gb", title: "UK ranked offers", offers: [
      offer("generic.example", "GBP"),
      offer("amazon.co.uk", "GBP"),
      offer("retailer.us", "GBP"),
    ] }] };
    const gbResponse = await post({ query: "backpack", storefront: "GB" });
    assert.equal(gbResponse.status, 200);
    const gbProducts = await gbResponse.json();
    assert.deepEqual(gbProducts.products[0].offers.map(({ domain }) => domain), ["amazon.co.uk", "generic.example"]);
  } finally {
    providerPayload = originalPayload;
  }
});

test("omitted storefront preserves supported configured country, currency, and language", async () => {
  locale("DE", "GBP", "de");
  for (const request of [() => post({ query: "headphones" }), () => get("section=audio")]) {
    calls = [];
    const response = await request();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.storefront, "DE");
    assert.equal(body.currency, "GBP");
    assert.equal(calls[0].body.config.country, "DE");
    assert.equal(calls[0].body.config.currency, "GBP");
    assert.equal(calls[0].body.config.language, "de");
  }
});

test("missing locale environment uses US/USD/en defaults", async () => {
  delete process.env.CHANNEL3_COUNTRY;
  delete process.env.CHANNEL3_CURRENCY;
  delete process.env.CHANNEL3_LANGUAGE;
  calls = [];
  const response = await post({ query: "headphones" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.storefront, "US");
  assert.equal(body.currency, "USD");
  assert.equal(calls[0].body.config.language, "en");
});

test("invalid or ambiguous storefronts do not reach the provider", async () => {
  locale("GB", "GBP", "en");
  for (const request of [
    () => post({ query: "headphones", storefront: "FR" }),
    () => post({ query: "headphones", storefront: null }),
    () => post({ query: "headphones", storefront: "gb" }),
    () => get("section=audio&storefront=FR"),
    () => get("section=audio&storefront="),
    () => get("section=audio&storefront=GB&storefront=US"),
  ]) {
    calls = [];
    assert.equal((await request()).status, 400);
    assert.equal(calls.length, 0);
  }
});

test("unsupported configured defaults fail closed while explicit storefronts still work", async () => {
  for (const setting of [["not-a-country", "GBP", "en"], ["GB", "bad-currency", "en"], ["GB", "GBP", "bad-language"]]) {
    locale(...setting);
    for (const request of [() => post({ query: "headphones" }), () => get("section=audio")]) {
      calls = [];
      assert.equal((await request()).status, 503);
      assert.equal(calls.length, 0);
    }
  }
  assert.equal((await post({ query: "headphones", storefront: "US" })).status, 200);
});

test("natural-language price budgets become structured Channel3 filters in the selected currency", async () => {
  locale("DE", "EUR", "de");
  calls = [];
  const response = await post({ query: "xD bags under 150", storefront: "GB" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.priceRange, { maxPrice: 150 });
  assert.deepEqual(result.products.map((product) => product.id), ["synthetic"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.query, "xD bags");
  assert.deepEqual(calls[0].body.filters.price, { max_price: 150 });
  assert.equal(calls[0].body.config.country, "GB");
  assert.equal(calls[0].body.config.currency, "GBP");

  calls = [];
  const usResponse = await post({ query: "wireless headphones under $150", storefront: "US" });
  assert.equal(usResponse.status, 200);
  assert.deepEqual((await usResponse.json()).priceRange, { maxPrice: 150 });
  assert.equal(calls[0].body.query, "wireless headphones");
  assert.equal(calls[0].body.config.currency, "USD");
  assert.deepEqual(calls[0].body.filters.price, { max_price: 150 });
});

test("manual bounds intersect with a budget phrase and invalid budgets never reach Channel3", async () => {
  locale("GB", "GBP", "en");
  calls = [];
  const combined = await post({ query: "headphones under 150", storefront: "GB", priceRange: { minPrice: 25, maxPrice: 200 } });
  assert.equal(combined.status, 200);
  assert.deepEqual((await combined.json()).priceRange, { minPrice: 25, maxPrice: 150 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.filters.price, { min_price: 25, max_price: 150 });

  for (const input of [
    { query: "bags under 100", storefront: "GB", priceRange: { minPrice: 150 } },
    { query: "bags under £100", storefront: "US" },
  ]) {
    calls = [];
    const rejected = await post(input);
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0, "invalid or conflicting budgets must fail before the provider call");
  }
});

test("price-only budgets preserve the selected currency and use the documented generic provider query", async () => {
  locale("GB", "GBP", "en");
  calls = [];
  const response = await post({ query: "under 150", storefront: "GB" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.query, "under 150");
  assert.equal(body.storefront, "GB");
  assert.equal(body.currency, "GBP");
  assert.deepEqual(body.priceRange, { maxPrice: 150 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.query, "products");
  assert.equal(calls[0].body.config.currency, "GBP");
  assert.deepEqual(calls[0].body.filters.price, { max_price: 150 });
});

test("typed price fields accept bounded decimal input and reject invalid ranges", () => {
  assert.deepEqual(priceRange.parsePriceRangeInputs("", "150"), { range: { maxPrice: 150 }, error: null });
  assert.deepEqual(priceRange.parsePriceRangeInputs("25.50", "150"), { range: { minPrice: 25.5, maxPrice: 150 }, error: null });
  assert.match(priceRange.parsePriceRangeInputs("1.234", "150").error, /valid minimum price/i);
  assert.match(priceRange.parsePriceRangeInputs("150", "100").error, /must not exceed/i);
});

test("malformed provider responses do not become successful storefront results", async () => {
  const malformed = [
    null, {}, { products: null }, { products: "invalid" },
    { products: [{}] }, { products: [{ id: "example", title: 1 }] },
    { products: [], next_page_token: 1 },
  ];
  try {
    for (const payload of malformed) {
      providerPayload = payload;
      for (const request of [
        () => post({ query: "headphones", storefront: "GB" }),
        () => get("section=audio&storefront=US"),
      ]) {
        const response = await request();
        assert.equal(response.status, 503);
        assert.match((await response.json()).error, /temporarily unavailable/i);
      }
    }
    providerPayload = { products: [] };
    assert.equal((await post({ query: "headphones", storefront: "US" })).status, 200);
    assert.equal((await get("section=audio&storefront=GB")).status, 200);
  } finally {
    providerPayload = { products: [{ id: "synthetic", title: "Example" }] };
  }
});
