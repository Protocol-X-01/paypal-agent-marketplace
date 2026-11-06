import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/lib/paypal-business-sample.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function("exports", "require", "module", compiled)(loaded.exports, (name) => name === "server-only" ? {} : require(name), loaded);
const { inspectPayPalFirstPage } = loaded.exports;
const options = { start: "2026-01-01T00:00:00Z", end: "2026-01-08T00:00:00Z", accessToken: "synthetic-token" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("one page exposes only its observed row count, never raw fields or report metrics", async () => {
  let observed;
  const result = await inspectPayPalFirstPage({ ...options, transport: async (url, init) => {
    observed = { url: new URL(url), init };
    return json({
      account_number: "SYNTHETIC_PRIVATE_ACCOUNT",
      last_refreshed_datetime: "2026-01-08T00:00:00Z",
      transaction_details: [
        { transaction_info: { transaction_id: "SYNTHETIC_DUPLICATE", transaction_note: "SYNTHETIC_PRIVATE_NOTE", transaction_event_code: "T0006" } },
        { transaction_info: { transaction_id: "SYNTHETIC_DUPLICATE", transaction_event_code: "T1107", transaction_amount: { value: "-2.00", currency_code: "GBP" } } },
      ],
    });
  } });
  assert.deepEqual(result, { state: "inspection-only", observedTransactionDetailEntries: 2, metrics: "unavailable", complete: false });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_DUPLICATE|GBP|2\.00/);
  assert.equal(observed.url.origin, "https://api-m.sandbox.paypal.com");
  assert.equal(observed.url.pathname, "/v1/reporting/transactions");
  assert.deepEqual(Object.fromEntries(observed.url.searchParams), {
    start_date: options.start, end_date: options.end, fields: "transaction_info",
    balance_affecting_records_only: "Y", page: "1", page_size: "100",
  });
  assert.equal(observed.init.headers.Authorization, "Bearer synthetic-token");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.cache, "no-store");
});

test("invalid periods and tokens fail before the transport is called", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return json({ transaction_details: [] }); };
  for (const change of [
    { start: "2026-02-30T00:00:00Z" },
    { start: "2026-01-01T00:00:00+00:00" },
    { end: "2026-02-01T00:00:00Z" },
    { accessToken: "invalid\nSYNTHETIC_PRIVATE" },
    { accessToken: "" },
  ]) {
    assert.deepEqual(await inspectPayPalFirstPage({ ...options, ...change, transport }),
      { state: "unavailable", reason: "invalid-request", metrics: "unavailable", complete: false });
  }
  assert.equal(calls, 0);
});

test("denied, failed, malformed and oversized provider responses do not become zero activity", async () => {
  const cases = [
    [() => json({ message: "SYNTHETIC_PRIVATE_ERROR" }, 403), "denied"],
    [() => json({ message: "SYNTHETIC_PRIVATE_ERROR" }, 500), "unavailable"],
    [() => new Response("not json", { headers: { "content-type": "application/json" } }), "invalid-response"],
    [() => new Response("{}", { headers: { "content-type": "text/html" } }), "invalid-response"],
    [() => json({ message: "missing transactions" }), "invalid-response"],
    [() => json({ transaction_details: [null] }), "invalid-response"],
    [() => json({ transaction_details: Array(101).fill({}) }), "invalid-response"],
    [() => json({ transaction_details: [], note: "x".repeat(262_145) }), "invalid-response"],
  ];
  for (const [response, reason] of cases) {
    const result = await inspectPayPalFirstPage({ ...options, transport: async () => response() });
    assert.deepEqual(result, { state: "unavailable", reason, metrics: "unavailable", complete: false });
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/);
  }
});

test("an empty first page remains an incomplete observation", async () => {
  const result = await inspectPayPalFirstPage({ ...options, transport: async () => json({ transaction_details: [] }) });
  assert.deepEqual(result, { state: "inspection-only", observedTransactionDetailEntries: 0, metrics: "unavailable", complete: false });
});
