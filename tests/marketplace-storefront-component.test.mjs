import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const cjs = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module in storefront test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}

const catalogMetadata = await load("../src/lib/channel3-catalog.ts");
const storefront = await load("../src/lib/channel3-storefront.ts");
const priceRange = await load("../src/lib/marketplace-price-range.ts");
const safety = await load("../src/lib/marketplace-safety.ts");
const savedStorefront = await load("../src/lib/storefront-storage.ts");
const collectionLock = await load("../src/lib/collection-lock.ts");
const draftMemory = await load("../src/lib/customer-shopping-draft-memory.ts");
const storage = await load("../src/lib/marketplace-storage.ts", {
  "./marketplace-safety": safety,
  "./storefront-storage": savedStorefront,
});
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function nodes(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}
function byId(tree, id) {
  const result = nodes(tree).find((node) => node.props?.id === id);
  assert.ok(result, `Expected element ${id}`);
  return result;
}
function button(tree, label) {
  const result = nodes(tree).find((node) => node.type === "button" && text(node.props.children).includes(label));
  assert.ok(result, `Expected button containing ${label}`);
  return result;
}
function politeStatuses(tree) {
  return nodes(tree).filter((node) => node.props?.role === "status" && node.props?.["aria-live"] === "polite");
}
function product(currency, title = "Example headphones") {
  return { id: "example-product", title, images: [], offers: [{
    url: "https://shop.example/item", domain: "shop.example", availability: "InStock",
    price: { price: 120, currency },
  }] };
}
function response(country, products, overrides = {}) {
  return { provider: "Channel3", storefront: country, currency: country === "GB" ? "GBP" : "USD", retrievedAt: "2026-11-06T00:00:00Z", products, priceRange: null, ...overrides };
}

async function createMarketplace(initialStorage = {}, options = {}) {
  const originals = { window: globalThis.window, localStorage: globalThis.localStorage };
  // Existing UK offer fixtures restore a saved UK choice; null represents a new browser.
  const values = new Map(Object.entries({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("GB"), ...initialStorage }));
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  globalThis.window = {
    isSecureContext: options.secure !== false,
    navigator: { locks: { request: (_name, _options, callback) => options.lockRequest ? options.lockRequest(callback) : Promise.resolve(callback({ name: "test", mode: "exclusive" })) } },
    location: { search: "" },
    open: options.openWindow ?? (() => null),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatchEvent: (event) => { if (!privateReady) return false; for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return true; },
  };
  const slots = [];
  const pendingEffects = [];
  const calls = [];
  let privateReady = true;
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      const changed = !previous || !dependencies || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]));
      if (changed) pendingEffects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: fn() };
      });
    },
  };
  const Component = (await load("../src/app/components/marketplace.tsx", {
    react: hooks,
    "react/jsx-runtime": jsx,
    "../../../packages/ai-insights/ui/InsightPanel": { __esModule: true, default: "InsightPanel" },
    "@/lib/channel3-storefront": storefront,
    "@/lib/channel3-catalog": catalogMetadata,
    "@/lib/marketplace-price-range": priceRange,
    "@/lib/marketplace-request": {
      MarketplaceRequestTimeoutError: class MarketplaceRequestTimeoutError extends Error {},
      fetchMarketplaceJson: (url, options, signal) => new Promise((resolve, reject) => calls.push({ url, options, signal, resolve, reject })),
    },
    "@/lib/marketplace-safety": safety,
    "@/lib/marketplace-storage": storage,
    "@/lib/collection-lock": collectionLock,
    "@/lib/customer-shopping-draft-memory": draftMemory,
    "@/lib/portfolio-input": { LOCAL_DATA_RESET_SIGNAL: "paypal-markets-local-data-reset-signal-v1" },
    "./marketplace.module.css": { __esModule: true, default: {} },
    "./customer-session": {
      usePrivateDataScope: () => ({ ready: privateReady, storage: globalThis.localStorage, events: globalThis.window, label: "Guest test data" }),
      useShoppingDraftMemory: () => ({ lease: options.lease ?? null, shoppingDraft: options.shoppingDraft ?? { read: () => null, write: () => "retained" } }),
    },
  })).default;
  function render() {
    cursor = 0;
    const tree = Component();
    while (pendingEffects.length) pendingEffects.shift()();
    return tree;
  }
  function flushImmediateTimers() {
    for (const [id, timer] of [...timers]) if (timer.delay === 0) { timers.delete(id); timer.fn(); }
  }
  function setStorefront(value) {
    byId(render(), "shopping-storefront").props.onChange({ currentTarget: { value } });
  }
  function search(query) {
    byId(render(), "marketplace-query").props.onChange({ target: { value: query } });
    const form = nodes(render()).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "marketplace-query"));
    assert.ok(form, "Expected search form");
    return form.props.onSubmit({ preventDefault() {} });
  }
  function assistSearch(query) {
    byId(render(), "marketplace-query").props.onChange({ target: { value: query } });
    return button(render(), "Help me find").props.onClick();
  }
  function reply(index, body, status = 200) {
    const url = new URL(calls[index].url, "http://localhost:3000");
    const exactProduct = url.pathname.match(/^\/api\/marketplace\/products\/([^/]+)$/);
    if (exactProduct && status !== 404) {
      const productId = decodeURIComponent(exactProduct[1]);
      body = {
        provider: "Channel3",
        storefront: url.searchParams.get("storefront"),
        currency: url.searchParams.get("storefront") === "GB" ? "GBP" : "USD",
        retrievedAt: body.retrievedAt,
        product: body.product ?? body.products?.find((item) => item.id === productId) ?? body.products?.[0],
      };
    }
    if (calls[index].url === "/api/marketplace/search" && body.query === undefined) {
      body = { ...body, query: JSON.parse(calls[index].options.body).query };
    }
    calls[index].resolve({ response: { ok: status >= 200 && status < 300, status }, body });
  }
  function close() {
    for (const value of slots) if (typeof value?.cleanup === "function") value.cleanup();
    if (originals.window === undefined) delete globalThis.window; else globalThis.window = originals.window;
    if (originals.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originals.localStorage;
  }
  render();
  flushImmediateTimers();
  const initialTree = render();
  if ((options.mode ?? "search") === "search") {
    button(initialTree, "Search products").props.onClick();
  }
  render();
  function dispatchStorage(key) {
    for (const listener of [...(listeners.get("storage") ?? [])]) listener({ key });
  }
  return { render, search, assistSearch, setStorefront, setPrivateReady: (ready) => { privateReady = ready; render(); }, reply, calls, values, listeners, dispatchStorage, close };
}

test("first-run shopping uses US while saved UK and display-currency preferences remain intact", async () => {
  const key = storefront.STOREFRONT_STORAGE_KEY;
  const displayKey = "paypal-markets-display-currency-v1";
  for (const [saved, expected, currency] of [[null, "US", "USD"], [JSON.stringify("GB"), "GB", "GBP"]]) {
    const app = await createMarketplace({ [key]: saved, [displayKey]: JSON.stringify("EUR") });
    try {
      const tree = app.render();
      assert.equal(byId(tree, "shopping-storefront").props.value, expected);
      assert.match(text(byId(tree, "shopping-storefront")), /United States · USDUnited Kingdom · GBP/);
      assert.equal(app.values.get(key), saved, "Loading a preference must not rewrite it");
      assert.equal(app.values.get(displayKey), JSON.stringify("EUR"));
      const pending = app.search("headphones");
      assert.equal(JSON.parse(app.calls[0].options.body).storefront, expected);
      app.reply(0, response(expected, [product(currency, "Selected storefront headphones")]));
      await pending;
      assert.match(text(app.render()), /Selected storefront headphones/);
    } finally { app.close(); }
  }
});

test("Help me find uses Channel3 agentic search and keeps that mode for later pages", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US") });
  const brief = "Please help me find comfortable over-ear headphones for travel under $150";
  try {
    const pending = app.assistSearch(brief);
    assert.deepEqual(JSON.parse(app.calls[0].options.body), { query: brief, limit: 24, storefront: "US", mode: "agentic" });
    app.reply(0, response("US", [product("USD", "Travel headphones")], { searchMode: "agentic", nextPageToken: "agentic-next" }));
    await pending;

    let tree = app.render();
    assert.match(text(tree), /CHANNEL3 ASSISTED FIND/);
    assert.match(text(tree), /finish checkout with the retailer/i);
    button(tree, "Load more search results").props.onClick();
    assert.equal(JSON.parse(app.calls[1].options.body).mode, "agentic");
    const secondPageItem = product("USD", "More travel headphones");
    secondPageItem.id = "second-travel-headphones";
    app.reply(1, response("US", [secondPageItem], { searchMode: "agentic", nextPageToken: null }));
    await tick();
    tree = app.render();
    assert.match(text(tree), /More travel headphones/);
    assert.match(text(tree), /CHANNEL3 ASSISTED FIND/);
  } finally { app.close(); }
});

test("Help me find explains when Channel3 exceeds the provider deadline", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US") });
  try {
    const pending = app.assistSearch("Please help me find comfortable travel headphones");
    app.reply(0, { error: "Product search took too long. Please try again." }, 504);
    await pending;
    assert.match(text(app.render()), /Product search took too long\. Please try again\./);
  } finally { app.close(); }
});

