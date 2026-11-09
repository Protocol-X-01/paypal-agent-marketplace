import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
function load(source, aliases = {}) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "require", "module", code)(loaded.exports, (name) => Object.hasOwn(aliases, name) ? aliases[name] : nodeRequire(name), loaded);
  return loaded.exports;
}
const snapshot = load(await readFile(new URL("../src/lib/business-snapshot.ts", import.meta.url), "utf8"));
const nativeSnapshot = load(await readFile(new URL("../apps/mobile/src/lib/business-snapshot.ts", import.meta.url), "utf8"));
const web = load(await readFile(new URL("../src/lib/personal-accounting-lite.ts", import.meta.url), "utf8"), { "./business-snapshot": snapshot });
const native = load(await readFile(new URL("../apps/mobile/src/lib/personal-accounting-lite.ts", import.meta.url), "utf8"), { "./business-snapshot": nativeSnapshot });
const valid = (result) => { assert.equal(result.kind, "valid"); return result.minor; };

test("both clients parse exact currency minor units and reject ambiguous or incomplete inputs", () => {
  for (const api of [web, native]) {
    assert.equal(valid(api.parseLiteMoney("0.10", "GBP")), BigInt(10));
    assert.equal(valid(api.parseLiteMoney(".5", "USD")), BigInt(50));
    assert.equal(valid(api.parseLiteMoney("1.23", "HUF")), BigInt(123));
    assert.equal(valid(api.parseLiteMoney("123", "JPY")), BigInt(123));
    for (const value of ["1.001", "1,000", "-1", "1e3", "1000000000001"]) assert.equal(api.parseLiteMoney(value, "GBP").kind, "invalid");
    assert.equal(api.parseLiteMoney("1.0", "JPY").kind, "invalid");
    assert.equal(api.parseLiteMoney("1.", "GBP").kind, "incomplete");
    assert.equal(api.parseLiteMoney("", "GBP").kind, "empty");
    assert.equal(api.parseLiteMoney("1", "XYZ").kind, "invalid");
  }
});

test("cash flow and savings use exact arithmetic and explicit zero-contribution behavior", () => {
  for (const api of [web, native]) {
    const start = valid(api.parseLiteMoney("0.10", "GBP"));
    const income = valid(api.parseLiteMoney("0.20", "GBP"));
    const spend = valid(api.parseLiteMoney("0.05", "GBP"));
    assert.equal(api.formatLiteMoney(api.liteClosingAmount(start, income, spend), "GBP"), "GBP 0.25");
    assert.equal(api.formatLiteMoney(api.liteClosingAmount(start, BigInt(0), BigInt(30)), "GBP"), "−GBP 0.20");
    assert.equal(api.liteMonthsToTarget(BigInt(100), BigInt(351), BigInt(100)), BigInt(3));
    assert.equal(api.liteMonthsToTarget(BigInt(100), BigInt(100), BigInt(0)), BigInt(0));
    assert.equal(api.liteMonthsToTarget(BigInt(100), BigInt(101), BigInt(0)), null);
    assert.equal(api.roundedPortfolioMinor(null, "GBP"), null);
    assert.equal(api.roundedPortfolioMinor(12.345, "GBP"), BigInt(1235));
  }
});

test("web calculator uses a currency-keyed session and does not offer an unavailable portfolio", async () => {
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const slots = [];
  let cursor = 0;
  const Component = load(await readFile(new URL("../src/app/components/personal-accounting-lite.tsx", import.meta.url), "utf8"), {
    react: { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = value; }]; } },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "@/lib/personal-accounting-lite": web,
    "./personal-accounting-lite.module.css": { __esModule: true, default: {} },
  }).default;
  const root = Component({ currency: "GBP", portfolioTotal: null, portfolioAvailable: false });
  assert.equal(root.key, "GBP");
  assert.equal(Component({ currency: "USD", portfolioTotal: null, portfolioAvailable: false }).key, "USD");
  cursor = 0;
  const tree = root.type(root.props);
  const nodes = (value) => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
  const portfolioButton = nodes(tree).find((node) => node.type === "button" && node.props.children === "Use portfolio estimate");
  assert.equal(portfolioButton.props.disabled, true);
});

test("web playground retains and rejects an overlong paste in every amount field", async () => {
  const element = (type, props, key) => ({ type, props: props ?? {}, key });
  const slots = [];
  let cursor = 0;
  const Component = load(await readFile(new URL("../src/app/components/personal-accounting-lite.tsx", import.meta.url), "utf8"), {
    react: { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = value; }]; } },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "@/lib/personal-accounting-lite": web,
    "./personal-accounting-lite.module.css": { __esModule: true, default: {} },
  }).default;
  const root = Component({ currency: "GBP", portfolioTotal: null, portfolioAvailable: false });
  function expand(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(expand);
    if (typeof value.type === "function") return expand(value.type(value.props));
    return { ...value, props: { ...value.props, children: expand(value.props?.children) } };
  }
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
  const render = () => { cursor = 0; return expand(root.type(root.props)); };
  let tree = render();
  const input = (id) => nodes(tree).find((node) => node.type === "input" && node.props.id === id);
  const enter = (id, value) => {
    const field = input(id);
    assert.ok(field, `Missing ${id}`);
    // A browser enforces maxLength before onChange, including on paste.
    const delivered = typeof field.props.maxLength === "number" ? value.slice(0, field.props.maxLength) : value;
    field.props.onChange({ target: { value: delivered } });
    tree = render();
  };
  const result = (sectionId) => {
    const section = nodes(tree).find((node) => node.type === "section" && node.props["aria-labelledby"] === sectionId);
    return text(nodes(section).find((node) => node.type === "strong"));
  };
  const fields = [
    ["lite-start", "100.00", true, true],
    ["lite-income", "50.00", true, false],
    ["lite-spending", "25.00", true, false],
    ["lite-target", "300.00", false, true],
    ["lite-monthly", "75.00", false, true],
  ];
  for (const [id, value] of fields) enter(id, value);
  assert.equal(result("lite-cashflow-title"), "GBP 125.00");
  assert.equal(result("lite-savings-title"), "3 months");
  const pasted = "0".repeat(32) + "1";
  assert.equal(web.parseLiteMoney("0".repeat(32), "GBP").kind, "valid");
  assert.equal(web.parseLiteMoney(pasted, "GBP").kind, "invalid");
  for (const [id, validValue, cashflowInvalid, savingsInvalid] of fields) {
    enter(id, pasted);
    assert.equal(input(id).props.value, pasted, `${id} must retain the complete pasted amount`);
    assert.equal(input(id).props["aria-invalid"], true);
    assert.match(text(nodes(tree).find((node) => node.props?.id === `${id}-error`)), /no more than 32 characters/i);
    assert.equal(result("lite-cashflow-title"), cashflowInvalid ? "—" : "GBP 125.00");
    assert.equal(result("lite-savings-title"), savingsInvalid ? "—" : "3 months");
    enter(id, validValue);
    assert.equal(result("lite-cashflow-title"), "GBP 125.00");
    assert.equal(result("lite-savings-title"), "3 months");
  }
});
