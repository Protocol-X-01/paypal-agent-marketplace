import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/business-snapshot.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { BUSINESS_SNAPSHOT_HEADERS, BUSINESS_SNAPSHOT_MAX_BYTES,
  BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW, BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW,
  BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS, BUSINESS_SNAPSHOT_ISO_PUBLISHED,
  businessCurrencyMinorDigits, formatBusinessMinorAmount, parseBusinessSnapshot } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const headers = [...BUSINESS_SNAPSHOT_HEADERS];
const fixtureRows = () => [
  { window_days: "7", period: "previous", start_date: "2026-10-23", end_exclusive: "2026-10-30", channel: "online", currency: "GBP", transactions: "100", gross_minor: "100000", refund_minor: "2000", source_updated_at: "2026-11-06T01:30:00Z" },
  { window_days: "7", period: "previous", start_date: "2026-10-23", end_exclusive: "2026-10-30", channel: "in_person", currency: "GBP", transactions: "50", gross_minor: "50000", refund_minor: "1000", source_updated_at: "2026-11-06T01:30:00Z" },
  { window_days: "7", period: "current", start_date: "2026-10-30", end_exclusive: "2026-11-06", channel: "online", currency: "GBP", transactions: "130", gross_minor: "200000", refund_minor: "4000", source_updated_at: "2026-11-06T01:30:00Z" },
  { window_days: "7", period: "current", start_date: "2026-10-30", end_exclusive: "2026-11-06", channel: "in_person", currency: "GBP", transactions: "70", gross_minor: "50000", refund_minor: "1000", source_updated_at: "2026-11-06T01:30:00Z" },
];
function csv(rows = fixtureRows(), columns = headers) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => row[column] ?? "").join(","))].join("\n");
}
function rejected(input) {
  const result = parseBusinessSnapshot(input);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  return result.error;
}

test("parses a self-provided snapshot and computes totals and comparable trends", () => {
  const result = parseBusinessSnapshot(csv());
  assert.equal(result.ok, true);
  const { snapshot } = result;
  assert.equal(snapshot.currency, "GBP");
  assert.equal(snapshot.windowDays, 7);
  assert.equal(snapshot.sourceUpdatedAt, "2026-11-06T01:30:00.000Z");
  assert.deepEqual(snapshot.periods.previous, {
    startDate: "2026-10-23", endExclusive: "2026-10-30", transactions: 150, grossMinor: 150000, refundMinor: 3000,
  });
  assert.deepEqual(snapshot.periods.current, {
    startDate: "2026-10-30", endExclusive: "2026-11-06", transactions: 200, grossMinor: 250000, refundMinor: 5000,
  });
  assert.equal(snapshot.rows.length, 4);
  assert.ok(Math.abs(snapshot.summary.transactionChangePct - 100 / 3) < 1e-10);
  assert.equal(snapshot.summary.refundRatioPct, 2);
});

test("accepts reordered and quoted columns, CRLF, BOM, and equivalent UTC timestamps", () => {
  const columns = [...headers].reverse();
  const rows = fixtureRows();
  rows[1].source_updated_at = "2026-11-06T01:30:00.000Z";
  const quote = (value) => `"${value}"`;
  const input = "\uFEFF" + [columns.map(quote).join(","), ...rows.map((row) => columns.map((key) => quote(row[key])).join(","))].join("\r\n") + "\r\n";
  const result = parseBusinessSnapshot(input);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.sourceUpdatedAt, "2026-11-06T01:30:00.000Z");
});

test("never invents a percentage when the comparison denominator is zero", () => {
  const rows = fixtureRows();
  for (const row of rows) {
    if (row.period === "previous") row.transactions = "0";
    if (row.period === "current") {
      row.gross_minor = "0";
      row.refund_minor = "1";
    }
  }
  const result = parseBusinessSnapshot(csv(rows));
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.summary.transactionChangePct, null);
  assert.equal(result.snapshot.summary.refundRatioPct, null);
});

test("allows refund amounts greater than current-period sales", () => {
  const rows = fixtureRows();
  rows[2].gross_minor = "100";
  rows[2].refund_minor = "300";
  rows[3].gross_minor = "100";
  rows[3].refund_minor = "0";
  const result = parseBusinessSnapshot(csv(rows));
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.summary.refundRatioPct, 150);
});

