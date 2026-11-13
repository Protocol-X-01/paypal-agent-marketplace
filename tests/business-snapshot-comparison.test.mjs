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
    throw new Error(`Unexpected module in synthetic Business test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const snapshotModule = await load("../src/lib/business-snapshot.ts");
const channelComparison = await load("../src/lib/business-channel-comparison.ts", { "./business-snapshot": snapshotModule });
const businessPercentage = await load("../src/lib/business-percentage.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const header = "window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at";

function csv(previous, current, currency = "GBP") {
  return [
    header,
    `7,previous,2026-10-23,2026-10-30,online,${currency},${previous.join(",")},2026-11-06T00:00:00Z`,
    `7,current,2026-10-30,2026-11-06,online,${currency},${current.join(",")},2026-11-06T00:00:00Z`,
  ].join("\n");
}

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

async function createPanel() {
  const slots = [];
  let cursor = 0;
  const changed = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(callback) { cursor += 1; return callback(); },
    useEffect() { cursor += 1; },
  };
  const Component = (await load("../src/app/components/business-snapshot-panel.tsx", {
    react: hooks,
    "react/jsx-runtime": jsx,
    "ag-grid-community": { colorSchemeDark: {}, colorSchemeLight: {}, themeQuartz: { withPart: () => ({ withParams: () => ({}) }) } },
    "ag-grid-enterprise": { AllEnterpriseModule: {} },
    "ag-grid-react": { AgGridProvider: () => null, AgGridReact: () => null },
    "ag-charts-react": { AgCharts: "AgCharts" },
    "ag-charts-community": { BarSeriesModule: {}, CategoryAxisModule: {}, LegendModule: "legend-module", NumberAxisModule: {} },
    "@/lib/business-snapshot": snapshotModule,
    "@/lib/business-channel-comparison": channelComparison,
    "@/lib/business-percentage": businessPercentage,
    "@/lib/market-chart-theme": { marketChartThemeFor: () => ({}) },
    "./theme-preference": { useAppearance: () => ({ appearance: "dark" }) },
    "./business-snapshot-panel.module.css": { __esModule: true, default: {} },
  })).default;
  function render() { cursor = 0; return Component({ perspective: "leadership", onSnapshotChange: (value) => changed.push(value) }); }
  function startImport(file) {
    const attestation = nodes(render()).find((node) => node.type === "input" && node.props.type === "checkbox");
    assert.ok(attestation, "The report authorization confirmation must be present");
    attestation.props.onChange({ currentTarget: { checked: true } });
    const input = nodes(render()).find((node) => node.type === "input" && node.props.type === "file");
    assert.equal(input.props.disabled, false, "A confirmed report can be selected through the UI");
    input.props.onChange({ currentTarget: { files: [file], value: "synthetic.csv" } });
  }
  async function importReport(source) {
    startImport({ size: Buffer.byteLength(source), text: async () => source });
    await tick();
    return render();
  }
  return { render, importReport, startImport, changed };
}

function comparison(tree) {
  return nodes(tree).find((node) => node.type === "figure" && node.props["aria-labelledby"] === "business-comparison-title");
}

function agChart(tree) {
  const chart = nodes(tree).find((node) => node.type === "AgCharts");
  assert.ok(chart, "The imported channel comparison should render its AG Chart");
  return chart;
}

function button(tree, label) {
  const result = nodes(tree).find((node) => node.type === "button" && text(node.props.children) === label);
  assert.ok(result, `Expected ${label} control`);
  return result;
}

test("a self-provided snapshot compares both periods and switches measures without losing the report", async () => {
  const panel = await createPanel();
  assert.equal(comparison(panel.render()), undefined, "No report means no invented comparison");
  assert.equal(nodes(panel.render()).find((node) => node.type === "input" && node.props.type === "file").props.disabled, true);
  let tree = await panel.importReport(csv([100, 100000, 2000], [120, 120000, 3000]));
  assert.deepEqual(panel.changed, [true]);
  let view = comparison(tree);
  assert.ok(agChart(view).props.modules.includes("legend-module"), "the period legend module is registered");
  assert.match(text(view), /Previous period2026-10-23 to before 2026-10-30 · UTC100/);
  assert.match(text(view), /Current period2026-10-30 to before 2026-11-06 · UTC120/);
  assert.equal(button(view, "Transactions").props["aria-pressed"], true);
  assert.equal(button(view, "Gross").props["aria-pressed"], false);

  button(view, "Gross").props.onClick();
  tree = panel.render();
  view = comparison(tree);
  assert.equal(button(view, "Gross").props["aria-pressed"], true);
  assert.match(text(view), /Gross · GBP/);
  assert.match(text(view), /£1,000\.00/);
  assert.match(text(view), /£1,200\.00/);
  const widths = nodes(view).filter((node) => node.type === "span" && typeof node.props?.style?.width === "string").map((node) => node.props.style.width);
  assert.deepEqual(widths, [`${100000 / 120000 * 100}%`, "100%"]);

  button(view, "Refunds").props.onClick();
  view = comparison(panel.render());
  assert.match(text(view), /Refunds · GBP/);
  assert.match(text(view), /£20\.00/);
  assert.match(text(view), /£30\.00/);
  assert.match(text(view), /Bars start at zero/);
  button(panel.render(), "Clear report").props.onClick();
  assert.equal(comparison(panel.render()), undefined);
  assert.deepEqual(panel.changed, [true, false]);
});

test("zero periods stay zero and four-decimal currencies retain their minor-unit precision", async () => {
  const panel = await createPanel();
  let view = comparison(await panel.importReport(csv([0, 0, 0], [0, 0, 0], "CLF")));
  assert.match(text(view), /Both periods are zero/);
  assert.deepEqual(nodes(view).filter((node) => node.type === "span" && node.props?.style?.width).map((node) => node.props.style.width), ["0%", "0%"]);
  view = comparison(await panel.importReport(csv([1, 1234567, 0], [2, 2345678, 0], "CLF")));
  button(view, "Gross").props.onClick();
  view = comparison(panel.render());
  assert.match(text(view), /Gross · CLF/);
  assert.match(text(view), /123\.4567/);
  assert.match(text(view), /234\.5678/);
});

test("channel changes follow the selected measure and show when the baseline is zero", async () => {
  const panel = await createPanel();
  const report = [
    header,
    "7,previous,2026-10-23,2026-10-30,online,GBP,100,100000,3000,2026-11-06T00:00:00Z",
    "7,current,2026-10-30,2026-11-06,online,GBP,120,120000,2000,2026-11-06T00:00:00Z",
    "7,previous,2026-10-23,2026-10-30,in_person,GBP,0,0,0,2026-11-06T00:00:00Z",
    "7,current,2026-10-30,2026-11-06,in_person,GBP,2,1500,0,2026-11-06T00:00:00Z",
  ].join("\n");
  let view = comparison(await panel.importReport(report));
  assert.deepEqual(agChart(view).props.options.data, [
    { channel: "Online", previous: 100, current: 120 },
    { channel: "In person", previous: 0, current: 2 },
  ]);
  assert.match(text(view), /OnlinePrevious 100 · Current 120Change \+20\+20\.0% vs previous/);
  assert.match(text(view), /In personPrevious 0 · Current 2Change \+2Previous period is zero; percentage unavailable/);
  assert.deepEqual(agChart(view).props.options.series.map((series) => series.type), ["bar", "bar"]);
  assert.match(text(view), /Bars start at zero and use the larger period as their scale/);
  button(view, "Gross").props.onClick();
  view = comparison(panel.render());
  assert.deepEqual(agChart(view).props.options.data, [
    { channel: "Online", previous: 100000, current: 120000 },
    { channel: "In person", previous: 0, current: 1500 },
  ]);
  assert.match(text(view), /OnlinePrevious £1,000\.00 · Current £1,200\.00Change \+£200\.00\+20\.0% vs previous/);
  button(view, "Refunds").props.onClick();
  view = comparison(panel.render());
  assert.deepEqual(agChart(view).props.options.data, [
    { channel: "Online", previous: 3000, current: 2000 },
    { channel: "In person", previous: 0, current: 0 },
  ]);
  assert.match(text(view), /OnlinePrevious £30\.00 · Current £20\.00Change −£10\.00−33\.3% vs previous/);
});

test("the chart axis keeps monetary ticks consistent with reported minor units", async () => {
  const cases = [
    ["USD", 1, "$0.01"],
    ["JPY", 1, "¥1"],
    ["BHD", 1, "BHD 0.001"],
    ["CLF", 1, "CLF 0.0001"],
  ];
  for (const [currency, minor, expected] of cases) {
    const panel = await createPanel();
    const view = comparison(await panel.importReport(csv([1, minor, 0], [2, minor * 2, 0], currency)));
    button(view, "Gross").props.onClick();
    const axis = agChart(comparison(panel.render())).props.options.axes.x.label.formatter;
    assert.equal(axis({ value: minor }), expected, `${currency} must preserve its report precision`);
    assert.equal(axis({ value: minor + Number.EPSILON }), expected, `${currency} should tolerate floating-point noise`);
    assert.equal(axis({ value: minor + 0.5 }), "", `${currency} cannot label a fraction of a minor unit as an exact amount`);
    assert.equal(axis({ value: -1 }), "");
  }
});

test("the chart uses the report's pinned scale when a browser reports the wrong currency precision", async () => {
  const panel = await createPanel();
  const view = comparison(await panel.importReport(csv([1, 1, 0], [2, 2, 0], "CLF")));
  button(view, "Gross").props.onClick();
  const OriginalNumberFormat = Intl.NumberFormat;
  try {
    Intl.NumberFormat = function (...args) {
      const formatter = new OriginalNumberFormat(...args);
      if (args[1]?.currency === "CLF") {
        const resolvedOptions = formatter.resolvedOptions.bind(formatter);
        formatter.resolvedOptions = () => ({ ...resolvedOptions(), minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return formatter;
    };
    const axis = agChart(comparison(panel.render())).props.options.axes.x.label.formatter;
    assert.equal(axis({ value: 1 }), "CLF 0.0001");
  } finally {
    Intl.NumberFormat = OriginalNumberFormat;
  }
});

test("summary cards distinguish tiny changes and ratios from zero", async () => {
  const panel = await createPanel();
  let tree = await panel.importReport(csv([999999999, 1000000000000, 1], [1000000000, 1000000000000, 1]));
  assert.match(text(tree), /Activity changeIncrease under 0\.1%/);
  assert.match(text(tree), /Refund ratioUnder 0\.1%/);
  tree = await panel.importReport(csv([1000000000, 1000000000000, 1], [999999999, 1000000000000, 1]));
  assert.match(text(tree), /Activity changeDecrease under 0\.1%/);
  tree = await panel.importReport(csv([100, 1000, 0], [100, 1000, 0]));
  assert.match(text(tree), /Activity change0\.0%/);
  assert.match(text(tree), /Refund ratio0\.0%/);
  tree = await panel.importReport(csv([0, 0, 0], [1, 0, 0]));
  assert.match(text(tree), /Activity changeUnavailablePrevious count is zero/);
  assert.match(text(tree), /Refund ratioUnavailableCurrent gross volume is zero/);
});

test("imported channel rows remain available to keyboard navigation in the report grid", async () => {
  const panel = await createPanel();
  const tree = await panel.importReport(csv([100, 100000, 2000], [120, 120000, 3000]));
  const grid = nodes(tree).find((node) => Array.isArray(node.props?.rowData) && Array.isArray(node.props?.columnDefs));
  assert.ok(grid, "Import should show the report grid");
  assert.deepEqual(grid.props.rowData.map(({ period, transactions }) => [period, transactions]), [["current", 120], ["previous", 100]]);
  assert.notEqual(grid.props.suppressCellFocus, true, "Report cells must remain focusable");
  assert.notEqual(grid.props.suppressHeaderFocus, true, "Report headers must remain focusable");
  assert.notEqual(grid.props.gridOptions?.suppressCellFocus, true);
  assert.equal(grid.props.defaultColDef?.suppressKeyboardEvent, undefined);

  button(tree, "Clear report").props.onClick();
  assert.equal(nodes(panel.render()).some((node) => Array.isArray(node.props?.rowData)), false);
});

test("clearing a report prevents a later file read from restoring its comparison", async () => {
  const panel = await createPanel();
  await panel.importReport(csv([1, 100, 0], [2, 200, 0]));
  let resolveFile;
  const pending = new Promise((resolve) => { resolveFile = resolve; });
  panel.startImport({ size: 100, text: () => pending });
  button(panel.render(), "Clear report").props.onClick();
  resolveFile(csv([3, 300, 0], [4, 400, 0]));
  await tick();
  assert.equal(comparison(panel.render()), undefined);
  assert.deepEqual(panel.changed, [true, false]);
});