test("US offer cards mark verified retailer PayPal policy without implying item eligibility", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US") });
  try {
    const pending = app.search("headphones");
    const listed = product("USD", "Best Buy headphones");
    listed.id = "bestbuy-headphones";
    listed.offers[0].domain = "bestbuy.com";
    const unverified = product("USD", "CVS headphones");
    unverified.id = "cvs-headphones";
    unverified.offers[0].domain = "cvs.com";
    app.reply(0, response("US", [listed, unverified]));
    await pending;

    const tree = app.render();
    const policyBadges = nodes(tree).filter((node) => node.props?.["aria-label"] === "PayPal is listed by this US retailer; exact seller, item, and order eligibility may vary.");
    assert.equal(policyBadges.length, 1, "only the retailer with verified public PayPal policy gets a marker");
    assert.match(text(tree), /PayPal\* listed by a US retailer; exact seller, item, and order eligibility may vary\./);
    assert.match(text(tree), /PayPal\* reflects a published US retailer policy, not item-level eligibility/);
  } finally { app.close(); }
});

test("browse and search swap their result views in place", async () => {
  const app = await createMarketplace({}, { mode: "browse" });
  try {
    let tree = app.render();
    assert.ok(byId(tree, "curated-catalog-title"));
    assert.equal(nodes(tree).some((node) => node.props?.id === "marketplace-query"), false);

    button(tree, "Search products").props.onClick();
    tree = app.render();
    assert.equal(button(tree, "Search products").props["aria-pressed"], true);
    assert.equal(nodes(tree).some((node) => node.props?.id === "curated-catalog-title"), false);
    assert.ok(byId(tree, "marketplace-query"));

    const pending = app.search("headphones");
    app.reply(0, response("GB", [product("GBP", "Current headphones")]));
    await pending;
    tree = app.render();
    assert.match(text(tree), /Current headphones/);

    button(tree, "Browse categories").props.onClick();
    tree = app.render();
    assert.equal(button(tree, "Browse categories").props["aria-pressed"], true);
    assert.equal(nodes(tree).some((node) => node.props?.id === "marketplace-query"), false);
    assert.ok(byId(tree, "curated-catalog-title"));
    assert.doesNotMatch(text(tree), /Current headphones/);

    button(tree, "Search products").props.onClick();
    tree = app.render();
    assert.match(text(tree), /Current headphones/);
    assert.equal(nodes(tree).some((node) => node.props?.id === "curated-catalog-title"), false);
  } finally { app.close(); }
});

test("an unavailable listing redirects a deliberate click only after a similar offer is freshly checked", async () => {
  const originalDocument = globalThis.document;
  let redirectedUrl = null;
  const handoff = {
    closed: false,
    opener: null,
    document: { title: "" },
    location: { replace: (url) => { redirectedUrl = url; } },
    close() { this.closed = true; },
  };
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: null }, { openWindow: () => handoff });
  globalThis.window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.document = {
    getElementById: () => ({ scrollIntoView() {}, querySelector: () => ({ focus() {} }) }),
  };
  try {
    const pendingSearch = app.search("headphones");
    app.reply(0, response("US", [product("USD", "Exact headphones")]));
    await pendingSearch;

    assert.match(text(app.render()), /Unavailable\? Find alternatives/);

    const productButton = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"] === "Check and open Exact headphones at shop.example");
    assert.ok(productButton, "The product action checks its current offer before handoff");
    productButton.props.onClick();
    assert.match(app.calls[1].url, /^\/api\/marketplace\/products\/example-product\?storefront=US$/);

    const soldOut = product("USD", "Exact headphones");
    soldOut.offers[0].availability = "OutOfStock";
    app.reply(1, { provider: "Channel3", storefront: "US", currency: "USD", retrievedAt: "2026-11-10T06:00:00Z", product: soldOut });
    await tick();
    assert.match(app.calls[2].url, /^\/api\/marketplace\/products\/example-product\/similar\?storefront=US$/);
    app.reply(2, {
      provider: "Channel3",
      productId: "example-product",
      storefront: "US",
      currency: "USD",
      retrievedAt: "2026-11-10T06:01:00Z",
      products: [{ ...product("USD", "Comparable headphones"), id: "alternative-1" }],
    });
    await tick();
    assert.match(app.calls[3].url, /^\/api\/marketplace\/products\/alternative-1\?storefront=US$/);
    const currentAlternative = { ...product("USD", "Comparable headphones"), id: "alternative-1" };
    currentAlternative.offers[0].url = "https://shop.example/comparable-current";
    app.reply(3, { retrievedAt: "2026-11-10T06:02:00Z", product: currentAlternative });
    await tick();

    const updated = text(app.render());
    assert.match(updated, /Sorry, this item isn’t currently reported in stock\. We opened Comparable headphones/);
    assert.match(updated, /Comparable headphones/);
    assert.match(updated, /Alternatives are reported in stock by Channel3/);
    assert.match(updated, /We opened Comparable headphones at shop\.example/);
    assert.equal(redirectedUrl, currentAlternative.offers[0].url, "The clicked handoff redirects only after the exact similar-item listing is refreshed");
    assert.equal(handoff.closed, false, "A valid replacement keeps the user-opened handoff tab");
  } finally {
    app.close();
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});

test("a confirmed missing listing moves directly to alternatives without searching for the original", async () => {
  const originalDocument = globalThis.document;
  let redirectedUrl = null;
  const handoff = { closed: false, opener: null, document: { title: "" }, location: { replace: (url) => { redirectedUrl = url; } }, close() { this.closed = true; } };
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: null }, { openWindow: () => handoff });
  globalThis.window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.document = { getElementById: () => ({ scrollIntoView() {}, querySelector: () => ({ focus() {} }) }) };
  try {
    const pendingSearch = app.search("headphones");
    app.reply(0, response("US", [product("USD", "Exact headphones")]));
    await pendingSearch;
    const productButton = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"] === "Check and open Exact headphones at shop.example");
    assert.ok(productButton);
    productButton.props.onClick();
    app.reply(1, { error: "No current listing.", code: "PRODUCT_UNAVAILABLE" }, 404);
    await tick();
    assert.match(app.calls[2].url, /^\/api\/marketplace\/products\/example-product\/similar\?storefront=US$/);
    app.reply(2, {
      provider: "Channel3", productId: "example-product", storefront: "US", currency: "USD", retrievedAt: "2026-11-10T06:01:00Z",
      products: [{ ...product("USD", "Comparable headphones"), id: "alternative-1" }],
    });
    await tick();
    assert.match(app.calls[3].url, /^\/api\/marketplace\/products\/alternative-1\?storefront=US$/);
    const freshAlternative = { ...product("USD", "Comparable headphones"), id: "alternative-1" };
    freshAlternative.offers[0].url = "https://shop.example/comparable-current";
    app.reply(3, { retrievedAt: "2026-11-10T06:02:00Z", product: freshAlternative });
    await tick();
    assert.equal(app.calls.length, 4, "The confirmed missing product must not be searched again");
    assert.equal(redirectedUrl, freshAlternative.offers[0].url);
    assert.match(text(app.render()), /Comparable headphones/);
  } finally {
    app.close();
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});

test("an unavailable listing keeps the handoff in Shop when similar stock cannot be refreshed", async () => {
  const originalDocument = globalThis.document;
  let redirectedUrl = null;
  const handoff = { closed: false, opener: null, document: { title: "" }, location: { replace: (url) => { redirectedUrl = url; } }, close() { this.closed = true; } };
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: null }, { openWindow: () => handoff });
  globalThis.window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.document = { getElementById: () => ({ scrollIntoView() {}, querySelector: () => ({ focus() {} }) }) };
  try {
    const pendingSearch = app.search("headphones");
    app.reply(0, response("US", [product("USD", "Exact headphones")]));
    await pendingSearch;
    nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"] === "Check and open Exact headphones at shop.example").props.onClick();
    const soldOut = product("USD", "Exact headphones");
    soldOut.offers[0].availability = "OutOfStock";
    app.reply(1, { provider: "Channel3", storefront: "US", currency: "USD", retrievedAt: "2026-11-10T06:00:00Z", product: soldOut });
    await tick();
    app.reply(2, {
      provider: "Channel3", productId: "example-product", storefront: "US", currency: "USD", retrievedAt: "2026-11-10T06:01:00Z",
      products: [{ ...product("USD", "Comparable headphones"), id: "alternative-1" }],
    });
    await tick();
    const soldOutAlternative = { ...product("USD", "Comparable headphones"), id: "alternative-1" };
    soldOutAlternative.offers[0].availability = "OutOfStock";
    app.reply(3, { retrievedAt: "2026-11-10T06:02:00Z", product: soldOutAlternative });
    await tick();

    assert.equal(redirectedUrl, null, "A recommendation’s earlier in-stock report is not enough to open it");
    assert.equal(handoff.closed, true);
    assert.match(text(app.render()), /couldn’t freshly confirm a similar replacement/i);
  } finally {
    app.close();
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});

