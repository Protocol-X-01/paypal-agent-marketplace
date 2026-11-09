import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
function load(source, aliases = {}, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nodeRequire(name);
  new Function("exports", "require", "module", ...Object.keys(globals), compiled)(cjsModule.exports, require, cjsModule, ...Object.values(globals));
  return cjsModule.exports;
}
const planSource = await readFile(new URL("../src/lib/business-plan-storage.ts", import.meta.url), "utf8");
const componentSource = await readFile(new URL("../src/app/components/business-monitoring.tsx", import.meta.url), "utf8");
const business = load(planSource);
const RESET = "synthetic-reset-signal";

function makeWindow() {
  const values = new Map([[business.BUSINESS_PLAN_STORAGE_KEY, JSON.stringify(business.createDefaultPlan())]]);
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let failWrite = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw new Error("synthetic quota failure"); values.set(key, value); },
    removeItem: (key) => values.delete(key),
  };
  return {
    localStorage: storage,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name, event) { for (const callback of [...(listeners.get(name) ?? [])]) callback(event); },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    restoreWrites() { failWrite = false; },
  };
}

function mountBusiness(windowMock, draftRef, onDraftChange) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(callback) { cursor += 1; return callback(); },
    useCallback(callback) { cursor += 1; return callback; },
    useEffect(callback) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = {}; effects.push(() => { slots[index].cleanup = callback(); }); }
    },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const noopModule = { __esModule: true, default: () => null };
  const aliases = {
    react: hooks,
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "ag-grid-community": { themeQuartz: { withParams: () => ({}) } },
    "ag-grid-enterprise": { AllEnterpriseModule: {} },
    "ag-grid-react": { AgGridProvider: () => null, AgGridReact: () => null },
    "@/lib/business-plan-storage": business,
    "@/lib/portfolio-input": { LOCAL_DATA_RESET_SIGNAL: RESET },
    "@/lib/business-snapshot": { formatBusinessMinorAmount: (value, currency) => `${currency} ${value / 100}` },
    "@/lib/business-percentage": { formatBusinessPercentage: (value) => value === null ? "Unavailable" : `${value}%` },
    "./business-snapshot-panel": noopModule,
    "./paypal-activity-panel": noopModule,
    "./business-monitoring.module.css": { __esModule: true, default: {} },
    "./customer-session": { usePrivateDataScope: () => ({ ready: true, storage: windowMock.localStorage, events: windowMock, label: "Guest test data" }) },
  };
  const Component = load(componentSource, aliases, { window: windowMock }).default;
  function render() { cursor = 0; return Component({ draftRef, onDraftChange }); }
  function settle() { render(); while (effects.length) effects.shift()(); windowMock.flushTimers(); return render(); }
  return { render, settle, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}
function findButton(node, label) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = findButton(child, label); if (found) return found; } return null; }
  if (node.type === "button" && textOf(node.props.children) === label) return node;
  return findButton(node.props?.children, label);
}
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = findNode(child, predicate); if (found) return found; } return null; }
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

test("an unsaved plan survives a Business section remount and an explicit reset clears it", () => {
  const windowMock = makeWindow();
  const draftRef = { current: null };
  let pending = false;
  const changed = (value) => { pending = value; };
  const first = mountBusiness(windowMock, draftRef, changed);
  const initial = first.settle();
  const pointOfSale = findNode(initial, (node) => node.type === "a" && node.props.href === "https://www.paypal.com/uk/business/pos-system");
  assert.equal(pointOfSale.props.target, "_blank");
  assert.match(textOf(pointOfSale), /UK info/);
  const gatedInput = (tree) => {
    const label = findNode(tree, (node) => node.type === "label" && textOf(node).includes("Active customer accounts"));
    return findNode(label, (node) => node.type === "input");
  };
  assert.equal(gatedInput(initial).props.disabled, true);
  assert.equal(findButton(initial, "Summary").props["aria-pressed"], false);
  findButton(initial, "Summary").props.onClick();
  const leadership = first.render();
  assert.equal(gatedInput(leadership).props.disabled, true);
  gatedInput(leadership).props.onChange({ target: { checked: true } });
  assert.equal(draftRef.current.plan.views.leadership.indicators.includes("customerAccounts"), false);
  assert.equal(draftRef.current.plan.perspective, "leadership");
  assert.equal(pending, true);
  assert.equal(JSON.parse(windowMock.localStorage.getItem(business.BUSINESS_PLAN_STORAGE_KEY)).perspective, "teams");
  assert.deepEqual(Object.keys(draftRef.current).sort(), ["baseline", "plan"]);
  first.unmount();

  const second = mountBusiness(windowMock, draftRef, changed);
  const restored = second.settle();
  assert.equal(findButton(restored, "Summary").props["aria-pressed"], true);
  assert.ok(findButton(restored, "Load saved plan"));
  assert.ok(findButton(restored, "Replace saved plan with this draft"));
  windowMock.localStorage.removeItem(business.BUSINESS_PLAN_STORAGE_KEY);
  windowMock.emit("storage", { key: RESET, newValue: "synthetic", storageArea: windowMock.localStorage });
  const reset = second.render();
  assert.equal(draftRef.current, null);
  assert.equal(pending, false);
  assert.equal(findButton(reset, "Activity").props["aria-pressed"], true);
  second.unmount();
});

