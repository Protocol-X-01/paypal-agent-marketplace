import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module in chart viewport test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const viewport = await load("../src/lib/chart-viewport.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const ChartZoomControls = (await load("../src/app/components/chart-zoom-controls.tsx", {
  "react/jsx-runtime": jsx,
  "@/lib/chart-viewport": viewport,
})).default;

function nodes(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}

function makeControls(initialPoints) {
  let points = initialPoints;
  let view = viewport.FULL_CHART_VIEWPORT;
  const visible = () => viewport.visibleChartPoints(points, view);
  function render() {
    return ChartZoomControls({ viewport: view, points, visiblePoints: visible(), onAction(action) {
      view = action === "reset" ? viewport.FULL_CHART_VIEWPORT : viewport.chartViewportAction(view, action, points.length);
    } });
  }
  function button(label) {
    const result = nodes(render()).find((node) => node.type === "button" && node.props["aria-label"] === label);
    assert.ok(result, `Expected ${label} control`);
    return result;
  }
  return { render, button, visible, replacePoints(next) { points = next; } };
}

test("five observations zoom to a real three-point chart window", () => {
  const points = [1, 2, 3, 4, 5].map((value) => ({ timestamp: value * 1_000, value }));
  const chart = makeControls(points);
  assert.equal(chart.button("Zoom out").props.disabled, true);
  assert.equal(chart.button("Zoom in").props.disabled, false);
  chart.button("Zoom in").props.onClick();
  assert.deepEqual(chart.visible().map((point) => point.value), [3, 4, 5]);
  assert.equal(chart.button("Zoom in").props.disabled, true);
  assert.equal(chart.button("Show later chart points").props.disabled, true);
});

test("a one-year series can zoom beyond four times, pan, and reset", () => {
  const points = Array.from({ length: 365 }, (_, index) => ({ timestamp: index * 86_400_000, value: index + 1 }));
  const chart = makeControls(points);
  for (let step = 0; step < 5; step += 1) chart.button("Zoom in").props.onClick();
  const latest = chart.visible();
  assert.ok(latest.length >= 3 && latest.length <= 14);
  assert.equal(latest.at(-1), points.at(-1));
  assert.match(text(chart.render()), /30\.3× view/);
  chart.button("Show earlier chart points").props.onClick();
  assert.ok(chart.visible().at(-1).timestamp < latest.at(-1).timestamp);
  chart.button("Show later chart points").props.onClick();
  assert.deepEqual(chart.visible(), latest);
  chart.button("Reset chart zoom").props.onClick();
  assert.deepEqual(chart.visible(), points);
});

test("the announced zoom reflects elapsed time for irregular observations", () => {
  const points = [0, 1, 2, 3, 4, 100].map((timestamp) => ({ timestamp, value: timestamp }));
  const chart = makeControls(points);
  chart.button("Zoom in").props.onClick();
  assert.deepEqual(chart.visible().map((point) => point.timestamp), [2, 3, 4, 100]);
  assert.match(text(chart.render()), /1\.0× view/);
  assert.doesNotMatch(text(chart.render()), /2\.0× view/);
  assert.equal(viewport.chartZoomLabel([{ timestamp: 5 }, { timestamp: 5 }], [{ timestamp: 5 }, { timestamp: 5 }]), "View range unavailable");
});

test("a shorter refreshed series keeps three points and can pan or reset", () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ timestamp: index * 1_000, value: index + 1 }));
  const chart = makeControls(points);
  for (let step = 0; step < 5; step += 1) chart.button("Zoom in").props.onClick();
  chart.replacePoints(points.slice(0, 4));
  assert.deepEqual(chart.visible(), points.slice(1, 4));
  assert.equal(chart.button("Zoom in").props.disabled, true);
  chart.button("Show earlier chart points").props.onClick();
  assert.deepEqual(chart.visible(), points.slice(0, 3));
  chart.button("Zoom out").props.onClick();
  assert.deepEqual(chart.visible(), points.slice(0, 4));
});
