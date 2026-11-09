// Fictional intraday responses only: no provider, device, or network.
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
const { fetchIntradayCandles, formatIntradayPrice, isIntradayCandles } = loadSource(path.join(__dirname, '../src/lib/market'));

function fixture(interval = '3m', days = 1) {
  const intervalMinutes = Number(interval.slice(0, -1));
  const intervalMs = intervalMinutes * 60_000;
  const coveredEnd = Math.floor(Date.UTC(2026, 10, 6, 13, 50) / intervalMs) * intervalMs;
  const coveredStart = coveredEnd - days * 86_400_000;
  const count = days * 86_400_000 / intervalMs;
  const candles = Array.from({ length: count }, (_, index) => ({ timestamp: coveredStart + (index + 1) * intervalMs, open: 100.123, high: 110, low: 90, close: 105.125 }));
  return {
    coinId: 'bitcoin', source: 'Binance Spot', quote: 'USDT', interval, intervalMinutes, days,
    timestampKind: 'close', observedAt: new Date(coveredEnd + 2000).toISOString(), retrievedAt: new Date(coveredEnd + 3000).toISOString(),
    coveredStart, coveredEnd, count, candles,
  };
}

test('accepts each complete supported window and rejects wrong quote, identity, coverage and OHLC', () => {
  for (const [interval, days] of [['3m', 1], ['5m', 1], ['15m', 1], ['15m', 7]]) assert.equal(isIntradayCandles(fixture(interval, days)), true);
  const valid = fixture();
  for (const changed of [
    { ...valid, quote: 'USD' }, { ...valid, source: 'CoinGecko' }, { ...valid, coinId: 'paypal-usd' },
    { ...valid, intervalMinutes: 5 }, { ...valid, days: 7 }, { ...valid, timestampKind: 'open' },
    { ...valid, observedAt: new Date(valid.coveredEnd).toISOString() }, { ...valid, retrievedAt: 'not-a-date' },
    { ...valid, coveredStart: valid.coveredStart + 1 }, { ...valid, coveredEnd: valid.coveredEnd - 1 },
    { ...valid, count: valid.count - 1 }, { ...valid, candles: valid.candles.slice(1) },
    { ...valid, candles: valid.candles.map((bar, index) => index === 4 ? { ...bar, timestamp: bar.timestamp + 180_000 } : bar) },
    { ...valid, candles: valid.candles.map((bar, index) => index === 4 ? { ...bar, high: 1 } : bar) },
    { ...valid, candles: valid.candles.map((bar, index) => index === 4 ? { ...bar, close: NaN } : bar) },
  ]) assert.equal(isIntradayCandles(changed), false);
});

test('USDT labels retain useful decimals without fiat symbols or fiat currency codes', () => {
  assert.equal(formatIntradayPrice(75810.559221), '75,810.56 USDT');
  assert.equal(formatIntradayPrice(1.00001234), '1.000012 USDT');
  assert.equal(formatIntradayPrice(0.000123456789), '0.000123457 USDT');
  assert.equal(formatIntradayPrice(1e-19), '1e-19 USDT');
  for (const value of [75810.559, 1.02, 0.02, 1e-19]) assert.doesNotMatch(formatIntradayPrice(value), /[$£€¥]|\bUSD\b/);
});

class FakeRequest {
  static last = null;
  constructor() { FakeRequest.last = this; this.headers = {}; this.responseText = ''; this.status = 0; this.aborted = false; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() {}
  getResponseHeader(name) { return this.headers[name.toLowerCase()] ?? null; }
  send() {}
  abort() { this.aborted = true; this.onabort?.(); }
  complete(status, body) { this.status = status; this.responseText = body; this.onload?.(); }
  progress(loaded, body) { this.responseText = body; this.onprogress?.({ loaded }); }
}
async function withFake(callback) {
  const previous = global.XMLHttpRequest;
  global.XMLHttpRequest = FakeRequest;
  try { await callback(); } finally { global.XMLHttpRequest = previous; }
}

test('intraday requests carry an explicit source window and reject mismatched responses', async () => withFake(async () => {
  const good = fetchIntradayCandles('bitcoin', '15m', 7);
  assert.match(FakeRequest.last.url, /\/api\/market\/intraday\/bitcoin\?interval=15m&days=7$/);
  FakeRequest.last.complete(200, JSON.stringify(fixture('15m', 7)));
  assert.equal((await good).quote, 'USDT');
  const bad = fetchIntradayCandles('bitcoin', '3m', 1);
  FakeRequest.last.complete(200, JSON.stringify(fixture('5m', 1)));
  await assert.rejects(bad, /unexpected response/);
}));

test('missing windows and rate limits are explicit, with bounded bodies and cancellation', async () => withFake(async () => {
  const gap = fetchIntradayCandles('bitcoin', '3m', 1);
  FakeRequest.last.complete(503, JSON.stringify({ error: { code: 'intraday_data_gap', message: 'secret upstream details' } }));
  await assert.rejects(gap, (error) => /missing or no-trade/.test(error.message) && !error.message.includes('secret'));
  const busy = fetchIntradayCandles('bitcoin', '3m', 1);
  FakeRequest.last.complete(429, '{}');
  await assert.rejects(busy, /rate limited/);
  const large = fetchIntradayCandles('bitcoin', '3m', 1);
  const largeRequest = FakeRequest.last;
  largeRequest.progress(1024 * 1024 + 1, 'x');
  await assert.rejects(large, /too large/);
  assert.equal(largeRequest.aborted, true);
  const controller = new AbortController();
  const pending = fetchIntradayCandles('bitcoin', '3m', 1, controller.signal);
  const request = FakeRequest.last;
  controller.abort();
  await assert.rejects(pending, /canceled/);
  assert.equal(request.aborted, true);
}));
