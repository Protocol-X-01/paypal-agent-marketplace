import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/paypal-activity-import.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { summarizePayPalActivity, PAYPAL_ACTIVITY_MAX_BYTES, PAYPAL_ACTIVITY_MAX_ROWS } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const header = "Date,Time,TimeZone,Name,From Email Address,Status,Transaction Event Code,Balance Impact,Transaction ID";
const id = (n) => `TEST${String(n).padStart(13, "0")}`;
const row = (date, n, { time = "12:00:00", zone = "UTC", name = '"Invented, Person"', email = "invented@example.test", status = "Completed", code = "T0006", impact = "Credit" } = {}) =>
  `${date},${time},${zone},${name},${email},${status},${code},${impact},${id(n)}`;
const options = { dateOrder: "dmy", timeZone: "utc", windowDays: 7, endExclusive: "2026-11-06", coverageConfirmed: true, nowMs: Date.parse("2026-11-06T15:00:00Z") };
const file = (...rows) => [header, ...rows].join("\n");
const valid = () => file(row("23/10/2026", 1), row("30/10/2026", 2, { code: "T0007" }));

function mustFail(csv, opts = options) {
  const result = summarizePayPalActivity(csv, opts);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /Invented|invented@example|TEST0/);
  return result.error;
}

test("counts only completed checkout credit rows and accounts for exclusions", () => {
  const result = summarizePayPalActivity(file(
    row("23/10/2026", 1, { time: "00:00:00" }),
    row("29/10/2026", 2, { time: "23:59:59", status: "Pending" }),
    row("30/10/2026", 3, { time: "00:00:00", code: "T0007" }),
    row("04/11/2026", 4, { code: "T0006", impact: "Debit" }),
    row("05/11/2026", 5, { code: "T1107" }),
    row("05/11/2026", 6, { code: "T0006" }),
    row("06/11/2026", 7),
  ), options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.previous, { startDate: "2026-10-23", endExclusive: "2026-10-30", included: 1, otherEvent: 0, notCompleted: 1, notCredit: 0 });
  assert.deepEqual(result.summary.current, { startDate: "2026-10-30", endExclusive: "2026-11-06", included: 2, otherEvent: 1, notCompleted: 0, notCredit: 1 });
  assert.equal(result.summary.outsidePeriods, 1);
  assert.equal(result.summary.rowsInFile, 7);
  assert.equal(result.summary.changePct, 100);
  assert.doesNotMatch(JSON.stringify(result), /Invented|invented@example|TEST0/);
});

test("the explicitly chosen date order controls the UTC period boundaries", () => {
  const csv = file(row("10/30/2026", 1), row("11/04/2026", 2, { zone: "GMT" }));
  const result = summarizePayPalActivity(csv, { ...options, dateOrder: "mdy" });
  assert.equal(result.ok, false, "both selected periods must have rows");
  const full = summarizePayPalActivity(file(row("10/23/2026", 1), row("11/04/2026", 2)), { ...options, dateOrder: "mdy" });
  assert.equal(full.ok, true);
  assert.equal(full.summary.previous.included, 1);
  assert.equal(full.summary.current.included, 1);
  assert.match(mustFail(csv, options), /date or time/i);
});

test("supports a BOM, reordered headers, CRLF and quoted multiline private fields without returning them", () => {
  const reordered = "Transaction ID,Status,Name,Date,Time,TimeZone,Balance Impact,Transaction Event Code,From Email Address";
  const text = `\uFEFF${reordered}\r\n${id(1)},Completed,"Invented\r\nPrivate",23/10/2026,10:00:00,GMT,Credit,T0006,invented@example.test\r\n${id(2)},Completed,"Invented ""Person""",30/10/2026,10:00:00,UTC,Credit,T0007,invented@example.test\r\n`;
  const result = summarizePayPalActivity(text, options);
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /Invented|Private|invented@example|TEST0/);
});

test("requires explicit coverage and an already completed UTC window", () => {
  for (const partial of [
    { coverageConfirmed: false }, { coverageConfirmed: "yes" }, { dateOrder: "" }, { timeZone: "" },
    { windowDays: 14 }, { endExclusive: "2026-11-07" }, { endExclusive: "2026-02-30" }, { nowMs: Infinity }, { nowMs: 1e308 },
  ]) assert.match(mustFail(valid(), { ...options, ...partial }), /choose a date format/i);
});

