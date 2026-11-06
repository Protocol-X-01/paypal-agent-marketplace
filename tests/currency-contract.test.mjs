import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const web = await loadTypeScript("../src/lib/market-currency.ts");
const mobile = await loadTypeScript("../apps/mobile/src/lib/currency.ts");
const spec = await readFile(new URL("../postman/specs/market-data.yaml", import.meta.url), "utf8");

test("website, mobile, and API contract offer the same unique currencies", () => {
  const match = spec.match(/MarketCurrency:\s*\n\s*type: string\s*\n\s*enum: \[([^\]]+)\]/);
  assert.ok(match, "MarketCurrency enum is present in the API contract");
  const contract = match[1].split(",").map((value) => value.trim());
  const mobileCodes = mobile.DISPLAY_CURRENCIES.map((item) => item.code);
  assert.equal(new Set(web.MARKET_CURRENCIES).size, web.MARKET_CURRENCIES.length);
  assert.deepEqual(mobileCodes, web.MARKET_CURRENCIES);
  assert.deepEqual(contract, web.MARKET_CURRENCIES);
});

test("currency guards reject unsupported and malformed preferences", () => {
  for (const value of ["XYZ", "usd", "", null, undefined, 123]) {
    assert.equal(web.isMarketCurrency(value), false);
    assert.equal(mobile.isDisplayCurrency(value), false);
  }
  assert.equal(mobile.DEFAULT_DISPLAY_CURRENCY, "USD");
  assert.equal(web.isMarketCurrency("GBP"), true);
  assert.equal(mobile.isDisplayCurrency("GBP"), true);
});
