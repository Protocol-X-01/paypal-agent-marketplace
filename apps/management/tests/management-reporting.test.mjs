import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const componentModule = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected management test dependency: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(componentModule.exports, require, componentModule);
  return componentModule.exports;
}

const data = await load("../src/lib/management-data.ts");

function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value !== "object") return String(value);
  return text(value.props?.children);
}

function nodes(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}

async function harness(dataModule = data) {
  const states = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useMemo: (factory) => factory(),
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const jsx = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
  // This double records the dashboard contract without loading the shared panel
  // or invoking its optional local AI endpoint.
  const insightPanel = { default: (props) => element("insight-panel-test-double", props) };
  const Dashboard = (await load("../src/app/management-dashboard.tsx", {
    react, "react/jsx-runtime": jsx, "../lib/management-data": dataModule,
    "../../../../packages/ai-insights/ui/InsightPanel": insightPanel,
  })).default;
  function expand(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(expand);
    if (typeof value.type === "function") return expand(value.type(value.props));
    return { ...value, props: { ...value.props, children: expand(value.props.children) } };
  }
  const render = () => { cursor = 0; return expand(Dashboard()); };
  const button = (tree, name) => {
    const found = nodes(tree).find((node) => node.type === "button" && text(node).trim() === name);
    assert.ok(found, `Expected button ${name}`);
    return found;
  };
  const select = (tree, label) => {
    const parent = nodes(tree).find((node) => node.type === "label" && text(node).trim().startsWith(label));
    const found = nodes(parent).find((node) => node.type === "select");
    assert.ok(found, `Expected select ${label}`);
    return found;
  };
  return { render, button, select };
}

test("fictional cohorts use consecutive equal UTC periods and fixed fixture timestamps", () => {
  for (const days of [7, 30]) {
    const period = data.getFictionalPeriod(days);
    assert.equal(Date.parse(period.currentEnd) - Date.parse(period.currentStart), days * 86_400_000);
    assert.equal(Date.parse(period.priorEnd) - Date.parse(period.priorStart), days * 86_400_000);
    assert.equal(period.priorEnd, period.currentStart);
    assert.equal(period.fixtureTimestamp, "2026-11-02T00:35:00.000Z");
    assert.equal(period.rows.length, 12);
    assert.equal(new Set(period.rows.map((row) => row.id)).size, 12);
  }
});

test("the fictional population reconciles across cohorts, event counts and market splits", () => {
  for (const days of [7, 30]) {
    const { rows } = data.getFictionalPeriod(days);
    for (const row of rows) {
      for (const value of Object.values(row).filter((value) => typeof value === "number")) assert.ok(Number.isSafeInteger(value) && value >= 0);
      assert.ok(row.currentActive <= row.currentCompleted && row.currentCompleted <= row.currentAttempted);
      assert.ok(row.priorActive <= row.priorCompleted && row.priorCompleted <= row.priorAttempted);
      assert.ok(row.retained <= Math.min(row.priorActive, row.currentActive));
      if (row.age === "New") { assert.equal(row.priorActive, 0); assert.equal(row.retained, 0); }
    }
    const summary = data.summarize(rows);
    assert.equal(summary.retained + summary.noLongerActive, summary.priorActive);
    assert.equal(summary.retained + summary.reactivated + summary.newlyActive, summary.currentActive);
    for (const field of ["currentActive", "currentCompleted", "currentGrossMinor", "priorActive", "retained"]) {
      const markets = ["US", "UK", "Other"].map((market) => data.summarize(data.filterAggregates(rows, "All", market))[field]);
      assert.equal(markets.reduce((total, value) => total + value, 0), summary[field]);
    }
  }
  const weekly = data.summarize(data.getFictionalPeriod(7).rows);
  assert.equal(weekly.priorActive, 60_000);
  assert.equal(weekly.currentActive, 70_500);
  assert.equal(weekly.retained, 51_600);
  assert.equal(weekly.currentAttempted, 329_000);
  assert.equal(weekly.currentCompleted, 316_902);
  assert.equal(weekly.currentGrossMinor, 3_514_800_000);
  assert.equal(weekly.retention, 0.86);
  assert.notEqual(data.summarize(data.getFictionalPeriod(30).rows).currentActive, weekly.currentActive * 30 / 7);
});

