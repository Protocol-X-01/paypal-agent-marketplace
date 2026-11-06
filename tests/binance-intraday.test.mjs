// Real TypeScript adapter and route, with deterministic fictional provider data.
// Run in an unshared network namespace; no dotenv or provider access is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { NextResponse } = require('next/server');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 10, 6, 13, 50, 33);
const MAX_BYTES = 1024 * 1024;
const sentinel = 'provider-secret-body-must-not-escape';

function simulation(handler) {
  const clock = { now: NOW };
  const calls = [];
  const isolatedGlobal = {};
  const fakeProcess = { env: { NODE_ENV: 'development' } };
  class FakeDate extends Date {
    constructor(value) { super(value === undefined ? clock.now : value); }
    static now() { return clock.now; }
  }
  const fakeFetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://data-api.binance.vision');
    assert.equal(parsed.pathname, '/api/v3/klines');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    calls.push({ url: parsed, init });
    return handler(parsed, init, calls.length, clock);
  };
  const modules = new Map();
  function load(relative) {
    const absolute = path.join(project, relative);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const loaded = { exports: {} };
    modules.set(absolute, loaded);
    const source = fs.readFileSync(absolute, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (name) => {
      if (name === 'server-only') return {};
      if (name === 'next/server') return { NextResponse };
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      throw new Error(`Unexpected dependency: ${name}`);
    };
    new Function('exports', 'require', 'module', 'globalThis', 'process', 'fetch', 'Date', compiled)(
      loaded.exports, localRequire, loaded, isolatedGlobal, fakeProcess, fakeFetch, FakeDate,
    );
    return loaded.exports;
  }
  return {
    calls, clock, fakeFetch,
    provider: load('src/lib/binance-intraday.ts'),
    route: load('src/app/api/market/intraday/[coinId]/route.ts'),
  };
}

function rowsFor(url) {
  const start = Number(url.searchParams.get('startTime'));
  const end = Number(url.searchParams.get('endTime')) + 1;
  const interval = Number(url.searchParams.get('interval').slice(0, -1)) * 60_000;
  const count = Number(url.searchParams.get('limit'));
  assert.equal((end - start) / interval, count);
  assert.ok(count <= 1000);
  return Array.from({ length: count }, (_, i) => [
    start + i * interval, '100.12345678', '110.00000000', '90.00000000', '105.12500000', '1.00000000',
    start + (i + 1) * interval - 1, '105.12500000', 5, '0.5', '52.5', '0',
  ]);
}
function reply(value, clock, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('date')) headers.set('date', new Date(clock.now).toUTCString());
  const body = typeof value === 'string' || value instanceof ReadableStream ? value : JSON.stringify(value);
  return new Response(body, { ...init, headers });
}
const success = (url, _init, _n, clock) => reply(rowsFor(url), clock);
const request = (query, headers = {}) => new Request(`http://markets.local/api/market/intraday/bitcoin${query}`, { headers: { host: 'markets.local', ...headers } });
const callRoute = (sim, query, coinId = 'bitcoin', headers = {}) => sim.route.GET(request(query, headers), { params: Promise.resolve({ coinId }) });
const errKind = (kind) => (error) => error?.kind === kind && !String(error.message).includes(sentinel);

