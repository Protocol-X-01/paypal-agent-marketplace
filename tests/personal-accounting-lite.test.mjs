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
