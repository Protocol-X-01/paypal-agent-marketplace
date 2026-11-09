import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const cjs = { exports: {} };
  new Function("exports", "require", "module", compiled)(cjs.exports, (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module: ${name}`);
  }, cjs);
  return cjs.exports;
}
const lock = await load("../src/lib/collection-lock.ts");
const draftMemory = await load("../src/lib/customer-shopping-draft-memory.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const key = lock.SHOPPING_LISTS_STORAGE_KEY;
const resetSignal = "paypal-markets-local-data-reset-signal-v1";
const keys = ["paypal-markets-manual-holdings-v1", "paypal-markets-watchlist-v1", key, "paypal-markets-display-currency-v1", "storefront", "business"];
function nodes(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}
function button(tree, label) {
  const value = nodes(tree).find((node) => node.type === "button" && text(node.props.children).includes(label));
  assert.ok(value, `Missing ${label}`);
  return value;
}
async function createSettings(options = {}) {
  const original = globalThis.window;
  const values = new Map(keys.map((name) => [name, name === key ? "{saved collection bytes}" : `before:${name}`]));
  const calls = [];
  let live = true;
  const events = { dispatchEvent(event) { if (!live) return false; calls.push(["event", event.type]); return true; } };
  const storage = {
    getItem(name) { if (!live) throw Error("revoked"); calls.push(["get", name]); return values.get(name) ?? null; },
    setItem(name, value) { if (!live) throw Error("revoked"); calls.push(["set", name]); values.set(name, String(value)); },
    removeItem(name) { if (!live) throw Error("revoked"); calls.push(["remove", name]); values.delete(name); if (options.failRemove === name) throw Error("lost acknowledgement"); },
  };
  let currentStorage = storage;
  let currentEvents = events;
  let currentReady = true;
  globalThis.window = { isSecureContext: options.secure !== false, navigator: { locks: { request: (_name, _options, callback) => options.lockRequest ? options.lockRequest(callback) : Promise.resolve(callback({ name: "test" })) } } };
  const slots = [];
  const pending = [];
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(fn, deps) { const i = cursor++; const prior = slots[i]; if (!prior || deps.some((v, j) => !Object.is(v, prior.deps[j]))) pending.push(() => { prior?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const Component = (await load("../src/app/components/data-settings.tsx", {
    react: hooks, "react/jsx-runtime": jsx,
    "@/lib/collection-lock": lock,
    "@/lib/channel3-storefront": { STOREFRONT_STORAGE_KEY: "storefront" },
    "@/lib/portfolio-input": { LOCAL_DATA_RESET_SIGNAL: resetSignal },
    "@/lib/business-plan-storage": { BUSINESS_PLAN_STORAGE_KEY: "business" },
    "@/lib/market-currency": { MARKET_CURRENCIES: ["USD"], MARKET_CURRENCY_LABELS: { USD: "Dollar" }, isMarketCurrency: (value) => value === "USD" },
    "./customer-session": {
      usePrivateDataScope: () => ({ ready: currentReady, storage: currentStorage, events: currentEvents, label: "Test local view" }),
      useShoppingDraftMemory: () => options.draftHook ?? { lease: null, shoppingDraft: { write: () => "retained" } },
    },
  })).default;
  function render() { cursor = 0; const tree = Component({ currency: "USD", currencyReady: true, onCurrencyChange() {} }); while (pending.length) pending.shift()(); return tree; }
  function close() { for (const value of slots) value?.cleanup?.(); if (original === undefined) delete globalThis.window; else globalThis.window = original; }
  render();
  function switchScope() {
    live = false;
    currentStorage = { getItem() { return null; }, setItem() {}, removeItem() { throw Error("Unexpected removal in new scope"); } };
    currentEvents = { dispatchEvent() { return true; } };
    currentReady = true;
  }
  return { values, calls, render, revoke() { live = false; currentReady = false; }, switchScope, close };
}
function begin(app) { button(app.render(), "Reset this local view").props.onClick(); }
function reset(app) { button(app.render(), "Reset now").props.onClick(); return tick(); }

test("reset confirmation protects against another view changing collections", async () => {
  const app = await createSettings();
  try {
    begin(app);
    assert.match(text(app.render()), /other open tabs.*unsaved work/i);
    app.values.set(key, "changed by another view");
    const before = new Map(app.values);
    await reset(app);
    assert.deepEqual(app.values, before);
    assert.equal(app.calls.some(([kind]) => kind === "remove"), false);
    assert.match(text(app.render()), /nothing was removed/i);
  } finally { app.close(); }
});

test("confirmed reset can remove an unchanged corrupt collection snapshot", async () => {
  const app = await createSettings();
  try {
    begin(app);
    await reset(app);
    for (const name of keys) assert.equal(app.values.has(name), false);
    assert.ok(app.calls.some(([kind, name]) => kind === "event" && name === "paypal-markets-data-reset"));
    assert.ok(app.calls.some(([kind, name]) => kind === "set" && name === resetSignal));
  } finally { app.close(); }
});

test("busy and unsupported locks perform no reset", async () => {
  for (const options of [{ secure: false }, { lockRequest: (callback) => Promise.resolve(callback(null)) }]) {
    const app = await createSettings(options);
    try {
      const before = new Map(app.values);
      begin(app);
      if (options.secure !== false) await reset(app);
      assert.deepEqual(app.values, before);
      assert.equal(app.calls.some(([kind]) => kind === "remove"), false);
      assert.match(text(app.render()), /secure browser|another collection change/i);
    } finally { app.close(); }
  }
});

test("a removal that changes data and throws reports uncertainty and invalidates other views", async () => {
  const app = await createSettings({ failRemove: "paypal-markets-watchlist-v1" });
  try {
    begin(app);
    await reset(app);
    assert.equal(app.values.has("paypal-markets-watchlist-v1"), false);
    assert.equal(app.values.has(key), true);
    assert.match(text(app.render()), /may be partial/i);
    assert.equal(nodes(app.render()).some((node) => node.props?.["aria-label"] === "Confirm local data reset"), false);
    assert.ok(app.calls.some(([kind, name]) => kind === "event" && name === "paypal-markets-data-reset"));
    assert.ok(app.calls.some(([kind, name]) => kind === "set" && name === resetSignal));
  } finally { app.close(); }
});

test("revoking a scope while a lock is pending prevents all removals and stale notices", async () => {
  let start;
  const app = await createSettings({ lockRequest: (callback) => new Promise((resolve) => { start = () => resolve(callback({ name: "test" })); }) });
  try {
    begin(app);
    const pending = reset(app);
    const before = new Map(app.values);
    app.revoke();
    start();
    await pending;
    assert.deepEqual(app.values, before);
    assert.equal(app.calls.some(([kind]) => kind === "remove"), false);
    assert.doesNotMatch(text(app.render()), /nothing was removed|may be partial|were cleared/i);
  } finally { app.close(); }
});

test("cancel after removal issued waits for and reports the real result", async () => {
  let release;
  const app = await createSettings({ lockRequest: (callback) => new Promise((resolve, reject) => { Promise.resolve(callback({ name: "test" })).then((value) => { release = () => resolve(value); }, reject); }) });
  try {
    begin(app);
    const pending = reset(app);
    await tick();
    button(app.render(), "Cancel").props.onClick();
    assert.match(text(app.render()), /reset has already started/i);
    release();
    await pending;
    await tick();
    assert.match(text(app.render()), /were cleared/i);
  } finally { app.close(); }
});

test("scope change clears old reset state and ignores its late completion", async () => {
  let release;
  const app = await createSettings({ lockRequest: (callback) => new Promise((resolve, reject) => { Promise.resolve(callback({ name: "test" })).then((value) => { release = () => resolve(value); }, reject); }) });
  try {
    begin(app);
    const pending = reset(app);
    await tick();
    app.switchScope();
    app.render(); // Runs the scope effect; React immediately rerenders changed state.
    let tree = app.render();
    assert.doesNotMatch(text(tree), /Reset this local view\?|Checking…|reset has already started/i);
    button(tree, "Reset this local view").props.onClick();
    tree = app.render();
    button(tree, "Cancel").props.onClick();
    assert.doesNotMatch(text(app.render()), /reset has already started/i);
    release();
    await pending;
    await tick();
    assert.doesNotMatch(text(app.render()), /were cleared|may be partial/i);
  } finally { app.close(); }
});

test("old-scope Settings callbacks cannot alter the new view or its reset confirmation", async () => {
  const app = await createSettings();
  try {
    let tree = app.render();
    const oldBegin = button(tree, "Reset this local view").props.onClick;
    const oldExport = button(tree, "Export this local view").props.onClick;
    oldBegin();
    tree = app.render();
    const oldCancel = button(tree, "Cancel").props.onClick;
    const oldReset = button(tree, "Reset now").props.onClick;
    app.switchScope();
    app.render();
    app.render();
    oldBegin();
    oldExport();
    assert.doesNotMatch(text(app.render()), /could not check saved collections|could not export/i);
    begin(app);
    assert.ok(nodes(app.render()).some((node) => node.props?.["aria-label"] === "Confirm local data reset"));
    oldCancel();
    oldReset();
    await tick();
    tree = app.render();
    assert.ok(nodes(tree).some((node) => node.props?.["aria-label"] === "Confirm local data reset"));
    assert.doesNotMatch(text(tree), /may be partial|were cleared|could not check saved collections|could not export/i);
  } finally { app.close(); }
});

test("an older confirmation cannot cancel or start a newer confirmation in the same scope", async () => {
  const app = await createSettings();
  try {
    begin(app);
    let tree = app.render();
    const oldCancel = button(tree, "Cancel").props.onClick;
    const oldReset = button(tree, "Reset now").props.onClick;
    oldCancel();
    begin(app);
    const before = new Map(app.values);
    oldCancel();
    oldReset();
    await tick();
    tree = app.render();
    assert.ok(nodes(tree).some((node) => node.props?.["aria-label"] === "Confirm local data reset"));
    assert.deepEqual(app.values, before);
    assert.equal(app.calls.some(([kind]) => kind === "remove"), false);
  } finally { app.close(); }
});

test("only a locally attempted reset clears its captured scope's shopping draft", async () => {
  for (const mode of ["busy", "changed", "partial", "complete"]) {
    const lease = { scope: "guest", id: "lease", active: true };
    const shoppingDraft = draftMemory.createShoppingDraftMemory(() => ({ status: "ready", epoch: 1, lease, session: { authenticated: false, loginAvailable: true } }));
    shoppingDraft.write(lease, "Unfinished collection");
    const options = { draftHook: { lease, shoppingDraft } };
    if (mode === "busy") options.lockRequest = (callback) => Promise.resolve(callback(null));
    if (mode === "partial") options.failRemove = "paypal-markets-manual-holdings-v1";
    const app = await createSettings(options);
    try {
      begin(app);
      if (mode === "changed") app.values.set(key, "another view changed collections");
      await reset(app);
      assert.equal(shoppingDraft.read(lease), mode === "busy" || mode === "changed" ? "Unfinished collection" : null, mode);
      if (mode === "partial") assert.match(text(app.render()), /may be partial/i);
    } finally { app.close(); }
  }
});