test('all six asset mappings, four allowed windows and precise close/coverage metadata', async () => {
  for (const [coin, symbol] of Object.entries({ bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT', chainlink: 'LINKUSDT', litecoin: 'LTCUSDT', 'bitcoin-cash': 'BCHUSDT' })) {
    const sim = simulation(success);
    for (const [interval, days, expected] of [['3m', 1, 480], ['5m', 1, 288], ['15m', 1, 96], ['15m', 7, 672]]) {
      const value = await sim.provider.getIntradayCandles(coin, interval, days);
      const url = sim.calls.at(-1).url;
      assert.equal(url.searchParams.get('symbol'), symbol);
      assert.deepEqual([...url.searchParams.keys()], ['symbol', 'interval', 'startTime', 'endTime', 'limit']);
      assert.equal(value.source, 'Binance Spot');
      assert.equal(value.quote, 'USDT');
      assert.equal(value.coinId, coin);
      assert.equal(value.interval, interval);
      assert.equal(value.intervalMinutes, Number(interval.slice(0, -1)));
      assert.equal(value.days, days);
      assert.equal(value.timestampKind, 'close');
      assert.equal(value.count, expected);
      assert.equal(value.candles.length, expected);
      assert.equal(value.coveredStart, Number(url.searchParams.get('startTime')));
      assert.equal(value.coveredEnd, Number(url.searchParams.get('endTime')) + 1);
      assert.equal(value.candles.at(-1).timestamp, value.coveredEnd);
      assert.equal(value.candles[0].timestamp, value.coveredStart + value.intervalMinutes * 60_000);
      assert.deepEqual(value.candles[0], { timestamp: value.candles[0].timestamp, open: 100.12345678, high: 110, low: 90, close: 105.125 });
      assert.equal(value.observedAt, new Date(NOW).toISOString());
      assert.equal(value.retrievedAt, new Date(NOW).toISOString());
    }
  }
});

test('route rejects unsupported, repeated, missing and unknown parameters before fetch', async () => {
  const sim = simulation(success);
  const cases = [
    ['?interval=3m&days=1', 'paypal-usd', 'unsupported_coin'],
    ['?interval=3m&days=1', '__proto__', 'unsupported_coin'],
    ['?interval=1m&days=1', 'bitcoin', 'unsupported_interval'],
    ['?interval=3m&days=01', 'bitcoin', 'unsupported_days'],
    ['?interval=3m&days=7', 'bitcoin', 'unsupported_window'],
    ['?interval=5m&days=7', 'bitcoin', 'unsupported_window'],
    ['?interval=3m&days=1&currency=USD', 'bitcoin', 'unsupported_parameters'],
    ['?interval=3m&interval=5m&days=1', 'bitcoin', 'unsupported_parameters'],
    ['?interval=3m&days=1&days=1', 'bitcoin', 'unsupported_parameters'],
    ['?days=1', 'bitcoin', 'unsupported_parameters'],
  ];
  for (const [query, coin, code] of cases) {
    const response = await callRoute(sim, query, coin);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(sim.calls.length, 0);
});

test('successful route and origin/preflight policy preserve the existing CORS boundary', async () => {
  const sim = simulation(success);
  const good = await callRoute(sim, '?interval=15m&days=1', 'bitcoin', { origin: 'http://localhost:8081' });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal((await good.json()).quote, 'USDT');
  const denied = await callRoute(sim, '?interval=15m&days=1', 'bitcoin', { origin: 'https://unrelated.invalid' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'origin_not_allowed');
  const preflight = sim.route.OPTIONS(request('', { origin: 'http://localhost:8081', 'access-control-request-method': 'GET', 'access-control-request-headers': 'accept' }));
  assert.equal(preflight.status, 204);
  assert.equal(sim.route.OPTIONS(request('', { origin: 'https://unrelated.invalid', 'access-control-request-method': 'GET' })).status, 403);
  assert.equal(sim.calls.length, 1);
});

test('missing, duplicate, misplaced, unclosed and zero-trade bars fail as an explicit gap', async () => {
  const variants = [
    (rows) => rows.slice(1),
    (rows) => { rows[10][0] = rows[9][0]; rows[10][6] = rows[9][6]; return rows; },
    (rows) => { rows[10][0] += 180_000; rows[10][6] += 180_000; return rows; },
    (rows) => { rows[10][8] = 0; return rows; },
  ];
  for (const mutate of variants) {
    const sim = simulation((url, _init, _n, clock) => reply(mutate(rowsFor(url)), clock));
    const response = await callRoute(sim, '?interval=3m&days=1');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'intraday_data_gap');
  }
  const nearBoundary = simulation((url, _init, _n, clock) => reply(rowsFor(url), clock));
  // Local and provider clocks may differ: the requested last bar is not old enough according to the provider header.
  nearBoundary.clock.now = Date.UTC(2026, 10, 6, 13, 51, 2);
  const clockBehind = simulation((url, _init, _n, clock) => reply(rowsFor(url), clock, { headers: { date: new Date(clock.now - 2_000).toUTCString() } }));
  clockBehind.clock.now = nearBoundary.clock.now;
  await assert.rejects(clockBehind.provider.getIntradayCandles('bitcoin', '3m', 1), errKind('data_gap'));
});

test('invalid candle structure, OHLC, volume, timestamps and JSON never leak upstream bodies', async () => {
  const variants = [
    () => sentinel,
    () => ({ secret: sentinel }),
    (rows) => { rows[0] = rows[0].slice(0, 11); return rows; },
    (rows) => { rows[0][1] = 'NaN'; return rows; },
    (rows) => { rows[0][1] = '-1'; return rows; },
    (rows) => { rows[0][2] = '1'; return rows; },
    (rows) => { rows[0][3] = '109'; return rows; },
    (rows) => { rows[0][5] = '0'; return rows; },
    (rows) => { rows[0][6] += 1; return rows; },
    (rows) => { rows[0][8] = -1; return rows; },
    (rows) => [...rows, rows.at(-1)],
  ];
  for (const mutate of variants) {
    const sim = simulation((url, _init, _n, clock) => reply(mutate(rowsFor(url)), clock));
    const response = await callRoute(sim, '?interval=3m&days=1');
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'intraday_invalid_response');
    assert.ok(!text.includes(sentinel));
  }
});

test('missing, invalid, future-skewed and stale provider HTTP dates fail closed', async () => {
  for (const value of [null, 'not-a-date', new Date(NOW + 31_000).toUTCString(), new Date(NOW - 31_000).toUTCString()]) {
    const sim = simulation((url) => new Response(JSON.stringify(rowsFor(url)), { headers: value ? { date: value } : {} }));
    await assert.rejects(sim.provider.getIntradayCandles('bitcoin', '3m', 1), errKind('unavailable'));
  }
});

test('body cap counts decoded bytes across chunks and rejects malformed UTF-8', async () => {
  for (const delta of [0, 1]) {
    const sim = simulation((url, _init, _n, clock) => {
      const prefix = JSON.stringify(rowsFor(url));
      const body = prefix + ' '.repeat(MAX_BYTES - prefix.length + delta);
      const bytes = new TextEncoder().encode(body);
      const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 100)); controller.enqueue(bytes.slice(100)); controller.close(); } });
      return reply(stream, clock);
    });
    if (delta === 0) assert.equal((await sim.provider.getIntradayCandles('bitcoin', '3m', 1)).count, 480);
    else await assert.rejects(sim.provider.getIntradayCandles('bitcoin', '3m', 1), errKind('invalid_response'));
  }
  const invalid = simulation((_url, _init, _n, clock) => new Response(Uint8Array.from([0xc3, 0x28]), { headers: { date: new Date(clock.now).toUTCString() } }));
  await assert.rejects(invalid.provider.getIntradayCandles('bitcoin', '3m', 1), errKind('invalid_response'));
  const oversized = simulation((_url, _init, _n, clock) => new Response('x', { headers: { date: new Date(clock.now).toUTCString(), 'content-length': String(MAX_BYTES + 1) } }));
  await assert.rejects(oversized.provider.getIntradayCandles('bitcoin', '3m', 1), errKind('invalid_response'));
});

