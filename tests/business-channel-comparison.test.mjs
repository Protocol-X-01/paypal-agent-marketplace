import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    throw new Error(`Unexpected module in channel comparison test: ${name}`);
  };
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const webSnapshot = await load("../src/lib/business-snapshot.ts");
const nativeSnapshot = await load("../apps/mobile/src/lib/business-snapshot.ts");
const web = await load("../src/lib/business-channel-comparison.ts", { "./business-snapshot": webSnapshot });
const native = await load("../apps/mobile/src/lib/business-channel-comparison.ts", { "./business-snapshot": nativeSnapshot });

const report = {
  currency: "CLF",
  rows: [
    { period: "previous", channel: "online", transactions: 100, grossMinor: 1234567, refundMinor: 30000 },
    { period: "current", channel: "online", transactions: 120, grossMinor: 2345678, refundMinor: 20000 },
    { period: "previous", channel: "in_person", transactions: 0, grossMinor: 0, refundMinor: 0 },
    { period: "current", channel: "in_person", transactions: 2, grossMinor: 1, refundMinor: 0 },
    { period: "previous", channel: "other", transactions: 1000000000, grossMinor: 1, refundMinor: 1 },
    { period: "current", channel: "other", transactions: 999999999, grossMinor: 1, refundMinor: 1 },
  ],
};

test("web and mobile channel comparisons agree for every supported measure", () => {
  for (const metric of ["transactions", "gross", "refunds"]) {
    assert.deepEqual(native.compareBusinessChannels(report, metric), web.compareBusinessChannels(report, metric));
  }
});

test("channel changes use supplied values and handle zero or tiny percentage baselines", () => {
  const [online, inPerson, other] = web.compareBusinessChannels(report, "transactions");
  assert.deepEqual([online.previous, online.current, online.change, online.percentage], ["100", "120", "+20", "+20.0% vs previous."]);
  assert.deepEqual([inPerson.previous, inPerson.current, inPerson.change, inPerson.percentage], ["0", "2", "+2", "Previous period is zero; percentage unavailable."]);
  assert.deepEqual([online.previousWidth, online.currentWidth], [`${100 / 120 * 100}%`, "100%"]);
  assert.deepEqual([inPerson.previousWidth, inPerson.currentWidth], ["0%", "100%"]);
  assert.equal(other.change, "−1");
  assert.equal(other.percentage, "Decrease of less than 0.1%.");
});

test("four-decimal currency differences remain exact and missing pairs do not invent values", () => {
  const result = web.compareBusinessChannels(report, "gross");
  assert.match(result[0].previous, /123\.4567/);
  assert.match(result[0].current, /234\.5678/);
  assert.match(result[0].change, /^\+.*111\.1111/);
  assert.deepEqual(web.compareBusinessChannels(report, "refunds").slice(1, 2).map(({ previousWidth, currentWidth }) => [previousWidth, currentWidth]), [["0%", "0%"]]);
  assert.deepEqual(web.compareBusinessChannels({ ...report, rows: report.rows.filter((row) => row.channel === "online" && row.period === "current") }, "gross"), []);
});