test("global filters and daily distributions preserve each selected population", () => {
  for (const days of [7, 30]) {
    const period = data.getFictionalPeriod(days);
    for (const account of ["All", "Personal", "Business"]) for (const market of ["All", "US", "UK", "Other"]) {
      const rows = data.filterAggregates(period.rows, account, market);
      assert.ok(rows.every((row) => (account === "All" || row.accountType === account) && (market === "All" || row.market === market)));
      const summary = data.summarize(rows);
      const daily = data.fictionalDailyEvents(summary, days);
      assert.equal(daily.length, days);
      assert.equal(daily.reduce((total, point) => total + point.current, 0), summary.currentCompleted);
      assert.equal(daily.reduce((total, point) => total + point.prior, 0), summary.priorCompleted);
    }
  }
});

test("completion comparison weights attempts rather than averaging cohort rates", () => {
  const example = data.getFictionalPeriod(7).rows[0];
  const rows = [
    { ...example, priorAttempted: 1_000, priorCompleted: 500, currentAttempted: 1_000, currentCompleted: 900 },
    { ...example, id: "small-cohort", priorAttempted: 10, priorCompleted: 10, currentAttempted: 10, currentCompleted: 0 },
  ];
  const summary = data.summarize(rows);
  assert.equal(summary.priorAttempted, 1_010);
  assert.equal(summary.priorCompleted, 510);
  assert.equal(summary.currentAttempted, 1_010);
  assert.equal(summary.currentCompleted, 900);
  assert.equal(summary.priorCompletion, 510 / 1_010);
  assert.equal(summary.completion, 900 / 1_010);
  assert.ok(Math.abs(summary.completionChangePoints - (900 / 1_010 - 510 / 1_010) * 100) < 1e-10);
  assert.notEqual(summary.completion, (0.9 + 0) / 2);
});

test("completion comparison is unavailable when either period has no attempts", () => {
  const example = data.getFictionalPeriod(7).rows[0];
  const noPrior = data.summarize([{ ...example, priorAttempted: 0, priorCompleted: 0 }]);
  assert.equal(noPrior.priorCompletion, null);
  assert.notEqual(noPrior.completion, null);
  assert.equal(noPrior.completionChangePoints, null);
  const noCurrent = data.summarize([{ ...example, currentAttempted: 0, currentCompleted: 0 }]);
  assert.notEqual(noCurrent.priorCompletion, null);
  assert.equal(noCurrent.completion, null);
  assert.equal(noCurrent.completionChangePoints, null);
  const empty = data.summarize([]);
  assert.equal(empty.priorCompletion, null);
  assert.equal(empty.completion, null);
  assert.equal(empty.completionChangePoints, null);
  assert.equal(empty.currentAttempted, 0);
});

test("completion comparisons follow every fictional reporting filter and period", () => {
  for (const days of [7, 30]) for (const account of ["All", "Personal", "Business"]) for (const market of ["All", "US", "UK", "Other"]) {
    const rows = data.filterAggregates(data.getFictionalPeriod(days).rows, account, market);
    const summary = data.summarize(rows);
    const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);
    assert.equal(summary.priorAttempted, total("priorAttempted"));
    assert.equal(summary.currentAttempted, total("currentAttempted"));
    assert.equal(summary.priorCompletion, total("priorCompleted") / total("priorAttempted"));
    assert.equal(summary.completion, total("currentCompleted") / total("currentAttempted"));
    assert.ok(Math.abs(summary.completionChangePoints - (summary.completion - summary.priorCompletion) * 100) < 1e-10);
  }
});