test('deadline aborts a stalled fetch and cancels a nonsettling body read without retrying', async () => {
  const sim = simulation(() => new Promise(() => {}));
  const stalled = sim.provider.createBinanceIntradayClient({ fetcher: sim.fakeFetch, now: () => sim.clock.now, deadlineMs: 20 });
  await assert.rejects(stalled.get('bitcoin', '3m', 1), errKind('unavailable'));
  assert.equal(sim.calls.length, 1);
  assert.equal(sim.calls[0].init.signal.aborted, true);
  let cancellations = 0;
  const read = simulation((_url, _init, _n, clock) => ({
    ok: true, status: 200, headers: new Headers({ date: new Date(clock.now).toUTCString() }),
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancellations += 1; return new Promise(() => {}); }, releaseLock() {} }) },
  }));
  const client = read.provider.createBinanceIntradayClient({ fetcher: read.fakeFetch, now: () => read.clock.now, deadlineMs: 20 });
  await assert.rejects(client.get('bitcoin', '3m', 1), errKind('unavailable'));
  assert.equal(cancellations, 1);
  assert.equal(read.calls.length, 1);
});

test('a provider response arriving after the deadline is canceled before its body is read', async () => {
  let deliver;
  let cancellations = 0;
  let reads = 0;
  const sim = simulation(() => new Promise((resolve) => { deliver = resolve; }));
  const client = sim.provider.createBinanceIntradayClient({ fetcher: sim.fakeFetch, now: () => sim.clock.now, deadlineMs: 20 });
  await assert.rejects(client.get('bitcoin', '3m', 1), errKind('unavailable'));
  deliver({
    ok: true, status: 200, headers: new Headers({ date: new Date(sim.clock.now).toUTCString() }),
    body: { getReader: () => ({ read: () => { reads += 1; return new Promise(() => {}); }, cancel: () => { cancellations += 1; return Promise.resolve(); }, releaseLock() {} }) },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
  assert.equal(sim.calls.length, 1);
});

test('provider rate limits preserve long cooldowns, while access and redirect failures stay generic', async () => {
  for (const [status, seconds] of [[418, 86400], [429, 999999]]) {
    const sim = simulation((_url, _init, _n, clock) => reply(sentinel, clock, { status, headers: { 'retry-after': String(seconds) } }));
    const first = await callRoute(sim, '?interval=3m&days=1');
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), String(seconds));
    assert.ok(!(await first.text()).includes(sentinel));
    sim.clock.now += 3_601_000;
    const second = await callRoute(sim, '?interval=15m&days=1', 'ethereum');
    assert.equal(second.status, 429);
    assert.equal(sim.calls.length, 1);
    sim.clock.now += (seconds - 3601) * 1000;
    await callRoute(sim, '?interval=15m&days=1', 'ethereum');
    assert.equal(sim.calls.length, 2);
  }
  const unrepresentable = simulation((_url, _init, _n, clock) => reply(sentinel, clock, { status: 429, headers: { 'retry-after': '9999999999999999' } }));
  assert.equal((await callRoute(unrepresentable, '?interval=3m&days=1')).headers.get('retry-after'), '86400');
  unrepresentable.clock.now += 100 * 365 * 86_400_000;
  const stillBlocked = await callRoute(unrepresentable, '?interval=15m&days=1', 'ethereum');
  assert.equal(stillBlocked.status, 429);
  assert.equal(stillBlocked.headers.get('retry-after'), '86400');
  assert.equal(unrepresentable.calls.length, 1);
  for (const status of [400, 403, 451, 500]) {
    const sim = simulation((_url, _init, _n, clock) => reply(sentinel, clock, { status }));
    const response = await callRoute(sim, '?interval=3m&days=1');
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(sentinel));
    assert.equal(sim.calls.length, 1);
  }
  const redirected = simulation(() => { throw new TypeError(sentinel); });
  const result = await callRoute(redirected, '?interval=3m&days=1');
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes(sentinel));
});

