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
const web = load(await readFile(new URL("../src/lib/portfolio-allocation.ts", import.meta.url), "utf8"));
const native = load(await readFile(new URL("../apps/mobile/src/lib/portfolio-allocation.ts", import.meta.url), "utf8"));

test("both platforms withhold incomplete, zero or inconsistent totals", () => {
  for (const model of [web, native]) {
    assert.equal(model.portfolioAllocation([], null), null);
    assert.equal(model.portfolioAllocation([{ id: "btc", value: 0 }], 0), null);
    assert.equal(model.portfolioAllocation([{ id: "btc", value: 10 }, { id: "eth", value: null }], null), null);
    assert.equal(model.portfolioAllocation([{ id: "btc", value: 10 }, { id: "eth", value: null }], 10), null);
    assert.equal(model.portfolioAllocation([{ id: "btc", value: 10 }], 11), null);
    assert.equal(model.portfolioAllocation([{ id: "btc", value: -1 }], 1), null);
  }
});

test("both platforms calculate proportional slices and preserve very small shares", () => {
  const positions = [{ id: "btc", value: 9999 }, { id: "eth", value: 1 }, { id: "sol", value: 0 }];
  const result = web.portfolioAllocation(positions, 10000);
  assert.deepEqual(result, native.portfolioAllocation(positions, 10000));
  assert.equal(result[0].share, 99.99);
  assert.equal(result[1].share, 0.01);
  assert.equal(result[2].share, 0);
  assert.equal(web.allocationShareLabel(result[0].share), "More than 99.9%");
  assert.equal(web.allocationShareLabel(result[1].share), "Less than 0.1%");
  assert.equal(web.allocationShareLabel(result[2].share), "0.0%");
  assert.equal(web.allocationShareLabel(100), "100.0%");
});

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function createComponent() {
  let selected = null;
  const element = (type, props) => ({ type, props: props ?? {} });
  const Component = load(readFileSyncSource, {
    react: { useState: () => [selected, (value) => { selected = value; }], useMemo: (callback) => callback() },
    "ag-charts-react": { AgCharts: "AgCharts" },
    "ag-charts-community": { DonutSeriesModule: "donut-series" },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "@/lib/portfolio-allocation": web,
    "@/lib/market-format": { formatPortfolioMoney: (value, currency) => `${currency} ${value}` },
    "@/lib/market-chart-theme": { marketChartThemeFor: (appearance) => appearance },
    "./theme-preference": { useAppearance: () => ({ appearance: "dark" }) },
    "./portfolio-allocation.module.css": { __esModule: true, default: {} },
  }).default;
  return (portfolio) => Component({ portfolio, currency: "GBP", inputMessage: "", loading: false });
}
const readFileSyncSource = await readFile(new URL("../src/app/components/portfolio-allocation.tsx", import.meta.url), "utf8");

test("web legend and chart select the same asset without inventing an incomplete allocation", () => {
  const render = createComponent();
  const portfolio = { positions: [{ id: "bitcoin", value: 75 }, { id: "ethereum", value: 25 }], total: 100, dailyChange: null };
  let tree = render(portfolio);
  const button = (label) => nodes(tree).find((node) => node.type === "button" && node.props["aria-label"]?.startsWith(label));
  const chart = () => nodes(tree).find((node) => node.type === "AgCharts");
  const sliceData = (id) => chart().props.options.series[0].data.find((datum) => datum.id === id);
  const sliceStyle = (id) => chart().props.options.series[0].itemStyler({ datum: sliceData(id) });
  assert.equal(chart().props.options.series[0].type, "donut");
  assert.equal(button("Bitcoin").props["aria-pressed"], false);
  button("Bitcoin").props.onClick();
  tree = render(portfolio);
  assert.equal(button("Bitcoin").props["aria-pressed"], true);
  assert.equal(sliceStyle("bitcoin").strokeWidth, 3, "the chart highlights the selected Bitcoin slice");
  assert.equal(sliceStyle("ethereum").strokeWidth, 0, "other slices remain unselected");
  button("Ethereum").props.onClick();
  tree = render(portfolio);
  assert.equal(button("Ethereum").props["aria-pressed"], true);
  assert.equal(sliceStyle("ethereum").strokeWidth, 3, "the chart follows the selected accessible legend item");
  chart().props.options.series[0].listeners.seriesNodeClick({ datum: sliceData("bitcoin") });
  tree = render(portfolio);
  assert.equal(button("Bitcoin").props["aria-pressed"], true, "selecting a chart sector updates the accessible legend");
  assert.equal(sliceStyle("bitcoin").strokeWidth, 3, "selecting a chart sector highlights it");
  assert.ok(nodes(tree).some((node) => node.type === "strong" && node.props.children === "75.0%"));
  nodes(tree).find((node) => node.type === "button" && node.props.children === "Show total").props.onClick();
  tree = render(portfolio);
  assert.equal(button("Bitcoin").props["aria-pressed"], false, "show total clears the selected sector");
  tree = render({ ...portfolio, positions: [...portfolio.positions, { id: "solana", value: null }], total: null });
  assert.equal(nodes(tree).some((node) => node.type === "AgCharts"), false);
  assert.ok(nodes(tree).some((node) => node.props?.role === "status"));
});
