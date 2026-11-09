import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/portfolio-input.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { parseHoldingDraft, readStoredHoldings, readStoredWatchlist, handleResetStorageEvent, saveBrowserSnapshot, mayClearStorageWarning, draftsForHoldings, hasUnfinishedHoldings, previewHoldings, sameHoldings } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const tracked = ["bitcoin", "ethereum"];

test("fractional typing preserves intermediate drafts before producing a value", () => {
  assert.deepEqual(parseHoldingDraft(""), { kind: "empty" });
  assert.deepEqual(parseHoldingDraft("0"), { kind: "valid", amount: 0 });
  assert.deepEqual(parseHoldingDraft("0."), { kind: "incomplete" });
  assert.deepEqual(parseHoldingDraft("0.1"), { kind: "valid", amount: 0.1 });
  assert.deepEqual(parseHoldingDraft("."), { kind: "incomplete" });
  assert.deepEqual(parseHoldingDraft(".5"), { kind: "valid", amount: 0.5 });
});

test("scientific notation and its intermediate states remain usable", () => {
  for (const text of ["1e", "1e-", "1e+"]) assert.deepEqual(parseHoldingDraft(text), { kind: "incomplete" });
  assert.deepEqual(parseHoldingDraft("1e-8"), { kind: "valid", amount: 1e-8 });
  assert.deepEqual(parseHoldingDraft("2.5E+2"), { kind: "valid", amount: 250 });
  const stored = readStoredHoldings('{"bitcoin":1e-8,"ethereum":2.5}', tracked);
  assert.equal(stored.ok, true);
  assert.deepEqual(draftsForHoldings(stored.amounts), { bitcoin: "1e-8", ethereum: "2.5" });
});

test("invalid, out-of-range and underflow inputs cannot become saved values", () => {
  for (const text of ["-1", "1,2", "1.2.3", "1e13", "1e-9999", "Infinity", " ", "9".repeat(129)]) {
    assert.deepEqual(parseHoldingDraft(text), { kind: "invalid" }, text);
  }
  assert.deepEqual(parseHoldingDraft("0e-9999"), { kind: "valid", amount: 0 });
});

test("only accepts quantities whose decimal value survives numeric storage", () => {
  for (const text of [
    "0.1", "000.1000", ".00000001", "1e-8", "1000e-3",
    "1.2345678901234567", "123456789012.34567", "999999999999.9999", "1000000000000.0000",
    "1.0000000000000000e12", "1e-320", "5e-324", "0e-9999",
  ]) {
    assert.equal(parseHoldingDraft(text).kind, "valid", text);
  }
  for (const text of [
    "0.1234567890123456789", "999999999999.99999",
    "1.00000000000000001", "123456789012.345678", "100000000000000001e-17",
  ]) {
    assert.deepEqual(parseHoldingDraft(text), { kind: "invalid", reason: "precision" }, text);
  }
});

test("unrepresentable edits stay in the draft and cannot replace saved amounts", () => {
  const raw = '{"bitcoin":0.12345678901234568,"ethereum":2}';
  const stored = readStoredHoldings(raw, tracked);
  assert.equal(stored.ok, true);
  assert.deepEqual(parseHoldingDraft(draftsForHoldings(stored.amounts).bitcoin), { kind: "valid", amount: 0.12345678901234568 });
  const drafts = { bitcoin: "0.1234567890123456789", ethereum: "2" };
  assert.equal(hasUnfinishedHoldings(drafts), true);
  assert.deepEqual(previewHoldings(drafts, stored.amounts, tracked), { ethereum: 2 });
  assert.deepEqual(stored.amounts, { bitcoin: 0.12345678901234568, ethereum: 2 });
  assert.equal(drafts.bitcoin, "0.1234567890123456789");
});

test("saved holdings are read without silently discarding corrupt entries", () => {
  assert.deepEqual(readStoredHoldings(null, tracked), { ok: true, amounts: {} });
  assert.deepEqual(readStoredHoldings('{"bitcoin":0.1,"ethereum":0}', tracked), { ok: true, amounts: { bitcoin: 0.1, ethereum: 0 } });
  for (const text of ["", "[]", "null", '{"bitcoin":0.1,"ethereum":"3"}', '{"bitcoin":-1}', '{"bitcoin":1000000000001}', '{"future":2}', '{"bitcoin":null}']) {
    assert.deepEqual(readStoredHoldings(text, tracked), { ok: false }, text);
  }
});

