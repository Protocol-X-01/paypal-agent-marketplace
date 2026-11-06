import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjs = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected chart wheel dependency: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjs.exports, require, cjs);
  return cjs.exports;
}

const wheel = await load("../src/lib/chart-wheel.ts");
const line = await load("../src/lib/chart-viewport.ts");
const candles = await load("../src/lib/web-candle-data.ts");
const bounds = { left: 100, top: 50, width: 400, height: 240 };

function surface() {
  let listener = null;
  let addedOptions = null;
  let removedCapture = null;
  let clock = 0;
  const element = {
    addEventListener(type, fn, options) { assert.equal(type, "wheel"); listener = fn; addedOptions = options; },
    removeEventListener(type, fn, capture) { assert.equal(type, "wheel"); assert.equal(listener, fn); listener = null; removedCapture = capture; },
  };
  function send(overrides = {}) {
    let prevented = false;
    clock += 16;
    const event = { clientX: 300, clientY: 120, deltaX: 0, deltaY: -48, deltaMode: 0, timeStamp: clock, cancelable: true, defaultPrevented: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: { closest: () => null }, ...overrides, preventDefault() { prevented = true; } };
    listener?.(event);
    return prevented;
  }
  return { element, send, options: () => addedOptions, removed: () => removedCapture };
}

test("native wheel binding is non-passive, uses actual plot bounds and cleans up", () => {
  const app = surface();
  let changes = 0;
  const close = wheel.bindPlotWheelZoom(app.element, { getBounds: () => bounds, canZoom: () => true, onZoom(direction, steps, ratio) { assert.equal(direction, "in"); assert.equal(steps, 1); assert.equal(ratio, .5); changes++; return true; } });
  assert.deepEqual(app.options(), { passive: false, capture: true });
  assert.equal(app.send(), true);
  assert.equal(changes, 1);
  for (const point of [{ clientX: 99 }, { clientX: 501 }, { clientY: 49 }, { clientY: 291 }]) assert.equal(app.send(point), false);
  assert.equal(changes, 1);
  close();
  assert.equal(app.removed(), true);
  assert.equal(app.send(), false);
  assert.equal(changes, 1);
});

test("axes, menus, browser zoom gestures and horizontal scrolling are left alone", () => {
  const app = surface();
  let changes = 0;
  const close = wheel.bindPlotWheelZoom(app.element, { getBounds: () => bounds, canZoom: () => true, onZoom() { changes++; return true; } });
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { deltaX: 100, deltaY: 10 }, { deltaY: 0 }, { cancelable: false }, { defaultPrevented: true }]) assert.equal(app.send(flags), false);
  assert.equal(app.send({ target: { closest(selector) { assert.match(selector, /details/); assert.match(selector, /button/); return {}; } } }), false);
  assert.equal(changes, 0);
  close();
  for (const invalid of [null, { ...bounds, width: 0 }, { ...bounds, height: NaN }]) {
    const dispose = wheel.bindPlotWheelZoom(app.element, { getBounds: () => invalid, canZoom: () => true, onZoom() { throw new Error("Unknown plot bounds must not zoom"); } });
    assert.equal(app.send(), false);
    dispose();
  }
});

test("pixel, line and page deltas normalize with bounded high-frequency accumulation", () => {
  assert.equal(wheel.normalizedWheelPixels(3, 1, 240), 48);
  assert.equal(wheel.normalizedWheelPixels(1, 2, 240), 192);
  assert.equal(wheel.normalizedWheelPixels(-10000, 0, 240), -192);
  assert.equal(wheel.normalizedWheelPixels(NaN, 0, 240), 0);
  const app = surface();
  const changes = [];
  const close = wheel.bindPlotWheelZoom(app.element, { getBounds: () => bounds, canZoom: () => true, onZoom(direction, steps) { changes.push([direction, steps]); return true; } });
  for (let i = 0; i < 47; i++) assert.equal(app.send({ deltaY: -1 }), true);
  assert.equal(changes.length, 0);
  app.send({ deltaY: -1 });
  assert.deepEqual(changes, [["in", 1]]);
  app.send({ deltaY: 3, deltaMode: 1 });
  app.send({ deltaY: 1, deltaMode: 2 });
  assert.deepEqual(changes, [["in", 1], ["out", 1], ["out", 4]]);
  close();
});

test("small opposite or separated gestures do not combine into a surprise zoom", () => {
  const app = surface();
  let changes = 0;
  const close = wheel.bindPlotWheelZoom(app.element, { getBounds: () => bounds, canZoom: () => true, onZoom() { changes++; return true; } });
  app.send({ deltaY: -30, timeStamp: 100 });
  app.send({ deltaY: 30, timeStamp: 120 });
  assert.equal(changes, 0);
  app.send({ deltaY: 30, timeStamp: 500 });
  assert.equal(changes, 0);
  app.send({ deltaY: 18, timeStamp: 520 });
  assert.equal(changes, 1);
  close();
});