test("retailer buttons verify the exact product before opening the handoff tab", async () => {
  const handoff = { closed: false, opener: {}, document: { title: "" }, location: { destination: null, replace(url) { this.destination = url; } }, close() { this.closed = true; } };
  const app = await createMarketplace({}, { openWindow: () => handoff });
  try {
    const initial = product("GBP", "Exact headphones");
    const other = { ...product("GBP", "Another headphone"), id: "other" };
    const pending = app.search("headphones");
    app.reply(0, response("GB", [initial, other]));
    await pending;

    const tree = app.render();
    const link = nodes(tree).find((node) => node.type === "button" && node.props["aria-label"] === "Check and open Exact headphones at shop.example");
    assert.ok(link, "The product name starts a verified retailer handoff");
    link.props.onClick();
    assert.equal(app.calls.length, 2, "Tapping the name requests an exact-product refresh");
    assert.match(app.calls[1].url, /^\/api\/marketplace\/products\/example-product\?storefront=GB$/);
    assert.equal(handoff.location.destination, null, "The stale offer is not opened before refresh completes");
    const current = product("GBP", "Exact headphones");
    current.offers[0].price.price = 135;
    current.offers[0].url = "https://buy.trychannel3.com/offer?offer=current";
    app.reply(1, response("GB", [current]));
    await tick();
    const updated = app.render();
    assert.match(text(updated), /Another headphone/);
    assert.match(text(updated), /Offers rechecked/);
    assert.equal(handoff.location.destination, current.offers[0].url);
    assert.equal(app.calls.length, 2);
  } finally { app.close(); }
});

test("a retailer-specific handoff redirects to the same item at a freshly reported alternate store", async () => {
  const handoff = { closed: false, opener: {}, document: { title: "" }, location: { destination: null, replace(url) { this.destination = url; } }, close() { this.closed = true; } };
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: null }, { openWindow: () => handoff });
  try {
    const initial = product("USD", "Exact headphones");
    const alternate = { ...initial.offers[0], domain: "other.example", url: "https://other.example/exact-headphones", price: { price: 125, currency: "USD" } };
    initial.offers = [...initial.offers, alternate];
    const pending = app.search("headphones");
    app.reply(0, response("US", [initial]));
    await pending;

    const retailerButton = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"] === "Check and visit shop.example for Exact headphones");
    assert.ok(retailerButton, text(app.render()));
    retailerButton.props.onClick();
    const current = { ...initial, offers: initial.offers.map((offer) => offer.domain === "shop.example" ? { ...offer, availability: "OutOfStock" } : offer) };
    app.reply(1, { retrievedAt: "2026-11-10T06:00:00Z", product: current });
    await tick();

    assert.equal(app.calls.length, 2, "the current exact-product response already supplies a fresh same-item alternative");
    assert.equal(handoff.location.destination, alternate.url);
    assert.match(text(app.render()), /Sorry, shop\.example no longer reports this item in stock\. We opened the same item at other\.example/);
  } finally { app.close(); }
});

test("saved US storefront drives searches; switching to GB clears old offers and requests GBP", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US"), "paypal-markets-display-currency-v1": JSON.stringify("EUR") });
  try {
    let tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.match(byId(tree, "marketplace-query").props.placeholder, /\$/);
    assert.match(text(byId(tree, "shopping-storefront")), /United States · USDUnited Kingdom · GBP/);
    let pending = app.search("headphones");
    assert.equal(JSON.parse(app.calls[0].options.body).storefront, "US");
    app.reply(0, response("US", [product("USD", "US headphones")]));
    await pending;
    tree = app.render();
    assert.match(text(tree), /United States · USD/);
    assert.match(text(tree), /US headphones/);
    assert.match(text(tree), /\$120\.00/);

    app.setStorefront("GB");
    tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "GB");
    assert.equal(JSON.parse(app.values.get(storefront.STOREFRONT_STORAGE_KEY)), "GB");
    assert.equal(JSON.parse(app.values.get("paypal-markets-display-currency-v1")), "EUR");
    assert.doesNotMatch(text(tree), /US headphones/);
    assert.match(text(tree), /Review your search text if it includes a budget in another currency/);
    pending = app.search("headphones");
    assert.equal(JSON.parse(app.calls[1].options.body).storefront, "GB");
    app.reply(1, response("GB", [product("GBP", "UK headphones")]));
    await pending;
    tree = app.render();
    assert.match(text(tree), /United Kingdom · GBP/);
    assert.match(text(tree), /UK headphones/);
    assert.match(text(tree), /£120\.00/);
  } finally { app.close(); }
});

test("search loads another page only on request and preserves each product's original retrieval time", async () => {
  const app = await createMarketplace();
  try {
    const pageOneAt = "2025-11-06T12:00:00.123Z", pageTwoAt = "2026-11-06T12:10:00Z";
    const first = { ...product("GBP", "First page item"), id: "first" };
    const second = { ...product("GBP", "Second page item"), id: "second" };
    const pending = app.search("bags");
    app.reply(0, response("GB", [first], { retrievedAt: pageOneAt, nextPageToken: "next-page" }));
    await pending;
    assert.equal(app.calls.length, 1, "Additional pages must not load automatically");
    let tree = app.render();
    const loadMore = button(tree, "Load more search results");
    loadMore.props.onClick();
    loadMore.props.onClick();
    assert.equal(app.calls.length, 2, "A second click cannot start a duplicate page request");
    assert.deepEqual(JSON.parse(app.calls[1].options.body), { query: "bags", limit: 24, storefront: "GB", pageToken: "next-page" });
    tree = app.render();
    assert.match(text(tree), /First page item/);
    assert.equal(button(tree, "Loading more search results").props.disabled, true);
    app.reply(1, response("GB", [{ ...first, title: "Duplicate newer copy" }, second], { retrievedAt: pageTwoAt, nextPageToken: null }));
    await tick();
    loadMore.props.onClick();
    assert.equal(app.calls.length, 2, "A stale button cannot request the previous page again");
    tree = app.render();
    assert.match(text(tree), /First page item/);
    assert.match(text(tree), /Second page item/);
    assert.doesNotMatch(text(tree), /Duplicate newer copy/);
    assert.match(text(tree), /Latest page retrieved/);
    assert.match(text(tree), /reached the end of these search results/i);
    assert.equal(nodes(tree).filter((node) => node.type === "article").length, 2);
    for (const [title, label] of [["First page item", "2025-11-06 12:00:00.123 UTC"], ["Second page item", "2026-11-06 12:10:00 UTC"]]) {
      const card = nodes(tree).find((node) => node.type === "article" && text(node).includes(title));
      assert.ok(card && text(card).includes(label), `${title} should show its own page time`);
    }
    for (const title of ["First page item", "Second page item"]) {
      const save = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"]?.startsWith(`Save ${title} `));
      assert.ok(save, `Expected a save control for ${title}`);
      await save.props.onClick();
    }
    const saved = JSON.parse(app.values.get("paypal-markets-shopping-lists-v1")).collections[0].items;
    assert.deepEqual(saved.map((item) => [item.product.id, item.retrievedAt]), [["first", pageOneAt], ["second", pageTwoAt]]);
    assert.equal(saved[0].product.offers[0].url, null, "Saved offers remain non-reusable snapshots");
    assert.equal(Object.hasOwn(saved[0], "offers"), false, "Display-only offers must not be stored beside the snapshot");
    assert.doesNotMatch(JSON.stringify(saved), /https:\/\/shop\.example\/item/, "A retailer link must not be retained in the saved item");
  } finally { app.close(); }
});

test("ambiguous or invalid retrieval timestamps are not displayed as current times", async () => {
  for (const retrievedAt of ["2026-02-30T12:00:00Z", "2026-11-06", "2026-11-06T12:00:00+01:00"]) {
    const app = await createMarketplace();
    try {
      const pending = app.search("bags");
      app.reply(0, response("GB", [product("GBP", "Timestamp test")], { retrievedAt, nextPageToken: null }));
      await pending;
      const tree = app.render();
      const card = nodes(tree).find((node) => node.type === "article" && text(node).includes("Timestamp test"));
      assert.ok(card && text(card).includes("date unavailable"));
    } finally { app.close(); }
  }
});

test("a failed search continuation leaves earlier results visible and can be retried", async () => {
  const app = await createMarketplace();
  try {
    const pending = app.search("bags");
    app.reply(0, response("GB", [{ ...product("GBP", "First item"), id: "first" }], { nextPageToken: "next-page" }));
    await pending;
    button(app.render(), "Load more search results").props.onClick();
    app.reply(1, { error: "rate limited" }, 429);
    await tick();
    let tree = app.render();
    assert.match(text(tree), /First item/);
    assert.match(text(tree), /temporarily limited/i);
    button(tree, "Load more search results").props.onClick();
    assert.equal(JSON.parse(app.calls[2].options.body).pageToken, "next-page");
    app.reply(2, response("GB", [{ ...product("GBP", "Second item"), id: "second" }], { nextPageToken: null }));
    await tick();
    tree = app.render();
    assert.match(text(tree), /First item/);
    assert.match(text(tree), /Second item/);
    assert.doesNotMatch(text(tree), /temporarily limited/i);
  } finally { app.close(); }
});

test("switching storefront or private identity cancels a stale search continuation", async () => {
  for (const transition of ["storefront", "identity"]) {
    const app = await createMarketplace();
    try {
      const pending = app.search("bags");
      app.reply(0, response("GB", [{ ...product("GBP", "Current item"), id: "current" }], { nextPageToken: "next-page" }));
      await pending;
      const staleButton = button(app.render(), "Load more search results");
      staleButton.props.onClick();
      if (transition === "storefront") app.setStorefront("US");
      else app.setPrivateReady(false);
      assert.equal(app.calls[1].signal.aborted, true, `${transition} change should cancel the in-flight page`);
      staleButton.props.onClick();
      assert.equal(app.calls.length, 2, "An old control cannot start another request after the context changes");
      app.reply(1, response("GB", [{ ...product("GBP", "Late item"), id: "late" }], { nextPageToken: null }));
      await tick();
      assert.doesNotMatch(text(app.render()), /Late item/);
    } finally { app.close(); }
  }
});