test('cache shares identical work for 15 seconds and per-process budget stops excess fetches', async () => {
  const sim = simulation(success);
  const first = await sim.provider.getIntradayCandles('bitcoin', '3m', 1);
  const cached = await sim.provider.getIntradayCandles('bitcoin', '3m', 1);
  assert.deepEqual(first, cached);
  assert.equal(sim.calls.length, 1);
  sim.clock.now += 15_000;
  await sim.provider.getIntradayCandles('bitcoin', '3m', 1);
  assert.equal(sim.calls.length, 2);
  for (const coin of ['ethereum', 'solana', 'chainlink', 'litecoin', 'bitcoin-cash']) {
    await sim.provider.getIntradayCandles(coin, '3m', 1);
    await sim.provider.getIntradayCandles(coin, '5m', 1);
  }
  assert.equal(sim.calls.length, 12);
  await assert.rejects(sim.provider.getIntradayCandles('bitcoin', '5m', 1), errKind('rate_limited'));
  assert.equal(sim.calls.length, 12);
  sim.clock.now += 60_000;
  await sim.provider.getIntradayCandles('bitcoin', '5m', 1);
  assert.equal(sim.calls.length, 13);
});

test('single-flight and concurrency limits prevent a burst of identical or excess requests', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sim = simulation(async (url, init, n, clock) => { await gate; return success(url, init, n, clock); });
  const a = sim.provider.getIntradayCandles('bitcoin', '3m', 1);
  const duplicate = sim.provider.getIntradayCandles('bitcoin', '3m', 1);
  const rest = ['ethereum', 'solana', 'chainlink'].map((coin) => sim.provider.getIntradayCandles(coin, '3m', 1));
  await assert.rejects(sim.provider.getIntradayCandles('litecoin', '3m', 1), errKind('rate_limited'));
  assert.equal(sim.calls.length, 4);
  release();
  const [first, second] = await Promise.all([a, duplicate, ...rest]);
  assert.deepEqual(first, second);
});

test('actual HTTP transport against a loopback-only fictional provider exercises serialization and no credentials', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const incoming = new URL(req.url, 'http://127.0.0.1');
    seen.push({ method: req.method, url: incoming, auth: req.headers.authorization });
    const body = JSON.stringify(rowsFor(incoming));
    res.writeHead(200, { 'content-type': 'application/json', date: new Date(NOW).toUTCString() });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const sim = simulation((url, init) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init));
  const response = await callRoute(sim, '?interval=15m&days=1');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 96);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url.searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(seen[0].auth, undefined);
});
