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
const { readCollections, parseProduct, serializeCollections, needsSavedIdentityReview } = await load("../src/lib/marketplace-storage.ts", {
  "./marketplace-safety": safety,
  "./storefront-storage": storefront,
});

test("product IDs remain complete and opaque within the app boundary", () => {
  for (const id of ["x", "a".repeat(128), "a".repeat(299), "a".repeat(300), "urn:provider/item+1", "product with spaces"]) {
    assert.equal(parseProduct({ id, title: "Fictional product", offers: [] }).id, id);
  }
  for (const id of ["", "  ", "a\nb", "a\u007fb", "a\u0085b", "a".repeat(301), null, 123]) {
    assert.equal(parseProduct({ id, title: "Fictional product", offers: [] }), null, String(id));
  }
  const prefix = "a".repeat(300);
  assert.equal(parseProduct({ id: `${prefix}A`, title: "One" }), null);
  assert.equal(parseProduct({ id: `${prefix}B`, title: "Two" }), null);
});

test("ambiguous legacy snapshots survive unrelated list edits without being normalized", () => {
  const legacyItem = {
    product: { id: "x".repeat(300), title: "Old bag", images: [{ url: "https://old.example/image", extra: "retain" }], offers: [], extra: "retain too" },
    retrievedAt: "then", savedAt: "before", storefront: "US", oldItemField: { keep: true },
  };
  const original = { version: 1, collections: [{ id: "old", name: "Older", createdAt: "", items: [legacyItem] }, { id: "other", name: "Other", createdAt: "", items: [] }] };
  const collections = readCollections(JSON.stringify(original));
  assert.equal(needsSavedIdentityReview(collections[0].items[0]), true);
  collections[1].name = "Renamed";
  const written = JSON.parse(serializeCollections(collections));
  assert.deepEqual(written.collections[0].items[0], legacyItem);
  assert.equal(written.collections[1].name, "Renamed");
  assert.equal(needsSavedIdentityReview(readCollections(JSON.stringify(written))[0].items[0]), true);
});

test("complete provenance distinguishes new boundary-length IDs from older snapshots", () => {
  const id = "x".repeat(300);
  const item = { product: { id, title: "Fresh bag", offers: [] }, retrievedAt: "", savedAt: "", storefront: "GB", identitySource: "complete-id-v1" };
  const collections = readCollections(JSON.stringify({ version: 1, collections: [{ id: "new", name: "New", items: [item] }] }));
  assert.equal(needsSavedIdentityReview(collections[0].items[0]), false);
  assert.equal(JSON.parse(serializeCollections(collections)).collections[0].items[0].identitySource, "complete-id-v1");
});

test("unrepresentable or colliding collection identifiers block the whole read", () => {
  const prefix = "c".repeat(120);
  const savedItem = { product: { id: "p".repeat(300), title: "Legacy item", offers: [] }, savedAt: "before" };
  const list = (id, items = []) => ({ id, name: "Fictional list", items });
  const cases = [
    [list(`${prefix}A`, [savedItem]), list(`${prefix}B`)],
    [list(`${prefix}A`)],
    [list("duplicate"), list("duplicate", [savedItem])],
    [list("")],
    [list("   ")],
    [list("line\nbreak")],
    [list("bad\ud800")],
    [list(null)],
    [...Array.from({ length: 12 }, (_, index) => list(`normal-${index}`)), list("normal-0")],
  ];
  for (const collections of cases) {
    const raw = JSON.stringify({ version: 1, collections });
    assert.throws(() => readCollections(raw), /saved collection identifier needs recovery/i);
    assert.equal(JSON.stringify({ version: 1, collections }), raw, "the caller's raw JSON stays untouched");
  }
});

test("hidden, malformed or duplicate saved rows block the complete read", () => {
  const item = (id) => ({ product: { id, title: "Fictional item", offers: [] }, savedAt: "before" });
  const list = (id, items = []) => ({ id, name: "Fictional list", items });
  const cases = [
    Array.from({ length: 13 }, (_, index) => list(`list-${index}`, [item(`item-${index}`)])),
    [list("valid", Array.from({ length: 41 }, (_, index) => item(`item-${index}`)))],
    [{ id: "valid", name: "Fictional", items: null }],
    [{ id: "valid", name: " ", items: [] }],
    [{ id: "valid", name: "n".repeat(41), items: [] }],
    [null],
    [list("valid", [null])],
    [list("valid", [{ product: null }])],
    [list("valid", [{ product: { id: "item", title: null } }])],
    [list("valid", [item("duplicate"), item("duplicate")])],
    [list("valid", [item("p".repeat(300)), item("p".repeat(300))])],
  ];
  for (const collections of cases) {
    const raw = JSON.stringify({ version: 1, collections });
    assert.throws(() => readCollections(raw), /saved (?:collection|product).*needs? recovery/i);
  }
});