test("a new search cancels a previous continuation and rejects mismatched pages", async () => {
  const app = await createMarketplace();
  try {
    let pending = app.search("bags");
    app.reply(0, response("GB", [product("GBP", "Bags")], { nextPageToken: "next-page" }));
    await pending;
    button(app.render(), "Load more search results").props.onClick();
    pending = app.search("headphones");
    assert.equal(app.calls[1].signal.aborted, true);
    app.reply(1, response("GB", [product("GBP", "Late bags")], { query: "bags", nextPageToken: null }));
    app.reply(2, response("GB", [product("GBP", "Headphones")], { nextPageToken: "headphones-page" }));
    await pending;
    let tree = app.render();
    assert.match(text(tree), /Headphones/);
    assert.doesNotMatch(text(tree), /Late bags/);
    button(tree, "Load more search results").props.onClick();
    app.reply(3, response("GB", [product("GBP", "Mismatched query")], { query: "other", nextPageToken: null }));
    await tick();
    tree = app.render();
    assert.match(text(tree), /Headphones/);
    assert.doesNotMatch(text(tree), /Mismatched query/);
    assert.match(text(tree), /did not match this storefront, search, or price range/i);
  } finally { app.close(); }
});

test("search pagination stops at four pages even when fewer than 96 unique products are returned", async () => {
  const app = await createMarketplace();
  try {
    const repeated = product("GBP", "Same item");
    const pending = app.search("bags");
    app.reply(0, response("GB", [repeated], { nextPageToken: "page-2" }));
    await pending;
    for (let page = 2; page <= 4; page++) {
      button(app.render(), "Load more search results").props.onClick();
      app.reply(page - 1, response("GB", [repeated], { nextPageToken: `page-${page + 1}` }));
      await tick();
    }
    const tree = app.render();
    assert.equal(app.calls.length, 4);
    assert.match(text(tree), /limited to 4 pages/i);
    assert.equal(nodes(tree).some((node) => node.type === "button" && text(node).includes("Load more search results")), false);
    assert.equal(nodes(tree).filter((node) => node.type === "article").length, 1);
  } finally { app.close(); }
});

test("search can retain 96 unique products while stopping before a fifth page", async () => {
  const app = await createMarketplace();
  try {
    const page = (number) => Array.from({ length: 24 }, (_, index) => ({ ...product("GBP", `Item ${number}-${index}`), id: `${number}-${index}` }));
    const pending = app.search("bags");
    app.reply(0, response("GB", page(1), { nextPageToken: "page-2" }));
    await pending;
    for (let number = 2; number <= 4; number++) {
      button(app.render(), "Load more search results").props.onClick();
      app.reply(number - 1, response("GB", page(number), { nextPageToken: `page-${number + 1}` }));
      await tick();
    }
    const tree = app.render();
    assert.equal(nodes(tree).filter((node) => node.type === "article").length, 96);
    assert.match(text(tree), /limited to 4 pages/i);
    assert.equal(app.calls.length, 4);
  } finally { app.close(); }
});

test("a page claiming a different storefront cannot replace existing search results", async () => {
  const app = await createMarketplace();
  try {
    const pending = app.search("bags");
    app.reply(0, response("GB", [product("GBP", "UK bag")], { nextPageToken: "page-2" }));
    await pending;
    button(app.render(), "Load more search results").props.onClick();
    app.reply(1, response("US", [{ ...product("USD", "US bag"), id: "us" }], { nextPageToken: null }));
    await tick();
    const tree = app.render();
    assert.match(text(tree), /UK bag/);
    assert.doesNotMatch(text(tree), /US bag/);
    assert.match(text(tree), /did not match this storefront, search, or price range/i);
  } finally { app.close(); }
});

test("switching storefront aborts an older catalog request and rejects late results", async () => {
  const app = await createMarketplace({}, { mode: "browse" });
  try {
    button(nodes(app.render()).find((node) => node.props?.["aria-label"] === "All shared catalog categories"), "Audio").props.onClick();
    assert.match(app.calls[0].url, /storefront=GB&limit=24&section=audio/);
    assert.equal(app.calls[0].signal.aborted, false);
    app.setStorefront("US");
    assert.equal(app.calls[0].signal.aborted, true);
    app.reply(0, response("GB", [product("GBP", "Late UK headphones")], { section: "audio", title: "Audio" }));
    await tick();
    assert.doesNotMatch(text(app.render()), /Late UK headphones/);
    button(nodes(app.render()).find((node) => node.props?.["aria-label"] === "All shared catalog categories"), "Audio").props.onClick();
    assert.match(app.calls[1].url, /storefront=US&limit=24&section=audio/);
    app.reply(1, response("US", [product("USD", "US headphones")], { section: "audio", title: "Audio" }));
    await tick();
    assert.match(text(app.render()), /US headphones/);
    assert.match(text(app.render()), /United States · USD/);
  } finally { app.close(); }
});

test("saved offers retain their original storefront and refresh in the selected storefront", async () => {
  const lists = { version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [{
    product: product("USD", "Saved headphones"), savedAt: "", retrievedAt: "2026-11-06T00:00:00Z", storefront: "US",
  }] }] };
  const app = await createMarketplace({ ["paypal-markets-shopping-lists-v1"]: JSON.stringify(lists) });
  try {
    button(app.render(), "Travel list").props.onClick();
    let tree = app.render();
    assert.match(text(tree), /Saved offer snapshot · United States/);
    assert.match(text(tree), /\$120\.00/);
    assert.match(text(tree), /Saved price · not checked now/);
    assert.match(text(tree), /Previously reported in stock/);
    button(tree, "Find current offers on Channel3").props.onClick();
    assert.match(app.calls[0].url, /\/api\/marketplace\/products\/example-product\?storefront=GB$/);
    app.reply(0, response("GB", [product("GBP", "Saved headphones")]));
    await tick();
    tree = app.render();
    assert.match(text(tree), /United Kingdom · GBP/);
    assert.match(text(tree), /£120\.00/);
    assert.doesNotMatch(text(tree), /Saved offer snapshot · United States/);
    assert.doesNotMatch(text(tree), /Saved price · not checked now/);
  } finally { app.close(); }
});

test("saved offer recheck uses the exact-product endpoint and confirms a matching product", async () => {
  const lists = { version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [{ product: product("GBP", "Saved headphones"), savedAt: "", retrievedAt: "2026-11-06T00:00:00Z", storefront: "GB" }] }] };
  const app = await createMarketplace({ ["paypal-markets-shopping-lists-v1"]: JSON.stringify(lists) });
  try {
    button(app.render(), "Travel list").props.onClick();
    button(app.render(), "Find current offers on Channel3").props.onClick();
    app.reply(0, response("GB", [product("GBP", "Saved headphones")]));
    await tick();
    assert.equal(app.calls.length, 1);
    assert.match(app.calls[0].url, /\/api\/marketplace\/products\/example-product\?storefront=GB$/);
    const tree = app.render();
    assert.match(text(tree), /Offers rechecked/);
    assert.ok(nodes(tree).some((node) => node.type === "button" && node.props["aria-label"]?.includes("Check and visit") && node.props["aria-label"]?.includes("Saved headphones")));
  } finally { app.close(); }
});

test("overlong provider IDs are not shown or mistaken for a complete ID during recheck", async () => {
  const id = "p".repeat(300);
  const savedItem = { product: { ...product("GBP", "Fictional bag"), id }, savedAt: "", retrievedAt: "", storefront: "GB", identitySource: "complete-id-v1" };
  const lists = { version: 1, collections: [{ id: "saved", name: "Bag list", createdAt: "", items: [savedItem] }] };
  const app = await createMarketplace({ "paypal-markets-shopping-lists-v1": JSON.stringify(lists) });
  try {
    button(app.render(), "Bag list").props.onClick();
    button(app.render(), "Find current offers on Channel3").props.onClick();
    app.reply(0, response("GB", [{ ...product("GBP", "Wrong product"), id: `${id}A` }], { nextPageToken: null }));
    await tick();
    let tree = app.render();
    assert.match(text(tree), /Current product details did not match this item and storefront/i);
    assert.doesNotMatch(text(tree), /Offers rechecked/);
    assert.equal(nodes(tree).some((node) => node.type === "a" && node.props.href === "https://shop.example/item"), false);

    const pending = app.search("bags");
    app.reply(1, response("GB", [
      { ...product("GBP", "Valid boundary product"), id },
      { ...product("GBP", "Overlong product A"), id: `${id}A` },
      { ...product("GBP", "Overlong product B"), id: `${id}B` },
    ], { nextPageToken: null }));
    await pending;
    tree = app.render();
    assert.match(text(tree), /Valid boundary product/);
    assert.doesNotMatch(text(tree), /Overlong product/);
  } finally { app.close(); }
});