test("the business overview uses only a loaded report and clears its report totals", () => {
  const screen = mountBusiness(makeWindow(), { current: null }, () => {});
  let tree = screen.settle();
  assert.match(textOf(tree), /No PayPal business account is connected/);
  assert.doesNotMatch(textOf(tree), /GBP 1200/);
  const snapshot = { currency: "GBP", periods: { current: { transactions: 120, grossMinor: 120000 } }, summary: { refundRatioPct: 2.5 } };
  findNode(tree, (node) => typeof node.props?.onSnapshotChange === "function").props.onSnapshotChange(true, snapshot);
  tree = screen.render();
  assert.match(textOf(tree), /AGGREGATE CSV · UNVERIFIED/);
  assert.match(textOf(tree), /GBP 1200/);
  findNode(tree, (node) => typeof node.props?.onSnapshotChange === "function").props.onSnapshotChange(false, null);
  tree = screen.render();
  assert.doesNotMatch(textOf(tree), /GBP 1200/);
  screen.unmount();
});

test("the overview labels a PayPal export as checkout rows and never invents amounts", () => {
  const screen = mountBusiness(makeWindow(), { current: null }, () => {});
  let tree = screen.settle();
  const report = { current: { included: 17 }, previous: { included: 15 } };
  findNode(tree, (node) => typeof node.props?.onReportChange === "function").props.onReportChange(true, report);
  tree = screen.render();
  const overview = findNode(tree, (node) => node.props?.["aria-labelledby"] === "business-overview-title");
  assert.match(textOf(overview), /PAYPAL EXPORT · UNVERIFIED/);
  assert.match(textOf(overview), /Included checkout rows17Completed credit rows · current period/);
  assert.match(textOf(overview), /Gross activity—Not calculated from this export/);
  assert.match(textOf(overview), /Refund ratio—Not calculated from this export/);
  assert.doesNotMatch(textOf(overview), /Choose a report/);
  findNode(tree, (node) => typeof node.props?.onReportChange === "function").props.onReportChange(false, null);
  tree = screen.render();
  const cleared = findNode(tree, (node) => node.props?.["aria-labelledby"] === "business-overview-title");
  assert.doesNotMatch(textOf(cleared), /Included checkout rows17/);
  assert.match(textOf(cleared), /ACCOUNT PREVIEW/);
  screen.unmount();
});

test("when both reports are open, overview values come only from the labeled aggregate CSV", () => {
  const screen = mountBusiness(makeWindow(), { current: null }, () => {});
  let tree = screen.settle();
  const report = { current: { included: 17 }, previous: { included: 15 } };
  const snapshot = { currency: "GBP", periods: { current: { transactions: 120, grossMinor: 120000 } }, summary: { refundRatioPct: 2.5 } };
  findNode(tree, (node) => typeof node.props?.onReportChange === "function").props.onReportChange(true, report);
  tree = screen.render();
  findNode(tree, (node) => typeof node.props?.onSnapshotChange === "function").props.onSnapshotChange(true, snapshot);
  tree = screen.render();
  let overview = findNode(tree, (node) => node.props?.["aria-labelledby"] === "business-overview-title");
  assert.match(textOf(overview), /AGGREGATE CSV · UNVERIFIED/);
  assert.match(textOf(overview), /Report activity120Transactions · current period/);
  assert.match(textOf(overview), /GBP 1200/);
  assert.doesNotMatch(textOf(overview), /Included checkout rows17/);
  findNode(tree, (node) => typeof node.props?.onSnapshotChange === "function").props.onSnapshotChange(false, null);
  tree = screen.render();
  overview = findNode(tree, (node) => node.props?.["aria-labelledby"] === "business-overview-title");
  assert.match(textOf(overview), /PAYPAL EXPORT · UNVERIFIED/);
  assert.match(textOf(overview), /Included checkout rows17/);
  findNode(tree, (node) => typeof node.props?.onSnapshotChange === "function").props.onSnapshotChange(true, snapshot);
  tree = screen.render();
  findNode(tree, (node) => typeof node.props?.onReportChange === "function").props.onReportChange(false, null);
  tree = screen.render();
  overview = findNode(tree, (node) => node.props?.["aria-labelledby"] === "business-overview-title");
  assert.match(textOf(overview), /AGGREGATE CSV · UNVERIFIED/);
  assert.match(textOf(overview), /Report activity120/);
  assert.doesNotMatch(textOf(overview), /Included checkout rows17/);
  screen.unmount();
});