test("line wheel zoom keeps the pointer time on a contiguous actual-sample window", () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ timestamp: index * 1000 }));
  const next = line.chartViewportWheelZoom(points, line.FULL_CHART_VIEWPORT, .8, .25);
  const visible = line.visibleChartPoints(points, next);
  assert.equal(visible.length, 80);
  const beforeAnchor = points[0].timestamp + .25 * (points.at(-1).timestamp - points[0].timestamp);
  const afterAnchor = visible[0].timestamp + .25 * (visible.at(-1).timestamp - visible[0].timestamp);
  assert.equal(afterAnchor, beforeAnchor);
  assert.equal(line.visibleChartPoints(points, line.chartViewportWheelZoom(points, line.FULL_CHART_VIEWPORT, .8, 0))[0], points[0]);
  assert.equal(line.visibleChartPoints(points, line.chartViewportWheelZoom(points, line.FULL_CHART_VIEWPORT, .8, 1)).at(-1), points.at(-1));
  const irregular = [0, 100, 101, 102, 103, 104, 105, 106, 107, 108].map((timestamp) => ({ timestamp }));
  const irregularView = line.chartViewportWheelZoom(irregular, line.FULL_CHART_VIEWPORT, .8, .8);
  assert.deepEqual(line.visibleChartPoints(irregular, irregularView), irregular.slice(0, 8));
  assert.equal(line.chartViewportWheelZoom(points.slice(0, 3), line.FULL_CHART_VIEWPORT, .8, .5), line.FULL_CHART_VIEWPORT);
});

test("line and candle windows stop at three real observations and release scroll at hard limits", () => {
  const points = Array.from({ length: 17 }, (_, index) => ({ timestamp: index * 1000 }));
  let view = line.FULL_CHART_VIEWPORT;
  const app = surface();
  const project = (current, direction, ratio) => line.chartViewportWheelZoom(points, current, direction === "in" ? .8 : 1.25, ratio);
  const close = wheel.bindPlotWheelZoom(app.element, { getBounds: () => bounds, canZoom: (direction, ratio) => project(view, direction, ratio) !== view, onZoom(direction, steps, ratio) { const previous = view; for (let i = 0; i < steps; i++) view = project(view, direction, ratio); return view !== previous; } });
  assert.equal(app.send({ deltaY: 1 }), false);
  for (let i = 0; i < 25; i++) app.send({ deltaY: -48 });
  assert.equal(line.visibleChartPoints(points, view).length, 3);
  assert.equal(app.send({ deltaY: -1 }), false);
  for (let i = 0; i < 25; i++) app.send({ deltaY: 48 });
  assert.deepEqual(line.visibleChartPoints(points, view), points);
  assert.equal(app.send({ deltaY: 1 }), false);
  close();
  let candleView = { start: 0, end: 17 };
  const hovered = 4;
  candleView = candles.candleWindowWheelZoom(17, candleView, .8, .25);
  assert.ok(candleView.start <= hovered && candleView.end > hovered);
  assert.ok(Number.isInteger(candleView.start) && Number.isInteger(candleView.end));
  for (let i = 0; i < 25; i++) candleView = candles.candleWindowWheelZoom(17, candleView, .8, .25);
  assert.equal(candleView.end - candleView.start, 3);
  assert.equal(candles.candleWindowWheelZoom(17, candleView, .8, .25), candleView);
  for (let i = 0; i < 25; i++) candleView = candles.candleWindowWheelZoom(17, candleView, 1.25, .25);
  assert.deepEqual(candleView, { start: 0, end: 17 });
  assert.equal(candles.candleWindowWheelZoom(17, candleView, 1.25, .25), candleView);
  assert.equal(candles.candleWindowWheelZoom(3, { start: 0, end: 3 }, .8, .5).end, 3);
});

test("AG bounds come from its rendered series rectangle and fail open if absent", () => {
  assert.equal(wheel.agChartPlotBounds(null), null);
  assert.equal(wheel.agChartPlotBounds({ querySelector: () => null }), null);
  const rect = { ...bounds };
  assert.equal(wheel.agChartPlotBounds({ querySelector(selector) { assert.equal(selector, ".ag-charts-series-area"); return { getBoundingClientRect: () => rect }; } }), rect);
});

test("the hook keeps consecutive native wheel events current and removes its listener", async () => {
  const app = surface();
  let cleanup;
  const hook = await load("../src/app/components/use-plot-wheel-zoom.ts", { react: { useEffect(fn) { cleanup = fn(); } }, "@/lib/chart-wheel": wheel });
  const points = Array.from({ length: 100 }, (_, index) => ({ timestamp: index * 1000 }));
  const results = [];
  hook.usePlotWheelZoom({ elementRef: { current: app.element }, view: line.FULL_CHART_VIEWPORT, getBounds: () => bounds, project: (view, factor, ratio) => line.chartViewportWheelZoom(points, view, factor, ratio), onChange(next) { results.push(line.visibleChartPoints(points, next).length); } });
  app.send(); app.send(); app.send();
  assert.deepEqual(results, [80, 64, 51]);
  cleanup();
  assert.equal(app.send(), false);
  assert.deepEqual(results, [80, 64, 51]);
});