test("legacy boundary-length items stay intact while a fresh reviewed match is saved separately", async () => {
  const key = "paypal-markets-shopping-lists-v1";
  const id = "l".repeat(300);
  const oldItem = {
    product: { ...product("GBP", "Legacy bag"), id, legacyProductField: "keep" },
    savedAt: "before", retrievedAt: "", storefront: "US", legacyItemField: { keep: true },
  };
  const lists = { version: 1, collections: [
    { id: "old", name: "Older bags", createdAt: "", items: [oldItem] },
    { id: "fresh", name: "Reviewed bags", createdAt: "", items: [] },
  ] };
  const original = JSON.stringify(lists);
  const app = await createMarketplace({ [key]: original });
  let persisted;
  try {
    button(app.render(), "Older bags").props.onClick();
    let tree = app.render();
    assert.match(text(tree), /original identifier may be incomplete/i);
    assert.equal(nodes(tree).some((node) => node.type === "button" && text(node).includes("Find current offers on Channel3")), false);
    assert.equal(nodes(tree).some((node) => node.type === "a" && node.props.href), false);
    button(tree, "Search for this item again").props.onClick();
    assert.equal(byId(app.render(), "marketplace-query").props.value, "Legacy bag");
    assert.equal(app.calls.length, 0, "Preparing recovery must not send a search");
    assert.equal(app.values.get(key), original, "Opening or searching must not rewrite the snapshot");

    const pending = app.search("Legacy bag");
    app.reply(0, response("GB", [{ ...product("GBP", "Fresh matching bag"), id }], { nextPageToken: null }));
    await pending;
    tree = app.render();
    const conflict = button(tree, "Choose another list");
    assert.equal(conflict.props.disabled, true);
    assert.match(text(tree), /choose another collection to save this result without changing it/i);
    conflict.props.onClick();
    assert.equal(app.values.get(key), original, "A stale save control cannot remove the older item");

    const label = nodes(app.render()).find((node) => node.type === "label" && text(node).includes("Save new finds to"));
    const destination = nodes(label).find((node) => node.type === "select");
    assert.ok(destination);
    destination.props.onChange({ target: { value: "fresh" } });
    tree = app.render();
    const save = nodes(tree).find((node) => node.type === "button" && node.props?.["aria-label"] === "Save Fresh matching bag to Reviewed bags");
    assert.ok(save);
    save.props.onClick();
    persisted = app.values.get(key);
    const stored = JSON.parse(persisted);
    assert.deepEqual(stored.collections[0].items[0], oldItem);
    assert.equal(stored.collections[1].items[0].product.id, id);
    assert.equal(stored.collections[1].items[0].identitySource, "complete-id-v1");
    assert.equal(stored.collections[1].items[0].product.offers[0].url, null);
  } finally { app.close(); }

  const remount = await createMarketplace({ [key]: persisted });
  try {
    button(remount.render(), "Older bags").props.onClick();
    assert.match(text(remount.render()), /original identifier may be incomplete/i);
    button(remount.render(), "Reviewed bags").props.onClick();
    assert.doesNotMatch(text(remount.render()), /original identifier may be incomplete/i);
    button(remount.render(), "Find current offers on Channel3").props.onClick();
    remount.reply(0, response("GB", [{ ...product("GBP", "Fresh matching bag"), id }], { nextPageToken: null }));
    await tick();
    const tree = remount.render();
    assert.match(text(tree), /Offers rechecked/);
    assert.ok(nodes(tree).some((node) => node.type === "button" && node.props["aria-label"]?.includes("Check and visit") && node.props["aria-label"]?.includes("Fresh matching bag")));
    assert.deepEqual(JSON.parse(remount.values.get(key)).collections[0].items[0], oldItem);
  } finally { remount.close(); }
});

test("unsupported stored IDs keep the complete raw collection unchanged and disable writes", async () => {
  const key = "paypal-markets-shopping-lists-v1";
  const lists = { version: 1, collections: [{ id: "old", name: "Old", createdAt: "", items: [
    { product: { ...product("GBP", "Old item"), id: "x".repeat(301) }, savedAt: "", retrievedAt: "", storefront: "GB" },
  ] }] };
  const original = JSON.stringify(lists);
  const app = await createMarketplace({ [key]: original });
  try {
    let tree = app.render();
    assert.match(text(tree), /saved product needs recovery/i);
    assert.equal(button(tree, "Create collection").props.disabled, true);
    assert.equal(button(tree, "Create collection").props.disabled, true);
    const pending = app.search("bags");
    app.reply(0, response("GB", [product("GBP", "Search still works")], { nextPageToken: null }));
    await pending;
    tree = app.render();
    assert.match(text(tree), /Search still works/);
    const save = nodes(tree).find((node) => node.type === "button" && node.props?.["aria-label"]?.startsWith("Save Search still works"));
    assert.equal(save.props.disabled, true);
    save.props.onClick();
    assert.equal(app.values.get(key), original);
  } finally { app.close(); }
});

test("colliding saved collection identifiers block edits without changing the original data", async () => {
  const key = "paypal-markets-shopping-lists-v1";
  const prefix = "list".repeat(30);
  const lists = { version: 1, collections: [
    { id: `${prefix}A`, name: "First list", createdAt: "", items: [{ product: { ...product("GBP", "Older item"), id: "x".repeat(300) }, savedAt: "", retrievedAt: "", storefront: "GB" }] },
    { id: `${prefix}B`, name: "Second list", createdAt: "", items: [] },
  ] };
  const original = JSON.stringify(lists);
  const app = await createMarketplace({ [key]: original });
  try {
    let tree = app.render();
    assert.match(text(tree), /saved collections could not be loaded|saved collection needs recovery/i);
    assert.equal(button(tree, "Create collection").props.disabled, true);
    assert.equal(nodes(tree).some((node) => node.type === "button" && /Rename|Delete collection/.test(text(node))), false);
    const pending = app.search("bags");
    app.reply(0, response("GB", [product("GBP", "Search remains available")], { nextPageToken: null }));
    await pending;
    tree = app.render();
    const save = nodes(tree).find((node) => node.type === "button" && node.props["aria-label"]?.startsWith("Save Search remains available "));
    assert.ok(save);
    assert.equal(save.props.disabled, true);
    save.props.onClick();
    assert.equal(app.values.get(key), original);
  } finally { app.close(); }
});

test("unrepresentable saved rows stay intact and pause collection writes", async () => {
  const key = "paypal-markets-shopping-lists-v1";
  const list = (id, items = []) => ({ id, name: id, createdAt: "", items });
  const item = (id) => ({ product: { ...product("GBP", "Saved item"), id }, savedAt: "", retrievedAt: "", storefront: "GB" });
  const cases = [
    Array.from({ length: 13 }, (_, index) => list(`list-${index}`)),
    [list("Long list", Array.from({ length: 41 }, (_, index) => item(`item-${index}`)))],
    [list("Bad item", [null])],
    [null],
    [list("Duplicate items", [item("same"), item("same")])],
    [{ ...list("long-name"), name: "N".repeat(41) }],
  ];
  for (const collections of cases) {
    const original = JSON.stringify({ version: 1, collections });
    const app = await createMarketplace({ [key]: original });
    try {
      const tree = app.render();
      assert.match(text(tree), /saved collections need recovery/i);
      assert.match(text(tree), /export this local view in settings/i);
      assert.equal(button(tree, "Create collection").props.disabled, true);
      const form = nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "collection-name"));
      form.props.onSubmit({ preventDefault() {} });
      assert.equal(app.values.get(key), original);
    } finally { app.close(); }
  }
});

test("saved offer recheck rejects a different product returned by the exact-product endpoint", async () => {
  const lists = { version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [{ product: product("GBP", "Saved headphones"), savedAt: "", retrievedAt: "2026-11-06T00:00:00Z", storefront: "GB" }] }] };
  const app = await createMarketplace({ ["paypal-markets-shopping-lists-v1"]: JSON.stringify(lists) });
  try {
    button(app.render(), "Travel list").props.onClick();
    button(app.render(), "Find current offers on Channel3").props.onClick();
    app.reply(0, response("GB", [{ ...product("GBP", "Similar headphones"), id: "different-product" }]));
    await tick();
    assert.equal(app.calls.length, 1);
    assert.match(text(app.render()), /Current product details did not match this item and storefront/i);
    assert.equal(nodes(app.render()).some((node) => node.type === "a" && node.props.href === "https://shop.example/item"), false);
  } finally { app.close(); }
});

test("switching storefront during a saved-offer exact check discards its late result", async () => {
  const lists = { version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [{ product: product("GBP", "Saved headphones"), savedAt: "", retrievedAt: "2026-11-06T00:00:00Z", storefront: "GB" }] }] };
  const app = await createMarketplace({ ["paypal-markets-shopping-lists-v1"]: JSON.stringify(lists) });
  try {
    button(app.render(), "Travel list").props.onClick();
    button(app.render(), "Find current offers on Channel3").props.onClick();
    app.setStorefront("US");
    assert.equal(app.calls[0].signal.aborted, true);
    app.reply(0, response("GB", [product("GBP", "Saved headphones")]));
    await tick();
    const tree = app.render();
    assert.doesNotMatch(text(tree), /Offers rechecked/);
    assert.equal(nodes(tree).some((node) => node.type === "a" && node.props.href === "https://shop.example/item"), false);
  } finally { app.close(); }
});