test("rejects extra, missing or repeated headers without exposing file content", () => {
  const privateText = "person@example.invalid";
  const rows = fixtureRows().map((row) => ({ ...row, customer_email: privateText }));
  const error = rejected(csv(rows, [...headers, "customer_email"]));
  assert.equal(error.includes(privateText), false);
  rejected(csv(fixtureRows(), headers.slice(1)));
  rejected(csv(fixtureRows(), [...headers.slice(0, -1), "period"]));
});

test("rejects malformed CSV, multiline fields and non-template row shapes", () => {
  rejected(csv().replace("previous", '"previous'));
  rejected(csv().replace("previous", '"previous"x'));
  rejected(csv().replace("previous", 'pre"vious'));
  rejected(csv().replace("previous", '"pre\nvious"'));
  rejected(csv().replace("previous", "previous\r"));
  rejected(csv() + "\n\n");
  rejected(csv() + ",unexpected");
});

test("bounds UTF-8 file size before parsing", () => {
  rejected("x".repeat(BUSINESS_SNAPSHOT_MAX_BYTES + 1));
  // Each emoji occupies two JavaScript code units but four UTF-8 bytes.
  rejected("😀".repeat(BUSINESS_SNAPSHOT_MAX_BYTES / 4 + 1));
});

test("requires one matched row per included channel in each period", () => {
  const missing = fixtureRows();
  missing.pop();
  rejected(csv(missing));
  const duplicate = fixtureRows();
  duplicate[3] = { ...duplicate[2] };
  rejected(csv(duplicate));
  const mismatch = fixtureRows();
  mismatch[3].channel = "other";
  rejected(csv(mismatch));
  const unknown = fixtureRows();
  unknown[0].channel = "customer-123";
  rejected(csv(unknown));
  const pair = [fixtureRows()[0], fixtureRows()[2]];
  assert.equal(parseBusinessSnapshot(csv(pair)).ok, true);
});

test("requires equal consecutive windows and valid calendar dates", () => {
  for (const mutate of [
    (rows) => { rows[0].start_date = "2026-02-30"; },
    (rows) => { rows[0].window_days = "30"; },
    (rows) => { rows[0].end_exclusive = "2026-10-29"; },
    (rows) => { rows[0].start_date = "2026-10-22"; },
    (rows) => { for (const row of rows.filter((item) => item.period === "current")) { row.start_date = "2026-10-31"; row.end_exclusive = "2026-11-07"; } },
    (rows) => { for (const row of rows.filter((item) => item.period === "current")) { row.start_date = "2026-10-29"; row.end_exclusive = "2026-11-05"; } },
  ]) {
    const rows = fixtureRows();
    mutate(rows);
    rejected(csv(rows));
  }
  const leap = fixtureRows().map((row) => ({ ...row,
    start_date: row.period === "previous" ? "2024-02-15" : "2024-02-22",
    end_exclusive: row.period === "previous" ? "2024-02-22" : "2024-02-29",
  }));
  assert.equal(parseBusinessSnapshot(csv(leap)).ok, true);
});

test("accepts 30-day periods without scaling and rejects mismatched provenance", () => {
  const rows = fixtureRows().map((row) => ({ ...row, window_days: "30",
    start_date: row.period === "previous" ? "2026-09-07" : "2026-10-07",
    end_exclusive: row.period === "previous" ? "2026-10-07" : "2026-11-06",
  }));
  const result = parseBusinessSnapshot(csv(rows));
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.windowDays, 30);
  assert.equal(result.snapshot.periods.current.transactions, 200);
  for (const value of ["2026-11-06T01:30:01Z", "2026-02-30T01:30:00Z", "2026-11-06T01:30:00+00:00", "not-a-date"]) {
    const inconsistent = structuredClone(rows);
    inconsistent[0].source_updated_at = value;
    rejected(csv(inconsistent));
  }
});

test("requires the source timestamp to reach the current exclusive end", () => {
  const beforeEnd = fixtureRows().map((row) => ({ ...row, source_updated_at: "2026-11-05T23:59:59.999Z" }));
  rejected(csv(beforeEnd));
  const atEnd = fixtureRows().map((row) => ({ ...row, source_updated_at: "2026-11-06T00:00:00Z" }));
  assert.equal(parseBusinessSnapshot(csv(atEnd)).ok, true);
  // Device clocks may be wrong; a structurally future-dated file remains unverified.
  const future = fixtureRows().map((row) => ({ ...row, source_updated_at: "2099-01-01T00:00:00Z" }));
  assert.equal(parseBusinessSnapshot(csv(future)).ok, true);
});

