/* eslint-disable @typescript-eslint/no-require-imports -- Standalone simulation fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/paypal-business-sample.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, (name) => name === 'server-only' ? {} : require(name), loaded);
const { inspectPayPalFirstPage } = loaded.exports;
const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 0 && port < 65536);

// The code's exact PayPal URL is checked, then mapped to the loopback mock.
// This driver is also run inside a private network namespace with loopback only.
const transport = (input, init) => {
  const original = new URL(input);
  assert.equal(original.origin, 'https://api-m.sandbox.paypal.com');
  assert.equal(original.pathname, '/v1/reporting/transactions');
  assert.equal(init.redirect, 'error');
  const local = new URL(`http://127.0.0.1:${port}/paypal${original.pathname}${original.search}`);
  return fetch(local, init);
};
const request = (month) => inspectPayPalFirstPage({
  start: `2026-${month}-01T00:00:00Z`,
  end: `2026-${month}-08T00:00:00Z`,
  accessToken: 'synthetic-reporting-token',
  transport,
});

(async () => {
  const result = await request('01');
  assert.deepEqual(result, { state: 'inspection-only', observedTransactionDetailEntries: 2, metrics: 'unavailable', complete: false });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_DUPLICATE/);
  console.log('PASS synthetic first-page count with raw fields withheld');
  for (const [month, expected, description] of [
    ['02', 'denied', 'permission denial'],
    ['03', 'invalid-response', 'malformed response'],
    ['04', 'invalid-response', 'oversized response'],
    ['05', 'timeout', 'provider timeout'],
    ['06', 'unavailable', 'provider redirect'],
    ['07', 'invalid-response', 'missing transaction list'],
  ]) {
    const observed = await request(month);
    assert.deepEqual(observed, { state: 'unavailable', reason: expected, metrics: 'unavailable', complete: false });
    assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC_PRIVATE/);
    console.log(`PASS ${description} stays incomplete`);
  }
})().catch(() => {
  console.error('FAIL synthetic PayPal Business inspection');
  process.exitCode = 1;
});