test("an exact-product response with the wrong currency cannot verify a saved offer", async () => {
  const lists = { version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [{ product: product("GBP", "Saved headphones"), savedAt: "", retrievedAt: "2026-11-06T00:00:00Z", storefront: "GB" }] }] };
  const app = await createMarketplace({ ["paypal-markets-shopping-lists-v1"]: JSON.stringify(lists) });
  try {
    button(app.render(), "Travel list").props.onClick();
    button(app.render(), "Find current offers on Channel3").props.onClick();
    app.calls[0].resolve({ response: { ok: true, status: 200 }, body: {
      provider: "Channel3", storefront: "GB", currency: "GBP", retrievedAt: "2026-11-06T00:00:00Z",
      product: product("USD", "Saved headphones"),
    } });
    await tick();
    const tree = app.render();
    assert.match(text(tree), /No offers match these filters/i);
    assert.doesNotMatch(text(tree), /Offers rechecked/);
    assert.equal(nodes(tree).some((node) => node.type === "a" && node.props.href === "https://shop.example/item"), false);
  } finally { app.close(); }
});

test("every fresh image, name, and retailer choice opens directly with its affiliate disclosure", async () => {
  for (const mode of ["browse", "search"]) {
    const handoffs = [];
    const app = await createMarketplace({}, { mode, openWindow: () => {
      const handoff = { closed: false, opener: {}, document: { title: "" }, location: { destination: null, replace(url) { this.destination = url; } }, close() { this.closed = true; } };
      handoffs.push(handoff);
      return handoff;
    } });
    try {
      const first = product("GBP", "Fictional headphones");
      first.images = [{ url: "https://cdn.trychannel3.com/headphones.jpg", is_main_image: true }];
      first.offers[0].max_commission_rate = 0.05;
      first.offers.push({ ...first.offers[0], url: "https://another.example/item", domain: "another.example" });
      const expectedUrls = new Set(first.offers.map((offer) => offer.url));
      if (mode === "browse") {
        button(app.render(), "Audio").props.onClick();
        app.reply(0, response("GB", [first], { section: "audio", title: "Audio" }));
        await tick();
      } else {
        first.offers.unshift({ ...first.offers[0], url: "https://shop.example/above-budget", price: { price: 200, currency: "GBP" } });
        const pending = app.search("headphones under 150");
        app.reply(0, response("GB", [first], { priceRange: { maxPrice: 150 } }));
        await pending;
      }
      const tree = app.render();
      const card = nodes(tree).find((node) => node.type === "article" && text(node).includes("Fictional headphones"));
      assert.ok(card);
      const disclosure = byId(tree, "marketplace-commission-legend");
      assert.ok(disclosure, "Retailer links describe the shared visible commission legend");
      assert.match(text(disclosure), /We may earn a commission on qualifying purchases\. Not cashback\./);
      const links = nodes(card).filter((node) => node.type === "button" && node.props["aria-describedby"] === disclosure.props.id);
      assert.equal(links.length, 5, "The image, name, primary retailer link, and both comparison offers are available");
      for (const link of links) {
        assert.equal(link.props["aria-describedby"], disclosure.props.id);
        link.props.onClick();
        const requestIndex = app.calls.length - 1;
        assert.match(app.calls[requestIndex].url, /^\/api\/marketplace\/products\//);
        const handoff = handoffs.at(-1);
        app.reply(requestIndex, response("GB", [first]));
        await tick();
        assert.ok(expectedUrls.has(handoff.location.destination), `Unexpected verified destination for ${link.props["aria-label"]}: ${handoff.location.destination}`);
      }
      assert.equal(new Set(handoffs.map((handoff) => handoff.location.destination)).size, 2, "Each current retailer can be opened after verification");
      assert.match(text(card), /★ 5%/);
    } finally { app.close(); }
  }
});

test("mismatched storefront metadata never becomes a search result", async () => {
  const app = await createMarketplace();
  try {
    const pending = app.search("headphones");
    app.reply(0, response("US", [product("USD", "Wrong region product")]));
    await pending;
    assert.doesNotMatch(text(app.render()), /Wrong region product/);
    assert.match(text(app.render()), /results did not match this storefront/);
  } finally { app.close(); }
});

test("a blocked browser preference keeps the selected storefront for the current visit", async () => {
  const app = await createMarketplace();
  try {
    globalThis.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
    app.setStorefront("US");
    const tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.match(text(tree), /storefront changed for this visit, but the browser could not save it/);
    const pending = app.search("headphones");
    assert.equal(JSON.parse(app.calls[0].options.body).storefront, "US");
    app.reply(0, response("US", [product("USD")]));
    await pending;
    assert.match(text(app.render()), /\$120\.00/);
  } finally { app.close(); }
});

test("the US retailer shortcut persists JSON and restores across mounts and storage events", async () => {
  const key = storefront.STOREFRONT_STORAGE_KEY;
  const app = await createMarketplace({ "paypal-markets-display-currency-v1": JSON.stringify("EUR") }, { mode: "browse" });
  let saved;
  try {
    button(app.render(), "Browse US retailers").props.onClick();
    assert.equal(byId(app.render(), "shopping-storefront").props.value, "US");
    button(app.render(), "Target").props.onClick();
    assert.match(app.calls[0].url, /storefront=US/);
    saved = app.values.get(key);
    assert.equal(saved, JSON.stringify("US"), "The shortcut must use the same encoded preference as the selector");
    assert.equal(app.values.get("paypal-markets-display-currency-v1"), JSON.stringify("EUR"));
  } finally { app.close(); }

  const remounted = await createMarketplace({ [key]: saved });
  try {
    let tree = remounted.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.doesNotMatch(text(tree), /saved storefront could not be read/i);
    remounted.values.set(key, JSON.stringify("GB"));
    remounted.dispatchStorage(key);
    tree = remounted.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "GB");
    remounted.values.set(key, JSON.stringify("US"));
    remounted.dispatchStorage(key);
    tree = remounted.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.doesNotMatch(text(tree), /saved storefront could not be read/i);
  } finally { remounted.close(); }
});

test("the US retailer shortcut reports a blocked preference while keeping the current visit", async () => {
  const app = await createMarketplace({}, { mode: "browse" });
  try {
    globalThis.localStorage.setItem = () => { throw new Error("fictional storage failure"); };
    button(app.render(), "Browse US retailers").props.onClick();
    const tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.match(text(tree), /storefront changed for this visit, but the browser could not save it/i);
  } finally { app.close(); }
});

test("legacy raw US preference restores without a silent rewrite on mount or storage event", async () => {
  const key = storefront.STOREFRONT_STORAGE_KEY;
  const app = await createMarketplace({ [key]: "US" });
  try {
    let tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.equal(app.values.get(key), "US", "Reading the legacy value must not rewrite it");
    assert.doesNotMatch(text(tree), /saved storefront could not be read/i);

    app.values.set(key, JSON.stringify("GB"));
    app.dispatchStorage(key);
    assert.equal(byId(app.render(), "shopping-storefront").props.value, "GB");
    app.values.set(key, "US");
    app.dispatchStorage(key);
    tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.equal(app.values.get(key), "US", "A storage event must not rewrite the legacy value");
    assert.doesNotMatch(text(tree), /saved storefront could not be read/i);

    app.values.set(key, "{malformed");
    app.dispatchStorage(key);
    tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US", "Malformed storage must not silently change the current selection");
    assert.equal(app.values.get(key), "{malformed");
    assert.match(text(tree), /saved storefront could not be read/i);
  } finally { app.close(); }

  const malformed = await createMarketplace({ [key]: "{malformed" });
  try {
    const tree = malformed.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.equal(malformed.values.get(key), "{malformed");
    assert.match(text(tree), /saved storefront could not be read/i);
  } finally { malformed.close(); }
});

test("collection creation preserves and rejects an overlong pasted name", async () => {
  const app = await createMarketplace();
  try {
    const longName = "A".repeat(41);
    let tree = app.render();
    assert.equal(byId(tree, "collection-name").props.maxLength, undefined);
    byId(tree, "collection-name").props.onChange({ target: { value: longName } });
    tree = app.render();
    const form = nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "collection-name"));
    assert.ok(form);
    form.props.onSubmit({ preventDefault() {} });
    tree = app.render();
    assert.equal(byId(tree, "collection-name").props.value, longName);
    assert.equal(byId(tree, "collection-name").props["aria-invalid"], true);
    assert.equal(byId(tree, "collection-name").props["aria-describedby"], "collection-name-error");
    assert.match(text(tree), /collection names to 40 characters/i);
    assert.equal(app.values.has("paypal-markets-shopping-lists-v1"), false);
    byId(tree, "collection-name").props.onChange({ target: { value: "Travel plans" } });
    tree = app.render();
    nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "collection-name")).props.onSubmit({ preventDefault() {} });
    assert.equal(JSON.parse(app.values.get("paypal-markets-shopping-lists-v1")).collections[0].name, "Travel plans");
  } finally { app.close(); }
});

