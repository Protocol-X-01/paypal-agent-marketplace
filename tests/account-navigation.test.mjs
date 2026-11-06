import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const cjs = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected account-navigation test module: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}
const navigation = await load("../src/lib/account-experience.ts");
const currency = await load("../src/lib/market-currency.ts");
const format = await load("../src/lib/market-format.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const Switch = (await load("../src/app/components/account-experience-switch.tsx", { "react/jsx-runtime": jsx, "./account-experience-switch.module.css": { __esModule: true, default: { experience: "test-experience", options: "test-options" } } })).default;
const Shell = (await load("../src/app/components/site-shell.tsx", {
  "react/jsx-runtime": jsx, "next/link": { __esModule: true, default: "Link" }, "@/lib/market-currency": currency, "@/lib/market-format": format,
  "./site-shell.module.css": { __esModule: true, default: {} },
})).default;
function nodes(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}

test("Account is canonical while older Business bookmarks select its Business experience", () => {
  assert.deepEqual(navigation.dashboardLocation("#business", false), { section: "account", businessBookmark: true });
  assert.deepEqual(navigation.dashboardLocation("#account", false), { section: "account", businessBookmark: false });
  assert.deepEqual(navigation.dashboardLocation("#portfolio", true), { section: "portfolio", businessBookmark: false });
  assert.deepEqual(navigation.dashboardLocation("#unknown", true), { section: "shop", businessBookmark: false });
  assert.deepEqual(navigation.dashboardLocation("", false), { section: "overview", businessBookmark: false });
});

test("desktop and mobile navigation each expose one Account entry and preserve modified clicks", () => {
  const calls = [];
  const tree = Shell({ children: null, activeSection: "account", onNavigate: (value) => calls.push(value), currency: "USD", currencyReady: true, onCurrencyChange() {}, onRefresh() {} });
  for (const label of ["Main navigation", "Mobile navigation"]) {
    const nav = nodes(tree).find((node) => node.type === "nav" && node.props["aria-label"] === label);
    const links = nodes(nav).filter((node) => node.type === "a");
    const account = links.filter((node) => node.props.href === "#account");
    assert.equal(account.length, 1);
    assert.ok(!links.some((node) => node.props.href === "#business"));
    assert.equal(account[0].props["aria-current"], "page");
    let prevented = false;
    account[0].props.onClick({ button: 0, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(calls.at(-1), "account");
    const before = calls.length;
    account[0].props.onClick({ button: 0, ctrlKey: true, preventDefault() { throw new Error("Modified click must retain browser behavior"); } });
    assert.equal(calls.length, before);
  }
});

test("the single account-experience control reports a presentation choice through its callback", () => {
  let experience = "personal";
  const render = () => Switch({ experience, onChange: (value) => { experience = value; } });
  const initial = render();
  assert.equal(initial.props.className, "test-experience");
  assert.equal(nodes(initial).find((node) => node.props?.["aria-label"] === "Account experience").props.className, "test-options");
  const buttons = nodes(initial).filter((node) => node.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props["aria-pressed"], true);
  assert.equal(buttons[1].props["aria-pressed"], false);
  buttons[1].props.onClick();
  const business = nodes(render()).filter((node) => node.type === "button");
  assert.equal(experience, "business");
  assert.equal(business[0].props["aria-pressed"], false);
  assert.equal(business[1].props["aria-pressed"], true);
});
