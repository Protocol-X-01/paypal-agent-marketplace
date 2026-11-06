import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/business-plan-storage.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { BUSINESS_PLAN_STORAGE_KEY: key, assessExternalBusinessPlan, createDefaultPlan, parseMonitoringPlan, readBusinessPlan, saveBusinessPlan } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function browserStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[key, initial]]);
  let unavailableRead = false;
  let unavailableWrite = false;
  let writes = 0;
  return {
    getItem(name) { if (unavailableRead) throw new Error("synthetic read failure"); return values.get(name) ?? null; },
    setItem(name, value) { if (unavailableWrite) throw new Error("synthetic quota failure"); writes += 1; values.set(name, value); },
    removeItem(name) { values.delete(name); },
    failRead(value) { unavailableRead = value; },
    failWrite(value) { unavailableWrite = value; },
    get writes() { return writes; },
  };
}

test("only a missing plan selects defaults; unreadable stored values remain untouched", () => {
  const missing = browserStorage();
  assert.deepEqual(readBusinessPlan(missing), { kind: "missing", baseline: null });
  assert.equal(missing.writes, 0);
  for (const raw of ["", "{", "null", '{"version":2}', "x".repeat(8001)]) {
    const storage = browserStorage(raw);
    assert.deepEqual(readBusinessPlan(storage), { kind: "unreadable" });
    assert.deepEqual(saveBusinessPlan(storage, null, createDefaultPlan()), { kind: "unreadable" });
    assert.equal(storage.getItem(key), raw);
    assert.equal(storage.writes, 0);
  }
});

test("valid custom plans round-trip while malformed or duplicate selections are rejected", () => {
  const plan = createDefaultPlan();
  plan.perspective = "leadership";
  plan.views.teams.activityDropPct = 25;
  plan.views.leadership.windowDays = 7;
  assert.deepEqual(parseMonitoringPlan(JSON.stringify(plan)), plan);
  const duplicate = structuredClone(plan);
  duplicate.views.teams.indicators.push("refundShare");
  assert.equal(parseMonitoringPlan(JSON.stringify(duplicate)), null);
  const unknown = structuredClone(plan);
  unknown.views.leadership.indicators.push("repeatActivity");
  assert.equal(parseMonitoringPlan(JSON.stringify(unknown)), null);
  for (const perspective of ["teams", "leadership"]) {
    const gated = structuredClone(plan);
    gated.views[perspective].indicators.push("customerAccounts");
    assert.equal(parseMonitoringPlan(JSON.stringify(gated)), null, `customer accounts remain unavailable for ${perspective}`);
  }
  const badThreshold = structuredClone(plan);
  badThreshold.views.teams.activityDropPct = 11;
  assert.equal(parseMonitoringPlan(JSON.stringify(badThreshold)), null);
});

test("a stale tab is paused rather than overwriting another tab's saved plan", () => {
  const initial = JSON.stringify(createDefaultPlan());
  const storage = browserStorage(initial);
  const first = createDefaultPlan();
  first.views.teams.activityDropPct = 20;
  const other = createDefaultPlan();
  other.perspective = "leadership";
  const saved = saveBusinessPlan(storage, initial, first);
  assert.equal(saved.kind, "saved");
  assert.deepEqual(saveBusinessPlan(storage, initial, other), { kind: "changed" });
  const latest = readBusinessPlan(storage);
  assert.equal(latest.kind, "valid");
  assert.equal(latest.plan.views.teams.activityDropPct, 20);
  assert.equal(assessExternalBusinessPlan(latest, initial, true, false, "ready"), "conflict");
  assert.equal(other.perspective, "leadership", "the in-memory draft remains available");
  // A deliberate replacement uses a fresh baseline; another intervening save is detected.
  const intervening = structuredClone(first);
  intervening.views.teams.refundSharePct = 6;
  assert.equal(saveBusinessPlan(storage, latest.baseline, intervening).kind, "saved");
  assert.deepEqual(saveBusinessPlan(storage, latest.baseline, other), { kind: "changed" });
  const fresh = readBusinessPlan(storage);
  assert.equal(saveBusinessPlan(storage, fresh.baseline, other).kind, "saved");
  assert.equal(readBusinessPlan(storage).plan.perspective, "leadership");
});

test("reset loads defaults only without a draft, including when the key was absent", () => {
  const initial = JSON.stringify(createDefaultPlan());
  const storage = browserStorage(initial);
  storage.removeItem(key);
  const missing = readBusinessPlan(storage);
  assert.equal(assessExternalBusinessPlan(missing, initial, false, true, "ready"), "load");
  assert.equal(assessExternalBusinessPlan(missing, initial, true, true, "ready"), "conflict");
  assert.deepEqual(saveBusinessPlan(storage, initial, createDefaultPlan()), { kind: "changed" });
  assert.equal(assessExternalBusinessPlan(missing, null, true, true, "ready"), "conflict");
  assert.equal(assessExternalBusinessPlan(missing, null, false, false, "ready"), "ignore");
  assert.equal(assessExternalBusinessPlan({ kind: "unreadable" }, initial, true, true, "ready"), "unreadable");
});

test("read and write failures preserve stored data and can be retried", () => {
  const initial = JSON.stringify(createDefaultPlan());
  const storage = browserStorage(initial);
  const draft = createDefaultPlan();
  draft.views.teams.refundSharePct = 8;
  storage.failWrite(true);
  assert.deepEqual(saveBusinessPlan(storage, initial, draft), { kind: "unavailable" });
  assert.equal(storage.getItem(key), initial);
  storage.failWrite(false);
  assert.equal(saveBusinessPlan(storage, initial, draft).kind, "saved");
  assert.equal(readBusinessPlan(storage).plan.views.teams.refundSharePct, 8);
  storage.failRead(true);
  assert.deepEqual(readBusinessPlan(storage), { kind: "unavailable" });
  assert.deepEqual(saveBusinessPlan(storage, initial, draft), { kind: "unavailable" });
});

test("Settings includes the Business plan in both export and reset inventory", async () => {
  const settings = await readFile(new URL("../src/app/components/data-settings.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("data-settings.tsx", settings, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "localData") initializer = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer);
  const js = ts.transpileModule(`(${initializer})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const inventory = new Function("STOREFRONT_STORAGE_KEY", "BUSINESS_PLAN_STORAGE_KEY", `return ${js}`)("synthetic-storefront", key);
  assert.ok(inventory.some(([name, storageKey]) => name === "businessMonitoringPlan" && storageKey === key));
  assert.match(settings, /localData\.map/);
  assert.match(settings, /for \(const \[, key\] of localData\)/);
});
