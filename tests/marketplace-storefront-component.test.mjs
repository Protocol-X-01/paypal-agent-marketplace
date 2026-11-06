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
const safety = await load("../src/lib/marketplace-safety.ts");
const savedStorefront = await load("../src/lib/storefront-storage.ts");
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
function product(currency, title = "Example headphones") {
  return { id: "example-product", title, images: [], offers: [{
    url: "https://shop.example/item", domain: "shop.example", availability: "InStock",
    price: { price: 120, currency },
  }] };
}
function response(country, products, overrides = {}) {
  return { provider: "Channel3", storefront: country, currency: country === "GB" ? "GBP" : "USD", retrievedAt: "2026-11-06T00:00:00Z", products, ...overrides };
}

async function createMarketplace(initialStorage = {}) {
  const originals = { window: globalThis.window, localStorage: globalThis.localStorage };
  const values = new Map(Object.entries(initialStorage));
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  globalThis.window = {
    location: { search: "" },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const slots = [];
  const pendingEffects = [];
  const calls = [];
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
    "@/lib/channel3-storefront": storefront,
    "@/lib/channel3-catalog": catalogMetadata,
    "@/lib/marketplace-request": {
      MarketplaceRequestTimeoutError: class MarketplaceRequestTimeoutError extends Error {},
      fetchMarketplaceJson: (url, options, signal) => new Promise((resolve, reject) => calls.push({ url, options, signal, resolve, reject })),
    },
    "@/lib/marketplace-safety": safety,
    "@/lib/marketplace-storage": storage,
    "./marketplace.module.css": { __esModule: true, default: {} },
    "./customer-session": { usePrivateDataScope: () => ({ ready: true, storage: globalThis.localStorage, events: globalThis.window, label: "Guest test data" }) },
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
  function reply(index, body, status = 200) {
    calls[index].resolve({ response: { ok: status >= 200 && status < 300, status }, body });
  }
  function close() {
    for (const value of slots) if (typeof value?.cleanup === "function") value.cleanup();
    if (originals.window === undefined) delete globalThis.window; else globalThis.window = originals.window;
    if (originals.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originals.localStorage;
  }
  render();
  flushImmediateTimers();
  render();
  return { render, search, setStorefront, reply, calls, values, listeners, close };
}

test("saved US storefront drives searches; switching to GB clears old offers and requests GBP", async () => {
  const app = await createMarketplace({ [storefront.STOREFRONT_STORAGE_KEY]: JSON.stringify("US"), "paypal-markets-display-currency-v1": JSON.stringify("EUR") });
  try {
    let tree = app.render();
    assert.equal(byId(tree, "shopping-storefront").props.value, "US");
    assert.match(byId(tree, "marketplace-query").props.placeholder, /\$/);
    assert.match(text(byId(tree, "shopping-storefront")), /United Kingdom · GBPUnited States · USD/);
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

test("switching storefront aborts an older catalog request and rejects late results", async () => {
  const app = await createMarketplace();
  try {
    button(nodes(app.render()).find((node) => node.props?.["aria-label"] === "Shared catalog categories"), "Audio").props.onClick();
    assert.match(app.calls[0].url, /storefront=GB&limit=24&section=audio/);
    assert.equal(app.calls[0].signal.aborted, false);
    app.setStorefront("US");
    assert.equal(app.calls[0].signal.aborted, true);
    app.reply(0, response("GB", [product("GBP", "Late UK headphones")], { section: "audio", title: "Audio" }));
    await tick();
    assert.doesNotMatch(text(app.render()), /Late UK headphones/);
    button(nodes(app.render()).find((node) => node.props?.["aria-label"] === "Shared catalog categories"), "Audio").props.onClick();
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
    button(tree, "Find current offers on Channel3").props.onClick();
    assert.equal(JSON.parse(app.calls[0].options.body).storefront, "GB");
    app.reply(0, response("GB", [product("GBP", "Saved headphones")]));
    await tick();
    tree = app.render();
    assert.match(text(tree), /United Kingdom · GBP/);
    assert.match(text(tree), /£120\.00/);
    assert.doesNotMatch(text(tree), /Saved offer snapshot · United States/);
  } finally { app.close(); }
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
 const app=await createMarketplace();try{
 button(app.render(),'Target').props.onClick();const first=product('GBP','First retailer product');first.offers[0].max_commission_rate=0.05;
 assert.match(app.calls[0].url,/storefront=GB/);assert.match(app.calls[0].url,/retailer=target/);assert.doesNotMatch(app.calls[0].url,/section=/);
 app.reply(0,response('GB',[first],{section:null,retailer:'target',limit:24,nextPageToken:'opaque1',title:'Target'}));await tick();assert.match(text(app.render()),/Up to 5% affiliate commission/);
 button(app.render(),'Load more products').props.onClick();assert.match(app.calls[1].url,/pageToken=opaque1/);const second={...product('GBP','Second retailer product'),id:'second'};app.reply(1,response('GB',[first,second],{section:null,retailer:'target',limit:24,nextPageToken:null,title:'Target'}));await tick();const tree=app.render();assert.match(text(tree),/First retailer product/);assert.match(text(tree),/Second retailer product/);assert.equal(nodes(tree).filter(n=>n.type==='article').length,2);
 }finally{app.close();}
});