test("rejects missing, duplicated, malformed, empty, or oversized report data", () => {
  assert.match(mustFail(file(row("23/10/2026", 1), row("30/10/2026", 2)).replace(",Transaction Event Code,", ",Event,=")), /columns/i);
  assert.match(mustFail(`${header},date\n${row("23/10/2026", 1)},x\n${row("30/10/2026", 2)},x`), /columns/i);
  assert.match(mustFail(`${header}\n`), /no activity rows/i);
  assert.match(mustFail(`${header}\n"unterminated`), /CSV/i);
  assert.match(mustFail("x".repeat(PAYPAL_ACTIVITY_MAX_BYTES + 1)), /too large/i);
});

test("rejects dates, times, timezones and row shapes it cannot interpret", () => {
  assert.match(mustFail(file(row("31/02/2026", 1), row("30/10/2026", 2))), /date or time/i);
  assert.match(mustFail(file(row("23/10/2026", 1, { time: "24:00:00" }), row("30/10/2026", 2))), /date or time/i);
  assert.match(mustFail(file(row("23/10/2026", 1, { zone: "PST" }), row("30/10/2026", 2))), /time zone/i);
  assert.match(mustFail(`${header}\n${row("23/10/2026", 1)}\n${row("30/10/2026", 2)},extra`), /row shape/i);
});

test("converts explicitly chosen UK and Pacific wall times into the correct UTC reporting periods", () => {
  const summer = { ...options, endExclusive: "2026-07-15", nowMs: Date.parse("2026-07-15T15:00:00Z") };
  const london = summarizePayPalActivity(file(
    row("01/07/2026", 1, { time: "01:00:00", zone: "BST" }),
    row("08/07/2026", 2, { time: "00:30:00", zone: "BST" }),
    row("08/07/2026", 3, { time: "01:00:00", zone: "BST" }),
  ), { ...summer, timeZone: "london" });
  assert.equal(london.ok, true);
  assert.equal(london.summary.previous.included, 2);
  assert.equal(london.summary.current.included, 1);
  const pacific = summarizePayPalActivity(file(
    row("30/06/2026", 4, { time: "17:00:00", zone: "PDT" }),
    row("07/07/2026", 5, { time: "16:30:00", zone: "PDT" }),
    row("07/07/2026", 6, { time: "17:00:00", zone: "PDT" }),
  ), { ...summer, timeZone: "pacific" });
  assert.equal(pacific.ok, true);
  assert.equal(pacific.summary.previous.included, 2);
  assert.equal(pacific.summary.current.included, 1);
});

test("rejects mismatched abbreviations, missing timezone choices and DST gaps or folds", () => {
  const input = (date, time, zone) => file(row("23/10/2026", 1, { zone: "BST" }), row("30/10/2026", 2, { zone: "GMT" }), row(date, 3, { time, zone }));
  for (const [date, time, zone] of [
    ["25/10/2026", "01:30:00", "BST"], // London fall-back: two possible instants
    ["29/03/2026", "01:30:00", "GMT"], // London spring-forward: no such instant
    ["23/10/2026", "12:00:00", "GMT"], // wrong seasonal abbreviation
    ["23/10/2026", "12:00:00", "CST"], // ambiguous abbreviation
  ]) assert.match(mustFail(input(date, time, zone), { ...options, timeZone: "london" }), /time zone|daylight/i);
  const pacificBase = file(row("23/10/2026", 1, { zone: "PDT" }), row("30/10/2026", 2, { zone: "PDT" }));
  for (const [date, time, zone] of [
    ["01/11/2026", "01:30:00", "PDT"],
    ["08/03/2026", "02:30:00", "PST"],
    ["23/10/2026", "12:00:00", "PST"],
  ]) assert.match(mustFail(`${pacificBase}\n${row(date, 3, { time, zone })}`, { ...options, timeZone: "pacific" }), /time zone|daylight/i);
});