test("ordinary older items and collection fields survive unrelated edits and moves", () => {
  const rawOffer = { url: "https://old.example/offer", domain: "old.example", availability: "InStock", price: { price: 10, currency: "GBP" } };
  const item = {
    product: { id: "ordinary", title: "Old product", offers: [rawOffer], oldProductField: { keep: true } },
    retrievedAt: "then", savedAt: "before", storefront: "GB", oldItemField: "retain",
  };
  const first = { id: "first", name: "  Original list  ", createdAt: "before", items: [item], oldListField: { keep: true } };
  const second = { id: "second", name: "Other", createdAt: "before", items: [] };
  const collections = readCollections(JSON.stringify({ version: 1, collections: [first, second] }));
  const noSavedHandoff = (stored) => {
    const visible = readCollections(stored).flatMap((list) => list.items).find((saved) => saved.product.id === "ordinary");
    assert.ok(visible);
    assert.equal(visible.product.offers[0].url, null);
    assert.equal(safety.matchCurrentOffer([visible.product], "ordinary", "old.example").url, null);
  };
  noSavedHandoff(serializeCollections(collections));
  collections[1].name = "Edited";
  let saved = JSON.parse(serializeCollections(collections));
  assert.deepEqual(saved.collections[0], first);
  noSavedHandoff(JSON.stringify(saved));
  const moved = collections.map((list) => list.id === "first" ? { ...list, items: [] } : { ...list, items: [collections[0].items[0]] });
  saved = JSON.parse(serializeCollections(moved));
  assert.deepEqual(saved.collections[1].items[0], item);
  assert.deepEqual(saved.collections[0], { ...first, items: [] });
  noSavedHandoff(JSON.stringify(saved));
});

test("unknown top-level fields are kept in the original JSON instead of dropped on save", () => {
  const raw = JSON.stringify({ version: 1, collections: [], legacyData: { keep: true } });
  for (const invalid of [raw, "", "{", JSON.stringify({ version: 2, collections: [] })]) {
    assert.throws(() => readCollections(invalid), /saved collections need recovery/i);
  }
  assert.deepEqual(readCollections(null), []);
});

test("ordinary collection IDs, including the full boundary, remain distinct and unchanged", () => {
  const items = [{ product: { id: "p".repeat(300), title: "Legacy item", offers: [], extra: "keep" }, savedAt: "before" }];
  const ids = ["ordinary-list", "c".repeat(120), "😀".repeat(60), " opaque id "];
  const raw = JSON.stringify({ version: 1, collections: ids.map((id, index) => ({ id, name: `List ${index}`, items: index === 0 ? items : [] })) });
  const collections = readCollections(raw);
  assert.deepEqual(collections.map((list) => list.id), ids);
  collections[1].name = "Renamed";
  const saved = JSON.parse(serializeCollections(collections));
  assert.deepEqual(saved.collections.map((list) => list.id), ids);
  assert.deepEqual(saved.collections[0].items, items);
});

test("unsupported stored IDs fail the complete read, even beyond display limits", () => {
  const good = (id) => ({ product: { id, title: "Saved", offers: [] } });
  const list = (id, items) => ({ id, name: id, items });
  for (const collections of [
    [list("old", [good("x".repeat(301))])],
    [list("old", [good("bad\nid")])],
    [list("old", [...Array.from({ length: 40 }, (_, index) => good(`id-${index}`)), good("x".repeat(301))])],
    [...Array.from({ length: 12 }, (_, index) => list(`list-${index}`, [])), list("hidden", [good("x".repeat(301))])],
    [list("old", [...Array.from({ length: 40 }, (_, index) => good(`id-${index}`)), good("x".repeat(300))])],
    [list("old", []), list("old", [good("x".repeat(300))])],
    [...Array.from({ length: 12 }, (_, index) => list(`list-${index}`, [])), list("hidden", [good("x".repeat(300))])],
  ]) {
    assert.throws(() => readCollections(JSON.stringify({ version: 1, collections })), /identifier needs recovery/);
  }
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
 assert.equal(parse({url:"https://different.example/item"}).url,null);
 for (const domain of ["https://bestbuy.com", "bestbuy.com@evil.example", "bestbuy.com/path", "bestbuy.com:443", "bestbuy.com\n", "127.0.0.1", "router.local", "bad..example", "-bad.example"]) {
  assert.equal(parse({domain}).domain,"buy.trychannel3.com");assert.equal(parse({domain}).url,tracked);
 }
 for (const url of ["javascript:alert(1)","https://127.0.0.1/item","https://user:secret@bestbuy.com/item"]) assert.equal(parse({url}).url,null);
});