test("uses the pinned current ISO minor units, not the locale's display defaults", () => {
  assert.equal(BUSINESS_SNAPSHOT_ISO_PUBLISHED, "2026-09-17");
  assert.equal(Object.keys(BUSINESS_SNAPSHOT_CURRENCY_MINOR_DIGITS).length, 165);
  const digitsByCode = { GBP: 2, USD: 2, COP: 2, HUF: 2, IDR: 2, JPY: 0, BHD: 3, KWD: 3, CLF: 4 };
  for (const [currency, digits] of Object.entries(digitsByCode)) {
    assert.equal(businessCurrencyMinorDigits(currency), digits, currency);
    const rows = fixtureRows().map((row) => ({ ...row, currency, gross_minor: "1250", refund_minor: "1250" }));
    const result = parseBusinessSnapshot(csv(rows));
    assert.equal(result.ok, true, currency);
    const formatter = new Intl.NumberFormat("en-GB", {
      style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
    assert.equal(formatBusinessMinorAmount(1250, currency), formatter.format(1250 / 10 ** digits), currency);
  }
  for (const currency of ["XDR", "XSU", "XXX", "BGN", "ZZZ"]) {
    assert.equal(businessCurrencyMinorDigits(currency), null, currency);
    const rows = fixtureRows().map((row) => ({ ...row, currency }));
    assert.match(rejected(csv(rows)), /defined minor unit/, currency);
    assert.equal(formatBusinessMinorAmount(1250, currency), "Unavailable");
  }
  assert.equal(formatBusinessMinorAmount(-1, "GBP"), "Unavailable");
  assert.equal(formatBusinessMinorAmount(1.5, "GBP"), "Unavailable");
  assert.equal(formatBusinessMinorAmount(3_000_000_000_001, "GBP"), "Unavailable");
  assert.equal(formatBusinessMinorAmount(2_999_999_999_997, "COP"),
    new Intl.NumberFormat("en-GB", { style: "currency", currency: "COP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(29_999_999_999.97));
});

test("rejects unsupported or mixed currencies and unsafe numeric fields", () => {
  for (const value of ["usd", "ZZZ", "US", "GBP "]) {
    const rows = fixtureRows();
    rows[0].currency = value;
    rejected(csv(rows));
  }
  const mixed = fixtureRows();
  mixed[0].currency = "USD";
  rejected(csv(mixed));
  for (const value of ["-1", "1.1", "1e3", "+1", "01", "NaN", "9007199254740992"]) {
    const rows = fixtureRows();
    rows[0].transactions = value;
    rejected(csv(rows));
  }
  const yen = fixtureRows().map((row) => ({ ...row, currency: "JPY" }));
  assert.equal(parseBusinessSnapshot(csv(yen)).ok, true);
});

test("bounds each row so three-channel sums retain minor-unit display precision", () => {
  for (const [field, maximum] of [
    ["transactions", BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW],
    ["gross_minor", BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW],
    ["refund_minor", BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW],
  ]) {
    const tooLarge = fixtureRows();
    tooLarge[0][field] = String(maximum + 1);
    rejected(csv(tooLarge));
  }

  const rows = fixtureRows().map((row) => ({ ...row,
    transactions: String(BUSINESS_SNAPSHOT_MAX_TRANSACTIONS_PER_ROW),
    gross_minor: String(BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW - 1),
    refund_minor: String(BUSINESS_SNAPSHOT_MAX_MINOR_PER_ROW),
  }));
  rows.push({ ...rows[0], channel: "other" }, { ...rows[2], channel: "other" });
  const result = parseBusinessSnapshot(csv(rows));
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.periods.current.transactions, 3_000_000_000);
  assert.equal(result.snapshot.periods.current.grossMinor, 2_999_999_999_997);
  assert.equal(result.snapshot.periods.current.refundMinor, 3_000_000_000_000);
  assert.equal(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(result.snapshot.periods.current.grossMinor / 100), "$29,999,999,999.97");
});