test("collection rename preserves an overlong draft and allows correction", async () => {
  const key = "paypal-markets-shopping-lists-v1";
  const initial = JSON.stringify({ version: 1, collections: [{ id: "saved", name: "Travel list", createdAt: "", items: [] }] });
  const app = await createMarketplace({ [key]: initial });
  try {
    button(app.render(), "Travel list").props.onClick();
    button(app.render(), "Rename").props.onClick();
    const longName = "B".repeat(41);
    let tree = app.render();
    assert.equal(byId(tree, "rename-collection").props.maxLength, undefined);
    byId(tree, "rename-collection").props.onChange({ target: { value: longName } });
    tree = app.render();
    const form = nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "rename-collection"));
    assert.ok(form);
    form.props.onSubmit({ preventDefault() {} });
    tree = app.render();
    assert.equal(byId(tree, "rename-collection").props.value, longName);
    assert.equal(byId(tree, "rename-collection").props["aria-invalid"], true);
    assert.equal(byId(tree, "rename-collection").props["aria-describedby"], "rename-collection-error");
    assert.match(text(tree), /collection names to 40 characters/i);
    assert.equal(app.values.get(key), initial);
    byId(tree, "rename-collection").props.onChange({ target: { value: "Travel plans" } });
    tree = app.render();
    nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "rename-collection")).props.onSubmit({ preventDefault() {} });
    assert.equal(JSON.parse(app.values.get(key)).collections[0].name, "Travel plans");
  } finally { app.close(); }
});

test("the selected country also requires the paired response currency", async () => {
  const app = await createMarketplace();
  try {
    const pending = app.search("headphones");
    app.reply(0, response("GB", [product("USD", "Wrong currency product")], { currency: "USD" }));
    await pending;
    assert.doesNotMatch(text(app.render()), /Wrong currency product/);
    assert.match(text(app.render()), /results did not match this storefront/);
  } finally { app.close(); }
});

test('retailer catalog appends unique products without changing region and shows offer-specific commission',async()=>{
 const app=await createMarketplace({}, {mode:"browse"});try{
 button(app.render(),'Browse US retailers').props.onClick();button(app.render(),'Target').props.onClick();const first=product('USD','First retailer product');first.offers[0].max_commission_rate=0.05;
 assert.match(app.calls[0].url,/storefront=US/);assert.match(app.calls[0].url,/retailer=target/);assert.doesNotMatch(app.calls[0].url,/section=/);
 app.reply(0,response('US',[first],{section:null,retailer:'target',limit:24,nextPageToken:'opaque1',title:'Target'}));await tick();assert.match(text(app.render()),/★ 5%/);
 button(app.render(),'Load more products').props.onClick();assert.match(app.calls[1].url,/pageToken=opaque1/);const second={...product('USD','Second retailer product'),id:'second'};app.reply(1,response('US',[first,second],{section:null,retailer:'target',limit:24,nextPageToken:null,title:'Target'}));await tick();const tree=app.render();assert.match(text(tree),/First retailer product/);assert.match(text(tree),/Second retailer product/);assert.equal(nodes(tree).filter(n=>n.type==='article').length,2);
 }finally{app.close();}
});

test("curated pagination preserves each product's own retrieval time when saving", async () => {
  const app = await createMarketplace({}, { mode: "browse" });
  try {
    const firstAt = "2026-11-06T12:00:00Z", secondAt = "2026-11-06T12:10:00Z";
    const first = { ...product("USD", "First curated item"), id: "curated-first" };
    const second = { ...product("USD", "Second curated item"), id: "curated-second" };
    button(app.render(), "Browse US retailers").props.onClick();
    button(app.render(), "Target").props.onClick();
    app.reply(0, response("US", [first], { section: null, retailer: "target", limit: 24, nextPageToken: "catalog-next", title: "Target", retrievedAt: firstAt }));
    await tick();
    button(app.render(), "Load more products").props.onClick();
    app.reply(1, response("US", [{ ...first, title: "Duplicate curated item" }, second], { section: null, retailer: "target", limit: 24, nextPageToken: null, title: "Target", retrievedAt: secondAt }));
    await tick();
    const tree = app.render();
    assert.match(text(tree), /Latest page retrieved/);
    assert.doesNotMatch(text(tree), /Duplicate curated item/);
    for (const [title, label] of [["First curated item", "2026-11-06 12:00:00 UTC"], ["Second curated item", "2026-11-06 12:10:00 UTC"]]) {
      const card = nodes(tree).find((node) => node.type === "article" && text(node).includes(title));
      assert.ok(card && text(card).includes(label), `${title} should show its own page time`);
    }
    for (const title of ["First curated item", "Second curated item"]) {
      const save = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"]?.startsWith(`Save ${title} to a local list`));
      assert.ok(save);
      await save.props.onClick();
    }
    const saved = JSON.parse(app.values.get("paypal-markets-shopping-lists-v1")).collections[0].items;
    assert.deepEqual(saved.map((item) => [item.product.id, item.retrievedAt]), [["curated-first", firstAt], ["curated-second", secondAt]]);
  } finally { app.close(); }
});

test("curated catalog announces concise storefront progress outside product cards", async () => {
  const app = await createMarketplace({}, { mode: "browse" });
  try {
    let tree = app.render();
    assert.equal(byId(tree, "curated-catalog-status").props.role, "status");
    assert.equal(byId(tree, "curated-catalog-status").props["aria-live"], "polite");
    assert.equal(text(byId(tree, "curated-catalog-status")), "", "the persistent live region starts empty");

    button(tree, "Browse US retailers").props.onClick();
    tree = app.render();
    button(tree, "Target").props.onClick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "Loading Target products for United States · USD…");
    assert.ok(nodes(tree).some((node) => node.props?.["aria-hidden"] === "true" && text(node).includes("Loading Target products for United States · USD…")), "the visible loader remains available while the live region announces it");

    const first = { ...product("USD", "First accessible catalog item"), id: "catalog-access-first" };
    app.reply(0, response("US", [first], { section: null, retailer: "target", limit: 24, nextPageToken: "catalog-access-next", title: "Target" }));
    await tick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "1 product loaded for Target · United States · USD. More pages are available.");

    button(tree, "Load more products").props.onClick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "Loading more Target products for United States · USD. 1 product currently loaded.");

    const second = { ...product("USD", "Second accessible catalog item"), id: "catalog-access-second" };
    app.reply(1, response("US", [second], { section: null, retailer: "target", limit: 24, nextPageToken: null, title: "Target" }));
    await tick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "2 products loaded for Target · United States · USD. No more pages are available.");
    assert.equal(nodes(tree).filter((node) => node.props?.id === "curated-catalog-status").length, 1, "the same single status remains mounted after pagination");
    const curatedResults = nodes(tree).reverse().find((node) => node.type === "div" && text(node).includes("SHARED CATALOG · TARGET") && text(node).includes(first.title));
    assert.ok(curatedResults, "Expected the rendered curated results container");
    assert.equal(curatedResults.props["aria-live"], undefined, "the results container does not announce its product cards as a live region");
    for (const title of [first.title, second.title]) {
      assert.ok(nodes(tree).some((node) => node.type === "article" && text(node).includes(title)), `${title} remains visible in the catalog`);
      assert.equal(politeStatuses(tree).some((status) => text(status).includes(title)), false, `${title} is outside polite live regions`);
    }

    app.setStorefront("US");
    button(app.render(), "Browse all categories and retailers").props.onClick();
    button(app.render(), "Target").props.onClick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "Loading Target products for United States · USD…");
    app.reply(2, response("US", [], { section: null, retailer: "target", limit: 24, nextPageToken: null, title: "Target" }));
    await tick();
    tree = app.render();
    assert.equal(text(byId(tree, "curated-catalog-status")), "0 products loaded for Target · United States · USD. No more pages are available.");
    assert.match(text(tree), /No products in this shared section yet/);
    assert.equal(politeStatuses(tree).some((status) => text(status).includes("No products in this shared section yet")), false, "the empty-state message is not announced as a second catalog status");
  } finally { app.close(); }
});

const collectionKey = "paypal-markets-shopping-lists-v1";
const collectionFixture = (...names) => JSON.stringify({ version: 1, collections: names.map((name) => ({ id: `list-${name}`, name, createdAt: "", items: [] })) });
function collectionForm(tree) {
  const form = nodes(tree).find((node) => node.type === "form" && nodes(node).some((child) => child.props?.id === "collection-name"));
  assert.ok(form);
  return form;
}
function setCollectionName(app, value) { byId(app.render(), "collection-name").props.onChange({ target: { value } }); }

test("stale same-tab create callbacks cannot overwrite a newer collection", async () => {
  const app = await createMarketplace({ [collectionKey]: collectionFixture("Base") });
  try {
    setCollectionName(app, "First");
    const oldSubmit = collectionForm(app.render()).props.onSubmit;
    await oldSubmit({ preventDefault() {} });
    const after = app.values.get(collectionKey);
    await oldSubmit({ preventDefault() {} });
    assert.equal(app.values.get(collectionKey), after);
    assert.deepEqual(JSON.parse(after).collections.map((list) => list.name), ["Base", "First"]);
  } finally { app.close(); }
});

test("another view's save requires reload and retains the new-list draft", async () => {
  const app = await createMarketplace({ [collectionKey]: collectionFixture("Base") });
  try {
    setCollectionName(app, "My draft");
    const submit = collectionForm(app.render()).props.onSubmit;
    const other = collectionFixture("Base", "Other view");
    app.values.set(collectionKey, other);
    await submit({ preventDefault() {} });
    let tree = app.render();
    assert.equal(app.values.get(collectionKey), other);
    assert.match(text(tree), /changed in another view/i);
    assert.equal(byId(tree, "collection-name").props.value, "My draft");
    button(tree, "Reload saved collections").props.onClick();
    tree = app.render();
    assert.equal(byId(tree, "collection-name").props.value, "My draft");
    await collectionForm(tree).props.onSubmit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(app.values.get(collectionKey)).collections.map((list) => list.name), ["Base", "Other view", "My draft"]);
  } finally { app.close(); }
});

