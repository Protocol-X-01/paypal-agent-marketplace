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
  "@/lib/channel3-catalog": { ...catalog, findChannel3CuratedRetailer: id => id === "cvs" ? { id, title: "CVS", websiteId: "cvs.com" } : undefined },
  "@/lib/mobile-web-cors": cors,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => true },
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

delete process.env.CHANNEL3_COLLECTION_ID;

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

test("catalog expands to24 real products and wraps exact-context provider pagination", async()=>{
 locale("GB","GBP","en");calls=[];providerPayload={products:Array.from({length:24},(_,i)=>({id:`p${i}`,title:`Product ${i}`})),next_page_token:"provider-next"};
 const response=await get("section=audio&retailer=cvs&storefront=GB");assert.equal(response.status,200);const body=await response.json();assert.equal(body.products.length,24);assert.equal(body.limit,24);assert.equal(body.retailer,"cvs");assert.notEqual(body.nextPageToken,"provider-next");assert.equal(calls[0].body.limit,24);assert.deepEqual(calls[0].body.filters.website_ids,["cvs.com"]);
 calls=[];providerPayload={products:[],next_page_token:null};const second=await get(`section=audio&retailer=cvs&storefront=GB&pageToken=${encodeURIComponent(body.nextPageToken)}`);assert.equal(second.status,200);assert.equal(calls[0].body.page_token,"provider-next");assert.equal((await second.json()).nextPageToken,null);
 for(const query of ["section=travel&retailer=cvs&storefront=GB","section=audio&retailer=cvs&storefront=US","section=audio&storefront=GB","section=audio&retailer=cvs&storefront=GB&limit=12"]){calls=[];assert.equal((await get(`${query}&pageToken=${encodeURIComponent(body.nextPageToken)}`)).status,400);assert.equal(calls.length,0)}
});
test("retailer-only browsing and malformed query rejection never invent provider filters",async()=>{
 providerPayload={products:[]};calls=[];const response=await get("retailer=cvs&storefront=US&limit=12");assert.equal(response.status,200);assert.equal((await response.json()).section,null);assert.equal(calls[0].body.filters.category_ids,undefined);
 for(const query of ["", "retailer=unknown", "section=audio&section=travel", "retailer=cvs&retailer=cvs", "section=audio&limit=25", "section=audio&limit=012", "section=audio&other=1", "section=audio&pageToken=", "section=audio&pageToken="+"a".repeat(6145)]){calls=[];assert.equal((await get(query)).status,400,query.slice(0,60));assert.equal(calls.length,0)}
});
test("catalog cursor expiry, tampering and provider oversized tokens fail closed",async()=>{
 const binding="catalog-test";const token=provider.encodeCatalogPageToken("next",binding,1000);assert.equal(provider.decodeCatalogPageToken(token,binding,1001),"next");assert.equal(provider.decodeCatalogPageToken(token,binding,901000),null);assert.equal(provider.decodeCatalogPageToken(token+"x",binding,1001),null);assert.throws(()=>provider.encodeCatalogPageToken("x".repeat(4097),binding));
});
test("commission remains offer-specific decimal fraction; malformed or missing is unknown",async()=>{
 const values=[0,0.05,0.5,1,null,-1,1.01,"5%",undefined];providerPayload={products:[{id:"p",title:"Product",offers:values.map(value=>({domain:"example.test",max_commission_rate:value}))}]};const response=await get("section=audio");assert.equal(response.status,200);const offers=(await response.json()).products[0].offers;assert.deepEqual(offers.map(o=>o.max_commission_rate),[0,0.05,0.5,1,null,null,null,null,undefined]);
});
test("search accepts24 and rejects25",async()=>{providerPayload={products:[]};assert.equal((await post({query:"headphones",limit:24})).status,200);assert.equal(calls.at(-1).body.limit,24);assert.equal((await post({query:"headphones",limit:25})).status,400)});

test("configured collection scopes browse/search and invalidates old cursor without fallback",async()=>{
 process.env.CHANNEL3_COLLECTION_ID="collection-fixture-a";providerPayload={products:[],next_page_token:"next"};calls=[];
 const response=await get("section=audio&storefront=GB");assert.equal(response.status,200);const token=(await response.json()).nextPageToken;assert.equal(calls[0].body.config.collection_id,"collection-fixture-a");await post({query:"headphones",limit:24});assert.equal(calls.at(-1).body.config.collection_id,"collection-fixture-a");
 process.env.CHANNEL3_COLLECTION_ID="collection-fixture-b";calls=[];assert.equal((await get(`section=audio&storefront=GB&pageToken=${encodeURIComponent(token)}`)).status,400);assert.equal(calls.length,0);
 for(const id of ["", "bad value", "x".repeat(129)]){process.env.CHANNEL3_COLLECTION_ID=id;calls=[];assert.equal((await get("section=audio")).status,503);assert.equal((await post({query:"headphones"})).status,503);assert.equal(calls.length,0)}
 delete process.env.CHANNEL3_COLLECTION_ID;
});
