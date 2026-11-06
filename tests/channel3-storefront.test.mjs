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
const provider = load(await source("../src/lib/channel3.ts"), { "server-only": {}, "@/lib/channel3-storefront": storefront });
const cors = load(await source("../src/lib/mobile-web-cors.ts"), { "server-only": {} });
const catalog = load(await source("../src/lib/channel3-catalog.ts"));
const aliases = {
  "@/lib/channel3": provider,
  "@/lib/channel3-storefront": storefront,
  "@/lib/channel3-catalog": catalog,
  "@/lib/mobile-web-cors": cors,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => true },
};
const search = load(await source("../src/app/api/marketplace/search/route.ts"), aliases);
const browse = load(await source("../src/app/api/marketplace/catalog/route.ts"), aliases);
const { NextRequest } = requireNode("next/server");
const originalFetch = global.fetch;
const keys = ["CHANNEL3_API_KEY", "CHANNEL3_BASE_URL", "CHANNEL3_COUNTRY", "CHANNEL3_CURRENCY", "CHANNEL3_LANGUAGE"];
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let calls = [];
let providerPayload = { products: [{ id: "synthetic", title: "Example" }] };
global.fetch = async (url, options) => {
  calls.push({ url: String(url), body: JSON.parse(options.body) });
  return new Response(JSON.stringify(providerPayload), { status: 200, headers: { "Content-Type": "application/json" } });
};
process.env.CHANNEL3_API_KEY = "simulation-only";
process.env.CHANNEL3_BASE_URL = "https://api.example.invalid";

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
      assert.deepEqual({ ...calls[0].body.config, mode: undefined }, { country, currency, language: "en", mode: undefined });
    }
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

test("missing locale environment keeps the previous GB/GBP/en defaults", async () => {
  delete process.env.CHANNEL3_COUNTRY;
  delete process.env.CHANNEL3_CURRENCY;
  delete process.env.CHANNEL3_LANGUAGE;
  calls = [];
  const response = await post({ query: "headphones" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.storefront, "GB");
  assert.equal(body.currency, "GBP");
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