test("supports selected major US regions and checks seasonal labels rather than inferring a zone", () => {
  const winter = { ...options, endExclusive: "2026-01-15", nowMs: Date.parse("2026-01-15T15:00:00Z") };
  const summer = { ...options, endExclusive: "2026-07-15", nowMs: Date.parse("2026-07-15T15:00:00Z") };
  for (const [timeZone, standard, daylight] of [
    ["eastern", "EST", "EDT"], ["central", "CST", "CDT"], ["mountain", "MST", "MDT"],
    ["arizona", "MST", "MST"], ["pacific", "PST", "PDT"], ["alaska", "AKST", "AKDT"], ["hawaii", "HST", "HST"],
  ]) {
    for (const [config, label, start, end] of [[winter, standard, "01/01/2026", "08/01/2026"], [summer, daylight, "01/07/2026", "08/07/2026"]]) {
      const result = summarizePayPalActivity(file(row(start, 1, { zone: label }), row(end, 2, { zone: label })), { ...config, timeZone });
      assert.equal(result.ok, true, `${timeZone}: ${label}`);
      assert.equal(result.summary.previous.included, 1);
      assert.equal(result.summary.current.included, 1);
    }
  }
  assert.match(mustFail(file(row("01/07/2026", 1, { zone: "MDT" }), row("08/07/2026", 2, { zone: "MDT" })), { ...summer, timeZone: "arizona" }), /time zone/i);
  assert.match(mustFail(valid(), { ...options, timeZone: "__proto__" }), /choose a date format/i);
  const old = file(row("01/07/2006", 1, { zone: "BST" }), row("08/07/2006", 2, { zone: "BST" }));
  assert.match(mustFail(old, { ...options, timeZone: "london" }), /time zone/i);
});

test("rejects unrecognized classifications, malformed event codes, and duplicate or invalid IDs", () => {
  assert.match(mustFail(file(row("23/10/2026", 1, { status: "Unknown status" }), row("30/10/2026", 2))), /status/i);
  assert.match(mustFail(file(row("23/10/2026", 1, { impact: "Unknown" }), row("30/10/2026", 2))), /balance-impact/i);
  assert.match(mustFail(file(row("23/10/2026", 1, { code: "T6" }), row("30/10/2026", 2))), /event code/i);
  assert.match(mustFail(file(row("23/10/2026", 1), row("30/10/2026", 1))), /repeated/i);
  assert.match(mustFail(file(row("23/10/2026", 1), row("30/10/2026", 2).replace(id(2), "short"))), /invalid/i);
});

test("never treats a missing period as proof of zero activity", () => {
  assert.match(mustFail(file(row("30/10/2026", 1), row("04/11/2026", 2))), /one selected period/i);
  const result = summarizePayPalActivity(file(row("23/10/2026", 1, { code: "T1107" }), row("30/10/2026", 2)), options);
  assert.equal(result.ok, true);
  assert.equal(result.summary.previous.included, 0);
  assert.equal(result.summary.changePct, null);
});

test("compares adjacent thirty-day periods and rejects invalid calendar rollovers", () => {
  const monthly = { ...options, windowDays: 30 };
  const result = summarizePayPalActivity(file(row("07/09/2026", 1), row("07/10/2026", 2)), monthly);
  assert.equal(result.ok, true);
  assert.equal(result.summary.previous.startDate, "2026-09-07");
  assert.equal(result.summary.previous.endExclusive, "2026-10-07");
  assert.equal(result.summary.current.startDate, "2026-10-07");
  assert.equal(result.summary.current.endExclusive, "2026-11-06");
  assert.match(mustFail(file(row("29/02/2026", 1), row("07/10/2026", 2)), monthly), /date or time/i);
});

test("bounds UTF-8 bytes, not only JavaScript string length", () => {
  const text = `${header}\n${row("23/10/2026", 1)}\n${row("30/10/2026", 2)}\n${"é".repeat(PAYPAL_ACTIVITY_MAX_BYTES / 2)}`;
  assert.ok(text.length < PAYPAL_ACTIVITY_MAX_BYTES);
  assert.match(mustFail(text), /too large/i);
});

test("enforces the advertised row limit without truncating the report", () => {
  const compactHeader = "Date,Time,TimeZone,Status,Transaction Event Code,Balance Impact,Transaction ID";
  const rows = Array.from({ length: PAYPAL_ACTIVITY_MAX_ROWS }, (_, index) =>
    `${index === 0 ? "23/10/2026" : "30/10/2026"},00:00:00,UTC,Completed,T0006,Credit,${id(index)}`,
  );
  const maxFile = [compactHeader, ...rows].join("\n");
  assert.ok(Buffer.byteLength(maxFile) < PAYPAL_ACTIVITY_MAX_BYTES);
  const result = summarizePayPalActivity(maxFile, options);
  assert.equal(result.ok, true);
  assert.equal(result.summary.rowsInFile, PAYPAL_ACTIVITY_MAX_ROWS);
  assert.equal(result.summary.current.included, PAYPAL_ACTIVITY_MAX_ROWS - 1);
  assert.match(mustFail(`${maxFile}\n30/10/2026,00:00:00,UTC,Completed,T0006,Credit,${id(PAYPAL_ACTIVITY_MAX_ROWS)}`), /too many rows/i);
});