test("a changed list cannot be deleted using an older confirmation", async () => {
  const app = await createMarketplace({ [collectionKey]: collectionFixture("Base") });
  try {
    button(app.render(), "Base").props.onClick();
    button(app.render(), "Delete collection").props.onClick();
    const confirmation = nodes(app.render()).find((node) => node.props?.["aria-label"] === "Confirm collection deletion");
    assert.ok(confirmation);
    const other = collectionFixture("Base", "New list");
    app.values.set(collectionKey, other);
    await button(confirmation, "Delete collection").props.onClick();
    assert.equal(app.values.get(collectionKey), other);
    assert.match(text(app.render()), /reload and review/i);
  } finally { app.close(); }
});

test("a removed selected list keeps its unsaved rename separate after reload", async () => {
  const app = await createMarketplace({ [collectionKey]: collectionFixture("First", "Second") });
  try {
    button(app.render(), "First").props.onClick();
    button(app.render(), "Rename").props.onClick();
    byId(app.render(), "rename-collection").props.onChange({ target: { value: "Keep this draft" } });
    app.values.set(collectionKey, collectionFixture("Second"));
    app.dispatchStorage(collectionKey);
    button(app.render(), "Reload saved collections").props.onClick();
    const tree = app.render();
    assert.equal(nodes(tree).find((node) => node.props?.["aria-label"] === "Unfinished name for First")?.props.value, "Keep this draft");
    assert.equal(JSON.parse(app.values.get(collectionKey)).collections[0].name, "Second");
  } finally { app.close(); }
});

test("unavailable or busy browser locks leave collection bytes unchanged", async () => {
  for (const options of [{ secure: false }, { lockRequest: (callback) => Promise.resolve(callback(null)) }]) {
    const original = collectionFixture("Base");
    const app = await createMarketplace({ [collectionKey]: original }, options);
    try {
      setCollectionName(app, "New");
      await collectionForm(app.render()).props.onSubmit({ preventDefault() {} });
      assert.equal(app.values.get(collectionKey), original);
      assert.match(text(app.render()), /secure browser|another collection change/i);
    } finally { app.close(); }
  }
});

test("a change of view after issuing a write requires a verified reload", async () => {
  let release;
  const app = await createMarketplace({ [collectionKey]: collectionFixture("Base") }, {
    lockRequest: (callback) => new Promise((resolve, reject) => { Promise.resolve(callback({ name: "test" })).then((value) => { release = () => resolve(value); }, reject); }),
  });
  try {
    setCollectionName(app, "New");
    const saving = collectionForm(app.render()).props.onSubmit({ preventDefault() {} });
    await tick();
    button(app.render(), "Base").props.onClick();
    release();
    await saving;
    assert.match(text(app.render()), /may already have been saved/i);
    assert.ok(button(app.render(), "Reload saved collections"));
    assert.deepEqual(JSON.parse(app.values.get(collectionKey)).collections.map((list) => list.name), ["Base", "New"]);
  } finally { app.close(); }
});

test("a verified same-scope remount restores a draft and reads the latest collections before saving", async () => {
  const sessionStorage = await load("../src/lib/customer-session-storage.ts");
  const sessionClient = await load("../src/lib/customer-session-client.ts", { "./customer-session-storage": sessionStorage });
  let current = { authenticated: false, loginAvailable: true };
  const controller = sessionClient.createCustomerSessionController({ fetcher: async () => new Response(JSON.stringify(current), { headers: { "content-type": "application/json", "cache-control": "no-store" } }) });
  const retained = draftMemory.createShoppingDraftMemory(controller.getSnapshot);
  const unsubscribe = controller.subscribe(retained.observe);
  let app;
  try {
    await controller.check();
    const oldLease = controller.getSnapshot().lease;
    app = await createMarketplace({ [collectionKey]: collectionFixture("Base") }, { lease: oldLease, shoppingDraft: retained });
    setCollectionName(app, "My unfinished list");
    assert.equal(retained.read(oldLease), "My unfinished list");
    const before = controller.check({ automatic: true });
    assert.equal(retained.read(oldLease), null);
    app.close(); app = undefined;
    await before;
    const freshLease = controller.getSnapshot().lease;
    app = await createMarketplace({ [collectionKey]: collectionFixture("Base", "Other tab") }, { lease: freshLease, shoppingDraft: retained });
    let tree = app.render();
    assert.equal(byId(tree, "collection-name").props.value, "My unfinished list");
    assert.match(text(tree), /Other tab/);
    await collectionForm(tree).props.onSubmit({ preventDefault() {} });
    tree = app.render();
    assert.equal(byId(tree, "collection-name").props.value, "");
    assert.equal(retained.read(freshLease), null);
    assert.deepEqual(JSON.parse(app.values.get(collectionKey)).collections.map((list) => list.name), ["Base", "Other tab", "My unfinished list"]);
  } finally { app?.close(); unsubscribe(); retained.clear(); controller.dispose(); }
});

test("an oversized collection draft stays intact on screen with an explicit retention limit", async () => {
  const sessionStorage = await load("../src/lib/customer-session-storage.ts");
  const lease = sessionStorage.createScopeLease("guest", "test");
  const retained = draftMemory.createShoppingDraftMemory(() => ({ status: "ready", epoch: 1, lease, session: { authenticated: false, loginAvailable: true } }));
  const app = await createMarketplace({}, { lease, shoppingDraft: retained });
  try {
    const over = "a".repeat(draftMemory.MAX_RETAINED_COLLECTION_DRAFT_LENGTH + 1);
    setCollectionName(app, over);
    const tree = app.render();
    assert.equal(byId(tree, "collection-name").props.value, over);
    assert.match(text(tree), /too long to keep when this view is reverified/i);
    assert.equal(retained.read(lease), null);
  } finally { app.close(); }
});

test("a collection change in another tab does not clear this tab's name draft", async () => {
  const sessionStorage = await load("../src/lib/customer-session-storage.ts");
  const lease = sessionStorage.createScopeLease("guest", "test");
  const retained = draftMemory.createShoppingDraftMemory(() => ({ status: "ready", epoch: 1, lease, session: { authenticated: false, loginAvailable: true } }));
  const app = await createMarketplace({ [collectionKey]: collectionFixture("Base") }, { lease, shoppingDraft: retained });
  try {
    setCollectionName(app, "Unfinished here");
    app.values.set(collectionKey, collectionFixture("Base", "Other tab"));
    app.dispatchStorage(collectionKey);
    assert.equal(byId(app.render(), "collection-name").props.value, "Unfinished here");
    assert.equal(retained.read(lease), "Unfinished here");
  } finally { app.close(); }
});


test("commission rates use one shared legend and all actual offer prices remain visible", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US") });
  try {
    const item = product("USD", "Visible price headphones");
    item.offers = [0.05, 0, null, 0.0125].map((rate, index) => ({
      ...item.offers[0], url: index === 2 ? undefined : `https://shop.example/item-${index}`,
      price: { price: [120, 135, 140, 145][index], currency: "USD" }, max_commission_rate: rate,
    }));
    const pending = app.search("headphones");
    app.reply(0, response("US", [item]));
    await pending;
    const tree = app.render();
    const section = nodes(tree).find((node) => node.type === "section" && node.props["aria-labelledby"] === "offers-title");
    const card = nodes(section).find((node) => node.type === "article");
    const heading = nodes(card).find((node) => node.type === "div" && [node.props.children].flat().some((child) => child?.type === "h4"));
    assert.match(text(heading), /Visible price headphones\$120\.00USD/);
    assert.equal(nodes(card).some((node) => node.type === "details"), false, "Prices must not require opening a comparison");
    const offers = nodes(card).find((node) => node.type === "section" && node.props["aria-label"] === "Retailer offers for Visible price headphones");
    assert.ok(offers, "Every retailer offer is in an ordinary visible section");
    for (const amount of ["$120.00", "$135.00", "$140.00", "$145.00"]) assert.ok(text(offers).includes(amount));
    const unlinkedOffer = nodes(offers).find((node) => node.type === "li" && text(node).includes("$140.00"));
    assert.match(text(unlinkedOffer), /no link/);
    assert.equal(nodes(unlinkedOffer).some((node) => node.type === "a" || node.type === "button"), false);
    const compactRates = new Set(nodes(card).filter((node) => node.type === "span" && node.props.role === "img").map(text));
    for (const label of ["★ 5%", "★ 0%", "★ —", "★ 1.25%"]) assert.ok(compactRates.has(label), label);
    assert.ok(nodes(card).some((node) => node.props["aria-label"] === "Advertised affiliate commission rate unavailable."));
    assert.ok(nodes(card).some((node) => String(node.props["aria-label"] ?? "").includes("Maximum advertised affiliate commission 5%")));
    const legends = nodes(tree).filter((node) => node.props.id === "marketplace-commission-legend");
    assert.equal(legends.length, 1);
    assert.match(text(legends[0]), /may change/);
    assert.match(text(legends[0]), /Not cashback/);
    assert.match(text(legends[0]), /We may earn a commission/);
  } finally { app.close(); }
});
