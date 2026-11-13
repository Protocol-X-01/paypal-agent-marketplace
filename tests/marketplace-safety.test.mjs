import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/marketplace-safety.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { safeMarketplaceUrl, safeMarketplaceImageUrl, marketplaceImages, matchCurrentOffer, isFreshVerifiedOffer, VERIFIED_OFFER_LIFETIME_MS } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("accepts standard HTTPS retailer URLs", () => {
  assert.equal(safeMarketplaceUrl("https://www.shop.example/product?id=1"), "https://www.shop.example/product?id=1");
  assert.equal(safeMarketplaceUrl("https://images.shop.example:443/a.png"), "https://images.shop.example/a.png");
});

test("product images require the exact Channel3 HTTPS host", () => {
  assert.equal(safeMarketplaceImageUrl("https://cdn.trychannel3.com/items/picture.jpg?size=200"), "https://cdn.trychannel3.com/items/picture.jpg?size=200");
  assert.equal(safeMarketplaceImageUrl("https://CDN.TRYCHANNEL3.COM:443/image.jpg"), "https://cdn.trychannel3.com/image.jpg");
  for (const url of [
    "https://retailer.example/image.jpg",
    "https://cdn.trychannel3.com.evil.example/image.jpg",
    "https://other.cdn.trychannel3.com/image.jpg",
    "https://evilcdn.trychannel3.com/image.jpg",
    "https://cdn.trychannel3.com@evil.example/image.jpg",
    "https://user:pass@cdn.trychannel3.com/image.jpg",
    "https://cdn.trychannel3.com:8443/image.jpg",
    "http://cdn.trychannel3.com/image.jpg",
    "https://cdn.trychannel3.com/a\nimage.jpg",
    null,
  ]) assert.equal(safeMarketplaceImageUrl(url), null, String(url));
});

test("product images fall back to an allowed source or an empty list", () => {
  assert.deepEqual(marketplaceImages([
    { cleaned_url: "https://retailer.example/track", url: "https://cdn.trychannel3.com/backup.jpg", is_main_image: true },
    { cleaned_url: "https://cdn.trychannel3.com/main.jpg", url: "https://retailer.example/track" },
    { url: "https://retailer.example/track" },
  ]), [
    { url: "https://cdn.trychannel3.com/backup.jpg", cleaned_url: null, is_main_image: true },
    { url: "https://cdn.trychannel3.com/main.jpg", cleaned_url: null, is_main_image: false },
  ]);
  assert.deepEqual(marketplaceImages([{ url: "https://retailer.example/track" }]), []);
  assert.deepEqual(marketplaceImages(null), []);
});

test("rejects obvious local, address-literal, credentialed, and nonstandard destinations", () => {
  for (const url of [
    "http://shop.example/item", "https://user:pass@shop.example/", "https://shop.example:8443/",
    "https://localhost/", "https://shop.localhost./", "https://printer.local/", "https://service.internal/",
    "https://device.home.arpa/", "https://router.lan/", "https://192.168.1.1/", "https://127.1/",
    "https://[::1]/", "https://2130706433/", "https://shop.example/\npath", "not a URL", null,
  ]) assert.equal(safeMarketplaceUrl(url), null, String(url));
});

test("handoff requires the exact product and retailer in the refreshed response", () => {
  const items = [
    { id: "other", offers: [{ domain: "shop.example", url: "https://shop.example/wrong" }] },
    { id: "p1", offers: [{ domain: "shop.example", url: "https://www.shop.example/current", availability: "InStock" }] },
  ];
  assert.deepEqual(matchCurrentOffer(items, "p1", "shop.example"), { product: items[1], url: "https://www.shop.example/current" });
  assert.deepEqual(matchCurrentOffer(items, "missing", "shop.example"), { product: null, url: null });
  assert.deepEqual(matchCurrentOffer(items, "p1", "different.example"), { product: items[1], url: null });
  assert.deepEqual(matchCurrentOffer(items, "p1"), { product: items[1], url: null });
});

test("handoff never treats an overlong or different complete ID as an exact match", () => {
  const prefix = "a".repeat(300);
  const longProduct = { id: `${prefix}A`, offers: [{ domain: "shop.example", url: "https://shop.example/other", availability: "InStock" }] };
  const otherLongProduct = { ...longProduct, id: `${prefix}B` };
  const completeProduct = { ...longProduct, id: prefix };
  assert.deepEqual(matchCurrentOffer([longProduct], prefix, "shop.example"), { product: null, url: null });
  assert.deepEqual(matchCurrentOffer([otherLongProduct], longProduct.id, "shop.example"), { product: null, url: null });
  assert.deepEqual(matchCurrentOffer([longProduct], longProduct.id, "shop.example"), { product: null, url: null });
  assert.deepEqual(matchCurrentOffer([completeProduct], prefix, "shop.example"), { product: completeProduct, url: "https://shop.example/other" });
});

test("a matching label cannot redirect to another or unsafe host", () => {
  for (const url of ["https://other.example/product", "https://127.0.0.1/product", "https://shop.example:8443/product"]) {
    const product = { id: "p1", offers: [{ domain: "shop.example", url, availability: "InStock" }] };
    assert.deepEqual(matchCurrentOffer([product], "p1", "shop.example"), { product, url: null });
  }
});

test("multiple offers sharing a host require a fresh explicit choice", () => {
  const product = { id: "p1", offers: [
    { domain: "buy.example", url: "https://buy.example/one", availability: "InStock" },
    { domain: "buy.example", url: "https://buy.example/two", availability: "InStock" },
  ] };
  assert.deepEqual(matchCurrentOffer([product], "p1", "buy.example"), { product, url: null });
});

test("an unpinned handoff selects only a safe reported-in-stock offer for the exact product", () => {
  const product = { id: "p1", offers: [
    { domain: "old.example", url: "https://old.example/item", availability: "OutOfStock" },
    { domain: "store.example", url: "https://other.example/item", availability: "InStock" },
    { domain: "store.example", url: "https://store.example/current", availability: "InStock" },
  ] };
  assert.deepEqual(matchCurrentOffer([product], "p1", undefined, undefined, true), { product, url: "https://store.example/current" });
  assert.deepEqual(matchCurrentOffer([product], "other", undefined, undefined, true), { product: null, url: null });
  assert.deepEqual(matchCurrentOffer([product], "p1"), { product, url: null });
  const unavailable = { id: "p2", offers: product.offers.slice(0, 2) };
  assert.deepEqual(matchCurrentOffer([unavailable], "p2", undefined, undefined, true), { product: unavailable, url: null });
});

test("verified links expire after five minutes and cannot survive a clock rollback", () => {
  const verifiedAt = 1_000_000;
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt), true);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt + VERIFIED_OFFER_LIFETIME_MS - 1), true);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt + VERIFIED_OFFER_LIFETIME_MS), false);
  assert.equal(isFreshVerifiedOffer(verifiedAt, verifiedAt - 1), false);
});
