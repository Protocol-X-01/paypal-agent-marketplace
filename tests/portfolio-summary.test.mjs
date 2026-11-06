import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// The installed Node build lacks native TypeScript support; transpile the
// production helpers without rewriting or duplicating their implementation.
async function loadTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { calculatePortfolio } = await loadTypeScript("../src/lib/portfolio-summary.ts");
const { formatMarketMoney } = await loadTypeScript("../src/lib/market-format.ts");

const tracked = ["bitcoin", "ethereum"];
const holdings = { bitcoin: 2, ethereum: 3 };
const quote = (price, change24hPct) => ({ price, change24hPct });

test("calculates a total and 24h movement only when all positions are complete", () => {
  const result = calculatePortfolio(holdings, new Map([
    ["bitcoin", quote(100, 25)],
    ["ethereum", quote(50, -20)],
  ]), tracked);
  assert.equal(result.total, 350);
  assert.equal(result.dailyChange, 2.5);
  assert.equal(result.positions.length, 2);
});

test("preserves each entered holding and withholds totals when a quote or price is missing", () => {
  for (const quotes of [new Map([["bitcoin", quote(100, 25)]]), new Map([
    ["bitcoin", quote(100, 25)],
    ["ethereum", quote(null, -20)],
  ]), new Map()]) {
    const result = calculatePortfolio(holdings, quotes, tracked);
    assert.deepEqual(result.positions.map((position) => position.id), tracked);
    assert.equal(result.positions[1].amount, 3);
    assert.equal(result.total, null);
    assert.equal(result.dailyChange, null);
  }
});

test("keeps a complete total but withholds the 24h movement if one percentage is unavailable", () => {
  const result = calculatePortfolio(holdings, new Map([
    ["bitcoin", quote(100, 25)],
    ["ethereum", quote(50, null)],
  ]), tracked);
  assert.equal(result.total, 350);
  assert.equal(result.dailyChange, null);
});

test("handles zero prices and rejects undefined -100% change calculations", () => {
  const zero = calculatePortfolio({ bitcoin: 2 }, new Map([["bitcoin", quote(0, 0)]]), tracked);
  assert.equal(zero.total, 0);
  assert.equal(zero.dailyChange, 0);
  const lost = calculatePortfolio({ bitcoin: 2 }, new Map([["bitcoin", quote(0, -100)]]), tracked);
  assert.equal(lost.total, 0);
  assert.equal(lost.dailyChange, null);
});

test("withholds non-finite valuations", () => {
  const result = calculatePortfolio({ bitcoin: 2 }, new Map([["bitcoin", quote(Number.MAX_VALUE, 1)]]), tracked);
  assert.equal(result.positions[0].value, null);
  assert.equal(result.total, null);
  assert.equal(result.dailyChange, null);
});

test("retains PYUSD unit-price precision across currencies without changing normal totals", () => {
  assert.equal(formatMarketMoney(1.000043, "USD", 4), "$1.000043");
  assert.equal(formatMarketMoney(0.79, "GBP", 4), "£0.7900");
  assert.equal(formatMarketMoney(151.23, "JPY", 4), "¥151.2300");
  assert.equal(formatMarketMoney(1, "USD"), "$1.00");
});
