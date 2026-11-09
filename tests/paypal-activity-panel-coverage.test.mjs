import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}, globals = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module in fictional Activity preview test: ${name}`);
  };
  new Function("exports", "require", "module", ...Object.keys(globals), compiled)(cjsModule.exports, require, cjsModule, ...Object.values(globals));
  return cjsModule.exports;
}

const activity = await load("../src/lib/paypal-activity-import.ts");
const percentage = await load("../src/lib/business-percentage.ts");
const element = (type, props) => ({ type, props: props ?? {} });
const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  const effects = [];
  const timers = new Map();
  const changed = [];
  const summaries = [];
  let cursor = 0;
  let timerId = 0;
  const windowMock = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(callback) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = {}; effects.push(() => { slots[index].cleanup = callback(); }); }
    },
  };
  const Component = (await load("../src/app/components/paypal-activity-panel.tsx", {
    react: hooks,
    "react/jsx-runtime": jsx,
    "@/lib/paypal-activity-import": activity,
    "@/lib/business-percentage": percentage,
    "./paypal-activity-panel.module.css": { __esModule: true, default: {} },
  }, { window: windowMock })).default;
  function render() { cursor = 0; return Component({ onReportChange: (active, summary) => { changed.push(active); if (active) summaries.push(summary); } }); }
  render();
  while (effects.length) effects.shift()();
  for (const callback of [...timers.values()]) callback();
  timers.clear();

  function label(needle) {
    const result = nodes(render()).find((node) => node.type === "label" && text(node).includes(needle));
    assert.ok(result, `Missing label ${needle}`);
    return result;
  }
  function control(needle, type) {
    const found = nodes(label(needle)).find((node) => node.type === type);
    assert.ok(found, `Missing ${type} for ${needle}`);
    return found;
  }
  function change(needle, type, value) {
    control(needle, type).props.onChange({ target: type === "input" && typeof value === "boolean" ? { checked: value } : { value } });
  }
  function fileInput() { return nodes(render()).find((node) => node.type === "input" && node.props.type === "file"); }
  function selectFile(file) {
    const input = fileInput();
    assert.ok(input, "Missing file input");
    input.props.onChange({ currentTarget: { files: file ? [file] : [], value: "fictional.csv" } });
  }
  function prepare() {
    change("Date format in the export", "select", "dmy");
    change("Time zone used by the export", "select", "utc");
    change("Length of each period", "select", "7");
    change("First day after the current period", "input", "2020-11-06");
    change("I understand the file may contain", "input", true);
    change("I confirm this single file", "input", true);
    assert.equal(fileInput().props.disabled, false);
    changed.length = 0;
  }
  return { render, change, control, fileInput, selectFile, prepare, changed, summaries };
}

const header = "Date,Time,TimeZone,Status,Transaction Event Code,Balance Impact,Transaction ID";
const report = [header, "23/10/2020,12:00:00,UTC,Completed,T0006,Credit,TEST0000000000001", "30/10/2020,12:00:00,UTC,Completed,T0007,Credit,TEST0000000000002"].join("\n");
function file(textValue = report) {
  const bytes = new TextEncoder().encode(textValue);
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
}
function hasReport(panel) { return nodes(panel.render()).some((node) => node.type === "h4" && text(node) === "Selected PayPal checkout activity"); }
function coverage(panel) { return panel.control("I confirm this single file", "input"); }
function alertText(panel) { return text(nodes(panel.render()).find((node) => node.props?.role === "alert")); }

test("coverage confirmation is consumed for each file, and cancellation does not consume it", async () => {
  const panel = await createPanel();
  panel.prepare();
  panel.selectFile(null);
  assert.equal(coverage(panel).props.checked, true);
  panel.selectFile(file());
  await tick();
  assert.equal(hasReport(panel), true);
  assert.equal(coverage(panel).props.checked, false);
  assert.equal(panel.fileInput().props.disabled, true);
  assert.deepEqual(panel.changed, [true]);
  assert.equal(panel.summaries[0].current.included, 1);
  assert.equal(panel.summaries[0].previous.included, 1);
  assert.doesNotMatch(JSON.stringify(panel.summaries[0]), /TEST0000/);
  panel.selectFile(file());
  await tick();
  assert.deepEqual(panel.changed, [true], "A second file must not be processed without a fresh confirmation");
  panel.change("I confirm this single file", "input", true);
  assert.equal(panel.fileInput().props.disabled, false);
  panel.selectFile(file(`${report}\n30/10/2020,13:00:00,UTC,Completed,T0006,Credit,TEST0000000000003`));
  await tick();
  assert.equal(hasReport(panel), true);
  assert.equal(coverage(panel).props.checked, false);
  assert.deepEqual(panel.changed, [true, true]);
  assert.equal(panel.summaries[1].current.included, 2, "A replacement updates the parent overview");
});

test("changing report criteria clears coverage confirmation and the prior report", async () => {
  for (const [needle, type, value] of [
    ["Date format in the export", "select", "mdy"],
    ["Time zone used by the export", "select", "london"],
    ["Length of each period", "select", "30"],
    ["First day after the current period", "input", "2020-11-05"],
  ]) {
    const panel = await createPanel();
    panel.prepare();
    panel.selectFile(file());
    await tick();
    panel.change("I confirm this single file", "input", true);
    assert.equal(panel.fileInput().props.disabled, false);
    panel.change(needle, type, value);
    assert.equal(coverage(panel).props.checked, false, `${needle} must invalidate coverage`);
    assert.equal(panel.fileInput().props.disabled, true);
    assert.equal(hasReport(panel), false);
    assert.equal(panel.changed.at(-1), false);
  }
});

test("oversized and unreadable selections require new confirmations and identify the previous preview", async () => {
  const panel = await createPanel();
  panel.prepare();
  panel.selectFile(file());
  await tick();
  panel.change("I confirm this single file", "input", true);
  panel.selectFile({ size: activity.PAYPAL_ACTIVITY_MAX_BYTES + 1, arrayBuffer: () => { throw new Error("must not read oversized input"); } });
  assert.equal(coverage(panel).props.checked, false);
  assert.equal(panel.fileInput().props.disabled, true);
  assert.equal(hasReport(panel), true);
  assert.match(alertText(panel), /too large.*previous preview remains displayed/i);
  panel.change("I confirm this single file", "input", true);
  panel.selectFile({ size: 5, arrayBuffer: async () => { throw new Error("fictional read error"); } });
  await tick();
  assert.equal(coverage(panel).props.checked, false);
  assert.equal(panel.fileInput().props.disabled, true);
  assert.equal(hasReport(panel), true);
  assert.match(alertText(panel), /could not be read.*previous preview remains displayed/i);
  assert.deepEqual(panel.changed, [true]);
  assert.equal(panel.summaries.length, 1, "Failed replacement must not replace the parent overview");
});

test("clearing the preview while a new file is reading prevents a late result from restoring it", async () => {
  const panel = await createPanel();
  panel.prepare();
  panel.selectFile(file());
  await tick();
  panel.change("I confirm this single file", "input", true);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  panel.selectFile({ size: report.length, arrayBuffer: () => pending });
  assert.equal(coverage(panel).props.checked, false);
  const clear = nodes(panel.render()).find((node) => node.type === "button" && text(node) === "Clear PayPal preview");
  assert.ok(clear);
  clear.props.onClick();
  finish(new TextEncoder().encode(report).buffer);
  await tick();
  assert.equal(hasReport(panel), false);
  assert.equal(panel.fileInput().props.disabled, true);
  assert.deepEqual(panel.changed, [true, false]);
});
