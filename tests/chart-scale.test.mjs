import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/chart-scale.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { chartPercentageChange, chronologicalChartPoints, visibleChartDomain } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("orders a copy chronologically and preserves equal-time provider order", () => {
  const points = Object.freeze([
    Object.freeze({ timestamp: 300, value: 30 }),
    Object.freeze({ timestamp: 100, value: 10 }),
    Object.freeze({ timestamp: 200, value: 20 }),
    Object.freeze({ timestamp: 200, value: 21 }),
    Object.freeze({ timestamp: 100, value: 11 }),
  ]);
  const ordered = chronologicalChartPoints(points);
  assert.notEqual(ordered, points);
  assert.deepEqual(ordered.map(({ timestamp, value }) => [timestamp, value]), [[100, 10], [100, 11], [200, 20], [200, 21], [300, 30]]);
  assert.deepEqual(points.map(({ timestamp }) => timestamp), [300, 100, 200, 200, 100]);
  assert.equal(ordered.at(-1), points[0]);
  assert.equal(chartPercentageChange(ordered), 200);
  assert.deepEqual(chronologicalChartPoints([]), []);
});

test("duplicate-only timestamps cannot produce a period change", () => {
  const points = chronologicalChartPoints([{ timestamp: 100, value: 10 }, { timestamp: 100, value: 20 }]);
  assert.deepEqual(points.map(({ value }) => value), [10, 20]);
  assert.equal(chartPercentageChange(points), null);
  assert.equal(chartPercentageChange([{ timestamp: 1, value: 0 }, { timestamp: 2, value: 20 }]), null);
  assert.equal(chartPercentageChange([{ timestamp: 1, value: Number.MIN_VALUE }, { timestamp: 2, value: Number.MAX_VALUE }]), null);
});

test("pads visible prices without forcing a positive range to zero", () => {
  const domain = visibleChartDomain([76000, 77000, 78000]);
  assert.ok(domain.min > 0 && domain.min < 76000);
  assert.ok(domain.max > 78000);
});

test("recomputes the scale for the currently visible points", () => {
  const full = visibleChartDomain([100, 110, 120, 130]);
  const zoomed = visibleChartDomain([120, 130]);
  assert.ok(zoomed.min > full.min);
  assert.ok(zoomed.max >= 130);
});

test("retains the USD stablecoin reference in the visible scale", () => {
  const domain = visibleChartDomain([1.0001, 1.0003], true);
  assert.ok(domain.min < 0.98 && domain.max > 1.02);
  assert.ok(domain.min < 1 && domain.max > 1);
});

test("handles flat, zero and invalid series", () => {
  const flat = visibleChartDomain([100, 100]);
  assert.ok(flat.min < 100 && flat.max > 100);
  assert.deepEqual(visibleChartDomain([0, 0]), { min: 0, max: 1 });
  assert.equal(visibleChartDomain([Number.NaN, Number.POSITIVE_INFINITY]), null);
});