test("daily events reconcile across every account, market and cohort partition", () => {
  for (const days of [7, 30]) {
    const rows = data.getFictionalPeriod(days).rows;
    const series = (subset) => data.fictionalDailyEvents(data.summarize(subset), days);
    const assertPartition = (whole, partitions) => {
      const parent = series(whole);
      const children = partitions.map(series);
      for (let i = 0; i < days; i++) for (const key of ["current", "prior"]) {
        assert.equal(children.reduce((sum, child) => sum + child[i][key], 0), parent[i][key], `${days}-day fixture, day ${i + 1}, ${key}`);
      }
    };
    for (const market of ["All", "US", "UK", "Other"]) {
      const whole = data.filterAggregates(rows, "All", market);
      assertPartition(whole, ["Personal", "Business"].map((account) => data.filterAggregates(rows, account, market)));
    }
    for (const account of ["All", "Personal", "Business"]) {
      const whole = data.filterAggregates(rows, account, "All");
      assertPartition(whole, ["US", "UK", "Other"].map((market) => data.filterAggregates(rows, account, market)));
    }
    assertPartition(rows, ["Existing", "New"].map((age) => rows.filter((row) => row.age === age)));
    assert.ok(series([]).every((point) => point.current === 0 && point.prior === 0));
  }
});

test("new cohorts have unavailable retention and remain last in either ratio sort", () => {
  const rows = data.getFictionalPeriod(7).rows;
  const newRows = rows.filter((row) => row.age === "New");
  assert.equal(data.summarize(newRows).retention, null);
  assert.equal(data.formatPercent(null), "Unavailable");
  for (const direction of ["ascending", "descending"]) {
    const sorted = data.tableRows(rows, "", "retention", direction);
    assert.ok(sorted.slice(-6).every((row) => row.age === "New"));
  }
  assert.equal(data.tableRows(rows, "  BUSINESS · EXISTING · UK  ", "currentActive", "descending").length, 1);
  assert.equal(data.tableRows(rows, "unmatched", "cohort", "ascending").length, 0);
});

test("multi-term cohort searches match every term without confusing US with Business", () => {
  const rows = data.getFictionalPeriod(7).rows;
  for (const query of ["Business UK", "uk   BUSINESS", "Business · UK"]) {
    const selected = data.tableRows(rows, query, "cohort", "ascending");
    assert.equal(selected.length, 2);
    assert.ok(selected.every((row) => row.accountType === "Business" && row.market === "UK"));
  }
  const us = data.tableRows(rows, "Business US", "cohort", "ascending");
  assert.equal(us.length, 2);
  assert.ok(us.every((row) => row.accountType === "Business" && row.market === "US"));
  assert.equal(data.tableRows(rows, "Business UK US", "cohort", "ascending").length, 0);
  assert.equal(data.tableRows(rows, "Business unmatched", "cohort", "ascending").length, 0);
  assert.equal(data.tableRows(rows, " \t ", "cohort", "ascending").length, rows.length);
});

test("the app starts disconnected with no fictional metrics or table rows displayed", async () => {
  const h = await harness();
  const tree = h.render();
  assert.match(text(tree), /Reporting source disconnected/);
  assert.match(text(tree), /Staff identity not configured/);
  assert.doesNotMatch(text(tree), /70,500|316,902|Fictional preview is on/);
  assert.equal(h.select(tree, "Reporting period").props.disabled, true);
  assert.ok(h.button(tree, "Show fictional preview"));
});

test("the isolated insight panel receives only the selected fictional scope and preview state", async () => {
  const h = await harness();
  const panel = () => nodes(h.render()).find((node) => node.type === "insight-panel-test-double");
  assert.equal(panel().props.kind, "fictional-report");
  assert.equal(panel().props.enabled, false);
  assert.deepEqual(panel().props.selection, { days: 7, account: "All", market: "All" });
  h.button(h.render(), "Show fictional preview").props.onClick();
  assert.equal(panel().props.enabled, true);
  h.select(h.render(), "Reporting period").props.onChange({ target: { value: "30" } });
  h.select(h.render(), "Account type").props.onChange({ target: { value: "Business" } });
  h.select(h.render(), "Market").props.onChange({ target: { value: "UK" } });
  assert.deepEqual(panel().props.selection, { days: 30, account: "Business", market: "UK" });
  h.button(h.render(), "Hide fictional preview").props.onClick();
  assert.equal(panel().props.enabled, false);
  assert.deepEqual(panel().props.selection, { days: 7, account: "All", market: "All" });
});

