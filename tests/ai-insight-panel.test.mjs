import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../packages/ai-insights/ui/InsightPanel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const selection = { coinId: "bitcoin", currency: "GBP", days: 7 };
const reportSelection = { days: 7, account: "Business", market: "UK" };
const commentary = { headline: "An observed change", summary: "This explanation describes only the selected reference.", observations: ["An observation."], caution: "No future result is established." };
const envelope = { generatedAt: "2026-11-06T13:00:00Z", model: "example-model", insight: commentary, disclaimer: "Example AI explanation." };
function market(chosen = selection) {
  return { ...envelope, kind: "market", source: { ...chosen, provider: "CoinGecko", retrievedAt: "2026-11-06T12:59:00Z", sampleCount: 42, firstTimestamp: 1793350800000, lastTimestamp: 1793941200000, firstPrice: 20, lastPrice: 22, low: 19, high: 23, changePercent: 10, priceBasis: "candle_close", rangeBasis: "candle_high_low", timestampKind: "close", candleIntervalMinutes: 240 } };
}
function report() {
  return { ...envelope, kind: "fictional-report", source: { ...reportSelection, provider: "Fictional local fixture", fixtureTimestamp: "2026-11-06T00:00:00Z", currentStart: "2026-10-30T00:00:00Z", currentEnd: "2026-11-06T00:00:00Z", priorStart: "2026-10-23T00:00:00Z", priorEnd: "2026-10-30T00:00:00Z", cohortCount: 2, priorActive: 10, currentActive: 12, retained: 8, currentAttempted: 20, currentCompleted: 18, priorCompleted: 14, retention: .8, completion: .9 } };
}

// Small hook harness: React replaces a keyed child and cleans up its own effects.
// Requests deliberately ignore abort so late completion cannot hide a lifetime bug.
function mount(initialProps) {
  let currentInstance;
  let instance;
  let props = initialProps;
  let nextId = 0;
  let lateWrites = 0;
  const timers = new Map();
  const requests = [];
  const deferredCleanups = [];
  const hooks = {
    useId() { return `insight-heading-${currentInstance.id}`; },
    useRef(initial) {
      const index = currentInstance.cursor++;
      if (!(index in currentInstance.slots)) currentInstance.slots[index] = { current: initial };
      return currentInstance.slots[index];
    },
    useState(initial) {
      const owner = currentInstance;
      const index = owner.cursor++;
      if (!(index in owner.slots)) owner.slots[index] = initial;
      return [owner.slots[index], (next) => { if (owner.unmounted) lateWrites += 1; owner.slots[index] = typeof next === "function" ? next(owner.slots[index]) : next; }];
    },
    useEffect(callback) {
      const index = currentInstance.cursor++;
      if (!(index in currentInstance.slots)) currentInstance.slots[index] = { cleanup: callback() };
    },
  };
  const element = (type, elementProps, key) => ({ type, props: elementProps ?? {}, key });
  const aliases = {
    react: hooks,
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "./insight-panel.module.css": { __esModule: true, default: {} },
    "./client": { requestInsight(kind, chosen, signal) {
      return new Promise((resolve, reject) => requests.push({ kind, selection: chosen, signal, resolve, reject }));
    } },
  };
  const cjs = { exports: {} };
  const require = (name) => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw new Error(`Unexpected insight panel dependency: ${name}`); };
  const setTimer = (callback) => { const id = ++nextId; timers.set(id, callback); return id; };
  new Function("exports", "require", "module", "setTimeout", "clearTimeout", compiled)(cjs.exports, require, cjs, setTimer, (id) => timers.delete(id));
  const Component = cjs.exports.default;
  function cleanup(owner) {
    owner.unmounted = true;
    for (const slot of owner.slots) slot?.cleanup?.();
  }
  function render(nextProps = props, { deferCleanup = false } = {}) {
    props = nextProps;
    const child = Component(props);
    if (!instance || instance.key !== child.key || instance.type !== child.type) {
      if (instance) {
        const owner = instance;
        if (deferCleanup) deferredCleanups.push(() => cleanup(owner));
        else cleanup(owner);
      }
      instance = { id: ++nextId, key: child.key, type: child.type, slots: [], cursor: 0, unmounted: false };
    }
    currentInstance = instance;
    instance.cursor = 0;
    return child.type(child.props);
  }
  return {
    render, requests, timers,
    get lateWrites() { return lateWrites; },
    flushCleanups() { for (const callback of deferredCleanups.splice(0)) callback(); },
    fireTimers() { for (const callback of [...timers.values()]) callback(); },
    unmount() { if (instance) { cleanup(instance); instance = null; } this.flushCleanups(); },
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return null; }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
const button = (tree) => find(tree, (node) => node.type === "button");
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("leaving and returning to a pending selection creates a usable view and ignores late results", async () => {
  const screen = mount({ kind: "market", selection });
  try {
    button(screen.render()).props.onClick();
    assert.equal(button(screen.render()).props.disabled, true);
    const requestA = screen.requests[0];
    assert.equal(screen.timers.size, 1);
    screen.render({ kind: "market", selection: { ...selection, coinId: "ethereum" } });
    assert.equal(requestA.signal.aborted, true);
    assert.equal(screen.timers.size, 0);
    let tree = screen.render({ kind: "market", selection });
    assert.equal(button(tree).props.disabled, false);
    assert.equal(button(tree).props["aria-busy"], false);
    button(tree).props.onClick();
    const requestNewA = screen.requests[1];
    requestA.resolve({ ...market(), insight: { ...commentary, headline: "Stale result must stay hidden" } });
    await settle();
    tree = screen.render();
    assert.doesNotMatch(textOf(tree), /Stale result/);
    assert.equal(button(tree).props.disabled, true);
    requestNewA.resolve(market());
    await settle();
    tree = screen.render();
    assert.match(textOf(tree), /An observed change/);
    assert.equal(button(tree).props.disabled, false);
    assert.equal(screen.lateWrites, 0);
  } finally { screen.unmount(); }
});

