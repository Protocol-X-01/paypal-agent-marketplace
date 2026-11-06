import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
async function load(file, aliases = {}) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nodeRequire(name);
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const safety = await load("../src/lib/marketplace-safety.ts");
const storefront = await load("../src/lib/storefront-storage.ts");
const { readCollections, parseProduct } = await load("../src/lib/marketplace-storage.ts", {
  "./marketplace-safety": safety,
  "./storefront-storage": storefront,
});

test("editing saved lists preserves legacy image data without loading untrusted images", () => {
  const legacyImages = [
    { url: "https://retailer.example/old.jpg", cleaned_url: null, is_main_image: true, extra: "preserve" },
    { url: "https://cdn.trychannel3.com/safe.jpg", is_main_image: false },
    { url: "https://cdn.trychannel3.com.evil.example/tracking.jpg" },
  ];
  const original = { version: 1, collections: [{ id: "saved", name: "Before", createdAt: "", items: [{
    product: { id: "p1", title: "Product", description: null, images: legacyImages, offers: [] },
    savedAt: "", retrievedAt: "", storefront: "GB",
  }] }] };
  const collections = readCollections(JSON.stringify(original));
  assert.deepEqual(collections[0].items[0].product.images, legacyImages);
  assert.equal(safety.primaryMarketplaceImage(collections[0].items[0].product.images), "https://cdn.trychannel3.com/safe.jpg");
  collections[0].name = "After";
  const savedAgain = JSON.parse(JSON.stringify({ version: 1, collections }));
  assert.deepEqual(savedAgain.collections[0].items[0].product.images, legacyImages);
  assert.equal(safety.primaryMarketplaceImage([{ url: "https://retailer.example/old.jpg" }]), null);
});

test('commission rates retain valid fractions and saved snapshots never claim current rates',async()=>{
 const {parseProduct,snapshotProduct}=await load('../src/lib/marketplace-storage.ts',{'./marketplace-safety':safety,'./storefront-storage':storefront});
 for(const rate of [0,0.05,1,-1,1.1,'0.05',null]){
  const parsed=parseProduct({id:'p',title:'Fictional',offers:[{url:'https://shop.example/p',availability:'InStock',price:{price:5,currency:'GBP'},max_commission_rate:rate}]});
  assert.equal(parsed.offers[0].max_commission_rate,typeof rate==='number'&&rate>=0&&rate<=1?rate:null);assert.equal(snapshotProduct(parsed).offers[0].max_commission_rate,null);
 }
});


test("retailer metadata stays separate from validated handoff destinations", () => {
 const tracked = "https://buy.trychannel3.com/example?offer=1";
 const offer = {url:tracked,domain:"www.BestBuy.com",price:{price:42,currency:"USD"},availability:"InStock"};
 const parse = (extra) => parseProduct({id:"p1",title:"Example",offers:[{...offer,...extra}]},"USD").offers[0];
 assert.equal(parse({}).domain,"bestbuy.com");assert.equal(parse({}).url,tracked);
 for (const domain of ["https://bestbuy.com", "bestbuy.com@evil.example", "bestbuy.com/path", "bestbuy.com:443", "bestbuy.com\n", "127.0.0.1", "router.local", "bad..example", "-bad.example"]) {
  assert.equal(parse({domain}).domain,"buy.trychannel3.com");assert.equal(parse({domain}).url,tracked);
 }
 for (const url of ["javascript:alert(1)","https://127.0.0.1/item","https://user:secret@bestbuy.com/item"]) assert.equal(parse({url}).url,null);
});