test("preview opt-in reveals labeled aggregates and global scope changes every report", async () => {
  const h = await harness();
  h.button(h.render(), "Show fictional preview").props.onClick();
  let tree = h.render();
  assert.match(text(tree), /Fictional preview is on/);
  assert.match(text(tree), /Invented aggregate figures, never retrieved from PayPal/);
  assert.match(text(tree), /70,500/);
  assert.match(text(tree), /Complete within this fixture/);
  h.select(tree, "Account type").props.onChange({ target: { value: "Business" } });
  tree = h.render();
  assert.match(text(tree), /20,800/);
  assert.doesNotMatch(text(tree), /70,500/);
  h.select(tree, "Market").props.onChange({ target: { value: "UK" } });
  tree = h.render();
  assert.match(text(tree), /6,240/);
  h.select(tree, "Reporting period").props.onChange({ target: { value: "30" } });
  assert.match(text(h.render()), /14,550/);
});

test("activity completion comparison follows global selection, not table search, and hides with preview", async () => {
  const h = await harness();
  h.button(h.render(), "Aggregate activity").props.onClick();
  const comparison = () => nodes(h.render()).find((node) => node.props?.className === "panel completion-panel");
  assert.match(text(comparison()), /No authorized reporting source/);
  assert.doesNotMatch(text(comparison()), /316,902|329,000|12,098/);
  h.button(h.render(), "Show fictional preview").props.onClick();
  let shown = text(comparison());
  assert.match(shown, /Fictional payment activity/);
  assert.match(shown, /275,600\s+of\s+290,000\s+attempts completed/);
  assert.match(shown, /316,902\s+of\s+329,000\s+attempts completed/);
  assert.match(shown, /\+1\.3 percentage points/);
  assert.match(shown, /12,098\s+current-period attempts not completed/);
  assert.match(shown, /does not identify a cause or indicate a live alert/);
  h.select(h.render(), "Account type").props.onChange({ target: { value: "Business" } });
  h.select(h.render(), "Market").props.onChange({ target: { value: "UK" } });
  shown = text(comparison());
  assert.match(shown, /31,680\s+of\s+33,000\s+attempts completed/);
  assert.match(shown, /37,728\s+of\s+38,880\s+attempts completed/);
  assert.match(shown, /1,152\s+current-period attempts not completed/);
  const search = nodes(h.render()).find((node) => node.type === "input" && node.props.type === "search");
  search.props.onChange({ target: { value: "new" } });
  assert.equal(text(comparison()), shown);
  h.select(h.render(), "Reporting period").props.onChange({ target: { value: "30" } });
  shown = text(comparison());
  assert.match(shown, /133,860\s+of\s+138,000\s+attempts completed/);
  assert.match(shown, /157,797\s+of\s+162,300\s+attempts completed/);
  assert.match(shown, /\+0\.2 percentage points/);
  assert.match(shown, /4,503\s+current-period attempts not completed/);
  h.button(h.render(), "Hide fictional preview").props.onClick();
  assert.match(text(comparison()), /No authorized reporting source/);
  assert.doesNotMatch(text(comparison()), /157,797|162,300|4,503|percentage points/);
});

