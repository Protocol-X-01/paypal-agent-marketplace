// Run from apps/mobile with node --test tests/candle-series.test.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const mobilePath = path.join(__dirname, '../src/lib/candle-series.ts');
const webPath = path.join(__dirname, '../../../src/lib/candle-series.ts');
const source = fs.readFileSync(mobilePath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { calculateSma, calculateEma, calculateRsi, candleIndexAtRatio } = loaded.exports;

test('web and mobile candle math use the identical source', () => {
  assert.equal(source, fs.readFileSync(webPath, 'utf8'));
});

test('SMA uses a rolling window and EMA is seeded with its first simple average', () => {
  const closes = [1, 2, 3, 4, 7];
  assert.deepEqual(calculateSma(closes, 3), [null, null, 2, 3, 14 / 3]);
  assert.deepEqual(calculateEma(closes, 3), [null, null, 2, 3, 5]);
  assert.deepEqual(calculateSma([5, 6], 1), [5, 6]);
  assert.deepEqual(calculateEma([5, 6], 1), [5, 6]);
});

test('default moving averages wait for 20 closes', () => {
  const closes = Array.from({ length: 21 }, (_, i) => i + 1);
  for (const values of [calculateSma(closes), calculateEma(closes)]) {
    assert.deepEqual(values.slice(0, 19), Array(19).fill(null));
    assert.equal(values[19], 10.5);
    assert.equal(values[20], 11.5);
  }
});

test('Wilder RSI uses 14 price changes and handles flat or one-sided markets', () => {
  assert.deepEqual(calculateRsi(Array(15).fill(4)), [...Array(14).fill(null), 50]);
  assert.equal(calculateRsi(Array.from({ length: 15 }, (_, i) => i))[14], 100);
  assert.equal(calculateRsi(Array.from({ length: 15 }, (_, i) => 15 - i))[14], 0);
  const rsi = calculateRsi([10, 11, 10, 12, 11], 3);
  assert.deepEqual(rsi.slice(0, 3), [null, null, null]);
  assert.ok(Math.abs(rsi[3] - 75) < 1e-10);
  assert.ok(Math.abs(rsi[4] - 600 / 11) < 1e-10);
});

test('nonfinite closes restart warmup and invalid periods fail closed', () => {
  const closes = [1, 2, 3, NaN, 4, 5, 6];
  assert.deepEqual(calculateSma(closes, 3), [null, null, 2, null, null, null, 5]);
  assert.deepEqual(calculateEma(closes, 3), [null, null, 2, null, null, null, 5]);
  assert.deepEqual(calculateRsi(closes, 2), [null, null, 100, null, null, null, 100]);
  for (const fn of [calculateSma, calculateEma, calculateRsi]) {
    for (const period of [0, -1, 1.5, Infinity]) assert.throws(() => fn([1, 2], period), RangeError);
  }
});

test('selection snaps to the actual visible candle and clamps both plot edges', () => {
  assert.equal(candleIndexAtRatio(-1, 4, 8), 4);
  assert.equal(candleIndexAtRatio(0, 4, 8), 4);
  assert.equal(candleIndexAtRatio(0.24, 4, 8), 4);
  assert.equal(candleIndexAtRatio(0.25, 4, 8), 5);
  assert.equal(candleIndexAtRatio(1, 4, 8), 7);
  assert.equal(candleIndexAtRatio(2, 4, 8), 7);
  assert.equal(candleIndexAtRatio(NaN, 4, 8), null);
  assert.equal(candleIndexAtRatio(0.5, 8, 8), null);
});
