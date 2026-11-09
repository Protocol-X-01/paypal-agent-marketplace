// Synthetic fixtures and a fake transport only; no device or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const modules = new Map();
function loadSource(file) {
  const absolute = path.resolve(file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const localRequire = (name) => name.startsWith('.') ? loadSource(path.resolve(path.dirname(absolute), name)) : require(name);
  new Function('exports', 'require', 'module', compiled)(module.exports, localRequire, module);
  return module.exports;
}
const lib = (name) => path.join(__dirname, '../src/lib', name);
const { fetchMarketCandles, formatCandlePrice, isMarketCandles } = loadSource(lib('market'));
const { changeCandleViewport, initialCandleViewport, revealCandle } = loadSource(lib('candle-viewport'));
const candle = (timestamp = 1) => ({ timestamp, open: 1.0002, high: 1.01, low: 0.99, close: 1.0004 });
const response = (candles = [candle()]) => ({
  coinId: 'bitcoin', currency: 'GBP', days: 7, source: 'CoinGecko', retrievedAt: '2026-11-06T10:00:00Z',
  candleIntervalMinutes: 240, timestampKind: 'close', candles,
});

test('validates provider candles, empty history, order, interval and real OHLC bounds', () => {
  assert.equal(isMarketCandles(response()), true);
  assert.equal(isMarketCandles(response([])), true);
  assert.equal(isMarketCandles({ ...response(), timestampKind: 'open' }), false);
  assert.equal(isMarketCandles({ ...response(), candleIntervalMinutes: 30 }), false);
  assert.equal(isMarketCandles(response([candle(1), candle(1)])), false);
  assert.equal(isMarketCandles(response([candle(0)])), false);
  assert.equal(isMarketCandles(response([{ ...candle(), high: 1 }])), false);
  assert.equal(isMarketCandles(response([{ ...candle(), low: -1 }])), false);
  assert.equal(isMarketCandles(response([{ ...candle(), close: NaN }])), false);
  assert.equal(isMarketCandles(response([candle(Number.MAX_SAFE_INTEGER)])), false);
  assert.equal(isMarketCandles(response(Array.from({ length: 1000 }, (_, i) => candle(i + 1)))), true);
  assert.equal(isMarketCandles(response(Array.from({ length: 1001 }, (_, i) => candle(i + 1)))), false);
  assert.equal(isMarketCandles(response([candle(1), candle(1000000000)])), true, 'real time gaps are allowed');
  for (const [days, candleIntervalMinutes] of [[1, 30], [7, 240], [30, 240], [90, 5760], [365, 5760]]) {
    assert.equal(isMarketCandles({ ...response(), days, candleIntervalMinutes }), true);
  }
});

test('OHLC formatting stays readable while retaining meaningful small price movements', () => {
  assert.equal(formatCandlePrice(75810.55922100782, 'USD'), '$75,810.56');
  assert.equal(formatCandlePrice(1.00001234, 'GBP'), '£1.000012');
  assert.equal(formatCandlePrice(1.00001234, 'USD', true), '$1.00001234');
  assert.equal(formatCandlePrice(0.99998765, 'USD', true), '$0.99998765');
  assert.equal(formatCandlePrice(0.000123456789, 'USD'), '$0.000123457');
  assert.equal(formatCandlePrice(1234.12345678, 'JPY'), '¥1,234.12');
  assert.equal(formatCandlePrice(1e-19, 'USD'), 'USD 1e-19');
});

test('candle zoom and selection pan in whole candle units, including large and short series', () => {
  assert.deepEqual(initialCandleViewport(1000), { start: 760, end: 1000 });
  assert.deepEqual(changeCandleViewport({ start: 760, end: 1000 }, 1000, 'in'), { start: 880, end: 1000 });
  assert.deepEqual(changeCandleViewport({ start: 880, end: 1000 }, 1000, 'earlier'), { start: 820, end: 940 });
  assert.deepEqual(changeCandleViewport({ start: 0, end: 4 }, 1000, 'in'), { start: 0, end: 4 });
  assert.deepEqual(changeCandleViewport({ start: 4, end: 8 }, 12, 'out'), { start: 2, end: 10 });
  assert.deepEqual(revealCandle({ start: 4, end: 8 }, 12, 3), { start: 3, end: 7 });
  assert.deepEqual(revealCandle({ start: 4, end: 8 }, 12, 8), { start: 5, end: 9 });
  assert.deepEqual(initialCandleViewport(0), { start: 0, end: 0 });
  assert.deepEqual(changeCandleViewport({ start: 0, end: 2 }, 2, 'in'), { start: 0, end: 2 });
});

class FakeRequest {
  static last = null;
  constructor() { FakeRequest.last = this; this.headers = {}; this.readyState = 0; this.status = 0; this.responseText = ''; this.aborted = false; }
  open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader() {}
  getResponseHeader(name) { return this.headers[name.toLowerCase()] ?? null; }
  send() { this.sent = true; }
  abort() { this.aborted = true; this.onabort?.(); }
  headersReceived(headers) { this.headers = headers; this.readyState = 2; this.onreadystatechange?.(); }
  progress(loaded, text) { this.responseText = text; this.onprogress?.({ loaded }); }
  complete(status, text) { this.status = status; this.responseText = text; this.onload?.(); }
}

async function withFake(run) {
  const previous = global.XMLHttpRequest;
  global.XMLHttpRequest = FakeRequest;
  try { await run(); } finally { global.XMLHttpRequest = previous; }
}

test('requests the chosen coin, period and currency and accepts an empty provider result', async () => withFake(async () => {
  const result = fetchMarketCandles('bitcoin', 7, 'GBP');
  assert.match(FakeRequest.last.url, /\/api\/market\/candles\/bitcoin\?days=7&currency=GBP$/);
  FakeRequest.last.complete(200, JSON.stringify(response([])));
  assert.deepEqual(await result, response([]));
}));

test('rejects mismatched responses and reports an older server without inventing candles', async () => withFake(async () => {
  const first = fetchMarketCandles('bitcoin', 7, 'GBP');
  FakeRequest.last.complete(200, JSON.stringify({ ...response(), currency: 'USD' }));
  await assert.rejects(first, /unexpected response/);
  const second = fetchMarketCandles('bitcoin', 7, 'GBP');
  FakeRequest.last.complete(404, '{}');
  await assert.rejects(second, /not available on this version/);
}));

test('aborts oversized declared, streamed, and decoded UTF-8 bodies', async () => withFake(async () => {
  const limit = 1024 * 1024;
  const declared = fetchMarketCandles('bitcoin', 7, 'GBP');
  const a = FakeRequest.last;
  a.headersReceived({ 'content-length': String(limit + 1) });
  await assert.rejects(declared, /too large/);
  assert.equal(a.aborted, true);
  const streamed = fetchMarketCandles('bitcoin', 7, 'GBP');
  const b = FakeRequest.last;
  b.progress(limit + 1, 'x');
  await assert.rejects(streamed, /too large/);
  assert.equal(b.aborted, true);
  const decoded = fetchMarketCandles('bitcoin', 7, 'GBP');
  const c = FakeRequest.last;
  c.progress(10, '€'.repeat(Math.floor(limit / 3) + 1));
  await assert.rejects(decoded, /too large/);
  assert.equal(c.aborted, true);
}));

test('accepts a body exactly at the cap and cancels a superseded request', async () => withFake(async () => {
  const limit = 1024 * 1024;
  const payload = JSON.stringify(response());
  const atLimit = fetchMarketCandles('bitcoin', 7, 'GBP');
  FakeRequest.last.complete(200, payload + ' '.repeat(limit - payload.length));
  assert.deepEqual(await atLimit, response());
  const controller = new AbortController();
  const pending = fetchMarketCandles('bitcoin', 7, 'GBP', controller.signal);
  const request = FakeRequest.last;
  controller.abort();
  await assert.rejects(pending, /canceled/);
  assert.equal(request.aborted, true);
}));