test("activity comparison presents an unavailable period without a zero-looking progress bar", async () => {
  for (const missing of ["prior", "current"]) {
    const fictionalData = {
      ...data,
      getFictionalPeriod(days) {
        const period = data.getFictionalPeriod(days);
        return { ...period, rows: [{
          ...period.rows[0], priorActive: missing === "prior" ? 0 : 1, currentActive: missing === "current" ? 0 : 1, retained: 0,
          priorAttempted: missing === "prior" ? 0 : 20, priorCompleted: missing === "prior" ? 0 : 16,
          currentAttempted: missing === "current" ? 0 : 20, currentCompleted: missing === "current" ? 0 : 16,
          priorGrossMinor: 0, currentGrossMinor: 0,
        }] };
      },
    };
    const h = await harness(fictionalData);
    h.button(h.render(), "Show fictional preview").props.onClick();
    h.button(h.render(), "Aggregate activity").props.onClick();
    const comparison = nodes(h.render()).find((node) => node.props?.className === "panel completion-panel");
    const periods = nodes(comparison).filter((node) => node.props?.className === "completion-period");
    const missingPeriod = periods[missing === "prior" ? 0 : 1];
    const otherPeriod = periods[missing === "prior" ? 1 : 0];
    assert.match(text(missingPeriod), /Unavailable/);
    assert.match(text(missingPeriod), /0\s+of\s+0\s+attempts completed/);
    assert.equal(nodes(missingPeriod).some((node) => node.props?.className === "completion-track"), false);
    assert.match(text(otherPeriod), /80%/);
    assert.equal(nodes(otherPeriod).some((node) => node.props?.className === "completion-track"), true);
    assert.match(text(comparison), /A comparison needs included attempts in both periods/);
  }
});

test("aggregate table supports filtering, sorting and denominator detail", async () => {
  const h = await harness();
  h.button(h.render(), "Show fictional preview").props.onClick();
  h.button(h.render(), "Aggregate activity").props.onClick();
  let tree = h.render();
  assert.match(text(tree), /12 of 12 cohorts shown/);
  const search = nodes(tree).find((node) => node.type === "input" && node.props.type === "search");
  search.props.onChange({ target: { value: "Business UK" } });
  assert.match(text(h.render()), /2 of 12 cohorts shown/);
  search.props.onChange({ target: { value: "Personal · new · UK" } });
  tree = h.render();
  assert.match(text(tree), /1 of 12 cohorts shown/);
  const cohortButton = nodes(tree).find((node) => node.type === "button" && node.props.className === "cohort-button");
  assert.ok(cohortButton);
  cohortButton.props.onClick();
  assert.match(text(h.render()), /New accounts have no previous-period denominator/);
  const tableSearch = nodes(h.render()).find((node) => node.type === "input" && node.props.type === "search");
  tableSearch.props.onChange({ target: { value: "" } });
  tree = h.render();
  const heading = nodes(tree).find((node) => node.type === "th" && node.props["aria-sort"] === "descending");
  assert.match(text(heading), /Active accounts/);
  nodes(heading).find((node) => node.type === "button").props.onClick();
  assert.equal(nodes(h.render()).find((node) => node.type === "th" && text(node).includes("Active accounts")).props["aria-sort"], "ascending");
});

test("hiding preview removes figures and resets scope before a later opt-in", async () => {
  const h = await harness();
  h.button(h.render(), "Show fictional preview").props.onClick();
  h.select(h.render(), "Reporting period").props.onChange({ target: { value: "30" } });
  h.select(h.render(), "Account type").props.onChange({ target: { value: "Business" } });
  h.button(h.render(), "Hide fictional preview").props.onClick();
  assert.doesNotMatch(text(h.render()), /48,500|163,300|70,500|Fictional preview is on/);
  h.button(h.render(), "Show fictional preview").props.onClick();
  assert.equal(h.select(h.render(), "Reporting period").props.value, 7);
  assert.equal(h.select(h.render(), "Account type").props.value, "All");
  assert.match(text(h.render()), /70,500/);
});

test("Leadership changes the report presentation without claiming staff authorization", async () => {
  const h = await harness();
  h.button(h.render(), "Show fictional preview").props.onClick();
  h.button(h.render(), "Leadership").props.onClick();
  let tree = h.render();
  assert.match(text(tree), /Included gross payment volume/);
  assert.match(text(tree), /Read the population before the percentage/);
  assert.match(text(tree), /Staff identity not configured/);
  h.button(tree, "Staff setup").props.onClick();
  tree = h.render();
  assert.match(text(tree), /presentation choices here, not access roles/);
  assert.match(text(tree), /No keys, customer records or identity tokens are requested/);
});