test("disabling a fictional preview cancels work and re-enabling never restores a pending or old success", async () => {
  const on = { kind: "fictional-report", selection: reportSelection, enabled: true };
  const screen = mount(on);
  try {
    button(screen.render()).props.onClick();
    let tree = screen.render({ ...on, enabled: false });
    assert.equal(screen.requests[0].signal.aborted, true);
    assert.equal(button(tree).props.disabled, true);
    button(tree).props.onClick();
    assert.equal(screen.requests.length, 1);
    tree = screen.render(on);
    assert.equal(button(tree).props.disabled, false);
    button(tree).props.onClick();
    screen.requests[1].resolve(report());
    await settle();
    assert.match(textOf(screen.render()), /An observed change/);
    screen.render({ ...on, enabled: false });
    tree = screen.render(on);
    assert.doesNotMatch(textOf(tree), /An observed change/);
    assert.match(textOf(button(tree)), /Summarize fictional report/);
    screen.requests[0].reject(new Error("Late failure must stay hidden"));
    await settle();
    assert.doesNotMatch(textOf(screen.render()), /Late failure/);
    assert.equal(screen.lateWrites, 0);
  } finally { screen.unmount(); }
});

test("old-view cleanup cannot cancel a new view request, and rapid activation starts one request", async () => {
  const screen = mount({ kind: "market", selection });
  try {
    const oldButton = button(screen.render());
    oldButton.props.onClick(); oldButton.props.onClick();
    assert.equal(screen.requests.length, 1);
    const nextSelection = { ...selection, currency: "USD" };
    const tree = screen.render({ kind: "market", selection: nextSelection }, { deferCleanup: true });
    button(tree).props.onClick();
    assert.equal(screen.requests.length, 2);
    screen.flushCleanups();
    assert.equal(screen.requests[0].signal.aborted, true);
    assert.equal(screen.requests[1].signal.aborted, false);
    assert.equal(screen.timers.size, 1);
    screen.requests[0].reject(new Error("Old view failed"));
    screen.requests[1].resolve(market(nextSelection));
    await settle();
    assert.match(textOf(screen.render()), /bitcoin · 7 days · USD/);
    assert.doesNotMatch(textOf(screen.render()), /Old view failed/);
    assert.equal(screen.timers.size, 0);
  } finally { screen.unmount(); }
});

test("unmount cancels outstanding work and timeout reports an accessible retryable error", async () => {
  const screen = mount({ kind: "market", selection });
  button(screen.render()).props.onClick();
  const first = screen.requests[0];
  screen.unmount();
  assert.equal(first.signal.aborted, true);
  assert.equal(screen.timers.size, 0);
  first.resolve(market()); await settle();
  assert.equal(screen.lateWrites, 0);

  const timed = mount({ kind: "market", selection });
  try {
    button(timed.render()).props.onClick();
    timed.fireTimers();
    assert.equal(timed.requests[0].signal.aborted, true);
    timed.requests[0].reject(new DOMException("Aborted", "AbortError")); await settle();
    const tree = timed.render();
    assert.match(textOf(find(tree, (node) => node.props.role === "alert")), /took too long/);
    assert.equal(button(tree).props.disabled, false);
    assert.equal(timed.timers.size, 0);
    const heading = find(tree, (node) => node.type === "h2");
    assert.equal(tree.props["aria-labelledby"], heading.props.id);
  } finally { timed.unmount(); }
});

test("deterministic source context identifies the independent OHLC snapshot and exclusive report periods", async () => {
  const screen = mount({ kind: "market", selection });
  try {
    let tree = screen.render();
    assert.match(textOf(tree), /AI explanation · OpenAI/);
    assert.match(textOf(tree), /separate public OHLC snapshot/);
    assert.match(textOf(tree), /candle samples may differ from the price line/);
    assert.doesNotMatch(textOf(tree), /OpenAI · local preview/);
    button(tree).props.onClick(); screen.requests[0].resolve(market()); await settle();
    tree = screen.render();
    assert.match(textOf(tree), /bitcoin · 7 days · GBP/);
    assert.match(textOf(tree), /42 4-hour candles · candle-close prices/);
    assert.match(textOf(tree), /Observed close times/);
    tree = screen.render({ kind: "fictional-report", selection: reportSelection });
    button(tree).props.onClick(); screen.requests[1].resolve(report()); await settle();
    const text = textOf(screen.render());
    assert.match(text, /Current fictional period · end exclusive/);
    assert.match(text, /Prior fictional period · end exclusive/);
    assert.match(text, /30 Oct 2026, 00:00 UTC – 6 Nov 2026, 00:00 UTC/);
    assert.match(text, /23 Oct 2026, 00:00 UTC – 30 Oct 2026, 00:00 UTC/);
    assert.match(text, /7 days · Business · UK/);
  } finally { screen.unmount(); }
});
