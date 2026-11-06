import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/market-headline.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { selectMarketHeadline } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("a valid market quote, including zero, keeps its own retrieval time", () => {
  const sample = { timestamp: 100, value: 12 };
  assert.deepEqual(selectMarketHeadline(0, "quote-time", sample, "chart-time"), { source: "quote", value: 0, updatedAt: null, retrievedAt: "quote-time" });
  assert.deepEqual(selectMarketHeadline(42, "quote-time", sample, "chart-time", "asset-update-time"), { source: "quote", value: 42, updatedAt: "asset-update-time", retrievedAt: "quote-time" });
});

test("a chart fallback carries its own retrieval and sample times", () => {
  assert.deepEqual(selectMarketHeadline(null, "unrelated-quote-time", { timestamp: 1234, value: 12 }, "chart-time"), {
    source: "chart", value: 12, retrievedAt: "chart-time", sampleAt: 1234,
  });
  assert.deepEqual(selectMarketHeadline(undefined, "unrelated-quote-time", { timestamp: Number.NaN, value: 0 }, null), {
    source: "chart", value: 0, retrievedAt: null, sampleAt: null,
  });
});

test("invalid or missing values are not presented as a market headline", () => {
  assert.deepEqual(selectMarketHeadline(Number.NaN, "quote-time", { timestamp: 1, value: -1 }, "chart-time"), {
    source: "unavailable", value: null, retrievedAt: null,
  });
  assert.deepEqual(selectMarketHeadline(-1, "quote-time", null, "chart-time"), {
    source: "unavailable", value: null, retrievedAt: null,
  });
});