test("watchlists preserve valid selections and reject malformed or unknown entries", () => {
  const coins = ["bitcoin", "ethereum", "solana", "chainlink"];
  assert.deepEqual(readStoredWatchlist(null, coins), coins);
  assert.deepEqual(readStoredWatchlist('["ethereum","bitcoin"]', coins), ["ethereum", "bitcoin"]);
  assert.deepEqual(readStoredWatchlist('["bitcoin","ethereum","solana"]', coins), coins);
  assert.deepEqual(readStoredWatchlist('[]', coins), []);
  for (const text of ['["bitcoin","future-coin"]', '["bitcoin",3]', '["bitcoin","bitcoin"]', '{}', 'null', 'broken']) {
    assert.throws(() => readStoredWatchlist(text, coins), text);
  }
});

test("a reset signal retries an early failed read and avoids duplicate successful reloads", () => {
  const seen = { current: false };
  let attempts = 0;
  handleResetStorageEvent(null, seen, () => { attempts += 1; return false; });
  assert.equal(seen.current, false);
  handleResetStorageEvent("removed-holdings:reset-one", seen, () => { attempts += 1; return true; });
  assert.equal(attempts, 2);
  handleResetStorageEvent(null, seen, () => { attempts += 1; return true; });
  handleResetStorageEvent("removed-holdings:reset-two", seen, () => { attempts += 1; return true; });
  assert.equal(attempts, 3);
  handleResetStorageEvent("no-holdings:reset-three", seen, () => { attempts += 1; return true; });
  assert.equal(attempts, 4);
});

test("failed holdings remain pending through another save and succeed on retry", () => {
  const values = new Map([["holdings", '{"bitcoin":2}'], ["watchlist", '["bitcoin"]']]);
  let failHoldings = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === "holdings" && failHoldings) throw new Error("synthetic quota failure");
      values.set(key, value);
    },
  };
  const validHoldings = (raw) => readStoredHoldings(raw, tracked).ok;
  const validWatchlist = (raw) => { readStoredWatchlist(raw, tracked); return true; };
  let holdingsPending = true;
  let watchlistPending = true;
  const first = saveBrowserSnapshot(storage, "holdings", '{"bitcoin":2}', '{"bitcoin":0.1}', validHoldings, true);
  assert.deepEqual(first, { kind: "unavailable" });
  assert.equal(values.get("holdings"), '{"bitcoin":2}');
  const watchlist = saveBrowserSnapshot(storage, "watchlist", '["bitcoin"]', '["ethereum"]', validWatchlist);
  assert.deepEqual(watchlist, { kind: "saved", baseline: '["ethereum"]' });
  watchlistPending = false;
  assert.equal(mayClearStorageWarning(false, holdingsPending, watchlistPending, false), false);
  failHoldings = false;
  const retry = saveBrowserSnapshot(storage, "holdings", '{"bitcoin":2}', '{"bitcoin":0.1}', validHoldings, true);
  assert.deepEqual(retry, { kind: "saved", baseline: '{"bitcoin":0.1}' });
  holdingsPending = false;
  assert.equal(values.get("holdings"), '{"bitcoin":0.1}');
  assert.equal(mayClearStorageWarning(false, holdingsPending, watchlistPending, false), true);
  assert.equal(mayClearStorageWarning(false, false, false, true), false);
  assert.equal(mayClearStorageWarning(true, false, false, false), false);
  assert.deepEqual(saveBrowserSnapshot(storage, "holdings", '{"bitcoin":2}', '{}', validHoldings, true), { kind: "changed" });
  assert.deepEqual(saveBrowserSnapshot(storage, "holdings", '{"bitcoin":0.1}', '{}', () => false, true), { kind: "corrupt" });
});

test("unfinished drafts and changed holdings can be identified without modifying either", () => {
  assert.equal(hasUnfinishedHoldings({ bitcoin: "0.", ethereum: "3" }), true);
  assert.equal(hasUnfinishedHoldings({ bitcoin: "1e-8", ethereum: "" }), false);
  assert.equal(sameHoldings({ bitcoin: 0.1, ethereum: 2 }, { ethereum: 2, bitcoin: 0.1 }), true);
  assert.equal(sameHoldings({ bitcoin: 0.1 }, { bitcoin: 0.2 }), false);
  assert.equal(sameHoldings({ bitcoin: 0 }, {}), false);
});

test("complete drafts drive a preview without changing the saved quantities", () => {
  const saved = { bitcoin: 2, ethereum: 3 };
  assert.deepEqual(previewHoldings({ bitcoin: "0.1", ethereum: "" }, saved, tracked), { bitcoin: 0.1 });
  assert.deepEqual(saved, { bitcoin: 2, ethereum: 3 });
  assert.deepEqual(previewHoldings({ bitcoin: "0.", ethereum: "3" }, saved, tracked), { ethereum: 3 });
});
