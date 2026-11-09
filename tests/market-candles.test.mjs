// Actual TypeScript provider and route modules with an isolated fake transport.
// Run: node --test tests/market-candles.test.mjs. No dotenv or network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const zod = require('zod');
const { NextResponse } = require('next/server');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 1024 * 1024;
const T0 = 1_750_000_000_000;
const encoder = new TextEncoder();
const secretSentinel = 'provider-body-sentinel-not-for-clients';

function simulation(fetchHandler, envOverrides = {}) {
  const clock = { now: T0 };
  const env = { NODE_ENV: 'development', COINGECKO_DEMO_API_KEY: 'synthetic-test-key', ...envOverrides };
  const state = { calls: [], deadlines: [], cacheLives: [] };
  const isolatedGlobal = {};
  const fakeProcess = { env };
  class FakeDate extends Date {
    constructor(value) { super(value === undefined ? clock.now : value); }
    static now() { return clock.now; }
  }
  const fakeAbortSignal = {
    timeout(ms) {
      const controller = new AbortController();
      state.deadlines.push({ ms, controller });
      return controller.signal;
    },
  };
  const fakeFetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.coingecko.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-cg-demo-api-key'], 'synthetic-test-key');
    state.calls.push({ url: parsed, options });
    return fetchHandler(parsed, options, state.calls.length);
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
      if (name === 'zod') return zod;
      if (name === 'next/cache') return { cacheLife: (value) => state.cacheLives.push(value) };
      if (name === 'next/server') return { NextResponse };
      if (name === '@/lib/request-limits') return {
        takeClientRequestLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
      };
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.relative(project, path.resolve(path.dirname(absolute), `${name}.ts`)));
      throw new Error(`Unexpected dependency in candle simulation: ${name}`);
    };
    new Function('exports', 'require', 'module', 'globalThis', 'process', 'fetch', 'AbortSignal', 'Date', compiled)(
      loaded.exports, localRequire, loaded, isolatedGlobal, fakeProcess, fakeFetch, fakeAbortSignal, FakeDate,
    );
    return loaded.exports;
  }
  return {
    state, env, clock,
    provider: load('src/lib/market-data.ts'),
    route: load('src/app/api/market/candles/[coinId]/route.ts'),
    chartRoute: load('src/app/api/market/chart/[coinId]/route.ts'),
    quoteRoute: load('src/app/api/market/quotes/route.ts'),
    overviewRoute: load('src/app/api/market/coins/route.ts'),
  };
}

const fixture = [[T0 - 1_000, 1.00001234, 1.2, 0.9, 1.05], [T0, 1.05, 1.3, 1, 1.15]];
const reply = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, ...init });
const request = (query = '', headers = {}) => new Request(`http://markets.local/api/market/candles/bitcoin${query}`, { headers: { host: 'markets.local', ...headers } });
const callRoute = (sim, query = '', coinId = 'bitcoin', headers = {}) => sim.route.GET(request(query, headers), { params: Promise.resolve({ coinId }) });
const json = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('line history rejects invalid numeric samples while retaining valid partial series', async () => {
  let body = { prices: [[T0 - 1_000, 0], [T0, 1.25]], market_caps: [], total_volumes: [[T0, 10.5]] };
  const sim = simulation(() => reply(body));
  const requestChart = () => sim.chartRoute.GET(
    new Request('http://markets.local/api/market/chart/bitcoin?days=7&currency=GBP', { headers: { host: 'markets.local' } }),
    { params: Promise.resolve({ coinId: 'bitcoin' }) },
  );
  let result = await json(await requestChart());
  assert.equal(result.status, 200);
  assert.equal(result.body.currency, 'GBP');
  assert.deepEqual(result.body.prices, [{ timestamp: T0 - 1_000, value: 0 }, { timestamp: T0, value: 1.25 }]);
  assert.deepEqual(result.body.marketCaps, []);
  for (const invalid of [
    { prices: [[T0, -1]], market_caps: [], total_volumes: [] },
    { prices: [[T0, 1]], market_caps: [[T0, -1]], total_volumes: [] },
    { prices: [[T0, 1]], market_caps: [], total_volumes: [[T0, -1]] },
    { prices: [[T0 + 0.5, 1]], market_caps: [], total_volumes: [] },
    { prices: [[8_640_000_000_000_001, 1]], market_caps: [], total_volumes: [] },
    { prices: [[-8_640_000_000_000_001, 1]], market_caps: [], total_volumes: [] },
  ]) {
    body = invalid;
    result = await json(await requestChart());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'upstream_invalid_response');
    assert.doesNotMatch(JSON.stringify(result.body), /market_caps|total_volumes|prices/);
  }
});

test('rate-limited sparkline fallback labels inferred samples and returns ordered integer milliseconds', async () => {
  const prices = Array.from({ length: 11 }, (_, index) => index + 1);
  const bitcoin = { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100, market_cap: 10, total_volume: 1, high_24h: 120, low_24h: 80,
    last_updated: new Date(T0).toISOString(), sparkline_in_7d: { price: prices } };
  const sim = simulation((url) => url.pathname.endsWith('/market_chart')
    ? new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } })
    : reply([bitcoin]));
  const response = await sim.chartRoute.GET(
    new Request('http://markets.local/api/market/chart/bitcoin?days=7&currency=GBP', { headers: { host: 'markets.local' } }),
    { params: Promise.resolve({ coinId: 'bitcoin' }) },
  );
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.currency, 'GBP');
  assert.equal(result.body.seriesSource, 'market_overview_sparkline');
  assert.deepEqual(result.body.availableMetrics, ['price']);
  assert.deepEqual(result.body.prices.map(({ value }) => value), prices);
  for (let i = 0; i < prices.length; i += 1) {
    const actual = result.body.prices[i].timestamp;
    const inferred = T0 - (prices.length - i) * (7 * 24 * 60 * 60 * 1000 / prices.length);
    assert.equal(Number.isSafeInteger(actual), true);
    assert.ok(Math.abs(actual - inferred) <= 0.5);
    if (i) assert.ok(actual > result.body.prices[i - 1].timestamp);
  }
  assert.equal(sim.state.calls.length, 2);
});

test('duplicate provider IDs are rejected for both quote routes while partial unique data remains usable', async () => {
  const bitcoin = { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100, market_cap: 10, total_volume: 1, high_24h: 120, low_24h: 80 };
  let rows = [bitcoin, { ...bitcoin, current_price: 200 }];
  const sim = simulation(() => reply(rows));
  const quotes = () => sim.quoteRoute.GET(new Request('http://markets.local/api/market/quotes?currency=GBP', { headers: { host: 'markets.local' } }));
  const overview = () => sim.overviewRoute.GET(new Request('http://markets.local/api/market/coins', { headers: { host: 'markets.local' } }));
  for (const route of [quotes, overview]) {
    const result = await json(await route());
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'upstream_invalid_response');
    assert.doesNotMatch(JSON.stringify(result.body), /current_price|Bitcoin/);
  }
  rows = [bitcoin];
  const partial = await json(await quotes());
  assert.equal(partial.status, 200);
  assert.equal(partial.body.coins.length, 1);
  assert.equal(partial.body.coins[0].price, 100);
});

function bodyResponse(chunks, { status = 200, headers = {}, neverFinish = false } = {}) {
  let position = 0;
  let canceled = 0;
  const reader = {
    async read() {
      if (position < chunks.length) return { done: false, value: chunks[position++] };
      if (neverFinish) return new Promise(() => {});
      return { done: true };
    },
    cancel() { canceled += 1; return neverFinish ? new Promise(() => {}) : Promise.resolve(); },
    releaseLock() {},
  };
  return {
    response: {
      status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: { getReader: () => reader },
      // Model response.json as well so the regression exposes the old unbounded path.
      async json() {
        if (neverFinish) return new Promise(() => {});
        return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
      },
    },
    canceled: () => canceled,
  };
}

test('quote and line-history bodies enforce their own decoded-byte limits', async () => {
  const coin = { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100, market_cap: 10, total_volume: 1, high_24h: 120, low_24h: 80 };
  for (const [kind, limit, data] of [
    ['quotes', 2 * LIMIT, [coin]],
    ['chart', 4 * LIMIT, { prices: [[T0, 1]], market_caps: [], total_volumes: [] }],
  ]) {
    const raw = JSON.stringify(data);
    const exact = encoder.encode(raw + ' '.repeat(limit - raw.length));
    let selected = bodyResponse([exact], { headers: { 'content-length': String(limit) } });
    const sim = simulation(() => selected.response);
    const request = () => kind === 'quotes'
      ? sim.quoteRoute.GET(new Request('http://markets.local/api/market/quotes?currency=GBP', { headers: { host: 'markets.local' } }))
      : sim.chartRoute.GET(new Request('http://markets.local/api/market/chart/bitcoin?days=90&currency=GBP', { headers: { host: 'markets.local' } }), { params: Promise.resolve({ coinId: 'bitcoin' }) });
    let result = await json(await request());
    assert.equal(result.status, 200, `${kind} accepts a valid body at its limit`);
    assert.equal(result.body.currency, 'GBP');

    selected = bodyResponse([encoder.encode(raw)], { headers: { 'content-length': String(limit + 1) } });
    let headerCancelCount = 0;
    selected.response.body.cancel = () => { headerCancelCount += 1; return new Promise(() => {}); };
    result = await json(await request());
    assert.equal(result.status, 502, `${kind} rejects an oversized declared body`);
    assert.equal(result.body.error.code, 'upstream_invalid_response');
    assert.equal(headerCancelCount, 1, 'header rejection does not await cancellation');

    for (const headers of [{}, { 'content-length': '2' }]) {
      selected = bodyResponse([exact, encoder.encode(' ')], { headers });
      result = await json(await request());
      assert.equal(result.status, 502, `${kind} rejects an oversized streamed body`);
      assert.equal(result.body.error.code, 'upstream_invalid_response');
      assert.equal(selected.canceled(), 1);
    }
    selected = bodyResponse([new Uint8Array([0x5b, 0xff, 0x5d])]);
    result = await json(await request());
    assert.equal(result.status, 502, `${kind} rejects malformed UTF-8`);
    assert.equal(result.body.error.code, 'upstream_invalid_response');
  }
});

test('a nonsettling quote or history stream times out without awaiting cancellation', { timeout: 2_000 }, async () => {
  for (const kind of ['quotes', 'chart']) {
    const stuck = bodyResponse([], { neverFinish: true });
    const sim = simulation(() => stuck.response);
    const pending = kind === 'quotes'
      ? sim.quoteRoute.GET(new Request('http://markets.local/api/market/quotes?currency=USD', { headers: { host: 'markets.local' } }))
      : sim.chartRoute.GET(new Request('http://markets.local/api/market/chart/bitcoin?days=7&currency=USD', { headers: { host: 'markets.local' } }), { params: Promise.resolve({ coinId: 'bitcoin' }) });
    await flush();
    assert.equal(sim.state.deadlines[0].ms, 8_000);
    sim.state.deadlines[0].controller.abort();
    const result = await json(await pending);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'market_data_unavailable');
    assert.equal(stuck.canceled(), 1);
    assert.equal(sim.state.calls.length, 1);
  }
});

test('a 90-day hourly-size fictional history remains intact', async () => {
  const points = Array.from({ length: 2_161 }, (_, index) => [T0 - index * 3_600_000, 1.2345678901234567]);
  const sim = simulation(() => reply({ prices: points, market_caps: points, total_volumes: points }));
  const result = await sim.provider.getMarketChart('bitcoin', 90, 'USD');
  assert.equal(result.prices.length, points.length);
  assert.equal(result.marketCaps.length, points.length);
  assert.equal(result.volumes.length, points.length);
  assert.deepEqual(result.prices[0], { timestamp: points[0][0], value: points[0][1] });
});

test('a rate-limited history does not return a fallback from an oversized quote response', async () => {
  const tooLarge = bodyResponse([], { headers: { 'content-length': String(2 * LIMIT + 1) } });
  let cancelled = 0;
  tooLarge.response.body.cancel = () => { cancelled += 1; return new Promise(() => {}); };
  const sim = simulation((url) => url.pathname.endsWith('/market_chart')
    ? new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } })
    : tooLarge.response);
  const response = await sim.chartRoute.GET(
    new Request('http://markets.local/api/market/chart/bitcoin?days=7&currency=GBP', { headers: { host: 'markets.local' } }),
    { params: Promise.resolve({ coinId: 'bitcoin' }) },
  );
  const result = await json(response);
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'upstream_invalid_response');
  assert.equal(cancelled, 1);
  assert.equal(sim.state.calls.length, 2);
});

test('USD and GBP requests preserve exact OHLC and close times for every Demo interval', async () => {
  const sim = simulation(() => reply(fixture));
  for (const [days, interval] of [[1, 30], [7, 240], [30, 240], [90, 5760], [365, 5760]]) {
    for (const currency of ['USD', 'GBP']) {
      const result = await sim.provider.getMarketCandles('bitcoin', days, currency);
      assert.deepEqual(result.candles, fixture.map(([timestamp, open, high, low, close]) => ({ timestamp, open, high, low, close })));
      assert.equal(result.currency, currency);
      assert.equal(result.days, days);
      assert.equal(result.coinId, 'bitcoin');
      assert.equal(result.candleIntervalMinutes, interval);
      assert.equal(result.timestampKind, 'close');
      assert.equal(result.source, 'CoinGecko');
      assert.equal(result.retrievedAt, new Date(T0).toISOString());
      const call = sim.state.calls.at(-1);
      assert.equal(call.url.pathname, '/api/v3/coins/bitcoin/ohlc');
      assert.deepEqual(Object.fromEntries(call.url.searchParams), { vs_currency: currency.toLowerCase(), days: String(days), precision: 'full' });
      assert.equal(sim.state.deadlines.at(-1).ms, 8_000);
    }
  }
  assert.deepEqual(sim.state.cacheLives.at(-1), { stale: 60, revalidate: 60, expire: 600 });
});

test('empty results and exactly 1000 strictly ordered candles are accepted', async () => {
  const large = Array.from({ length: 1000 }, (_, i) => [T0 + i, 1, 2, 0.5, 1.5]);
  let values = [];
  const sim = simulation(() => reply(values));
  assert.deepEqual((await sim.provider.getMarketCandles('bitcoin', 7, 'USD')).candles, []);
  values = large;
  const result = await sim.provider.getMarketCandles('bitcoin', 7, 'USD');
  assert.equal(result.candles.length, 1000);
  assert.deepEqual(result.candles.at(-1), { timestamp: T0 + 999, open: 1, high: 2, low: 0.5, close: 1.5 });
});

test('malformed, nonfinite, inconsistent, unordered, duplicated and oversized rows fail without body leakage', async () => {
  const bad = [
    '{not-json', JSON.stringify({ bad: secretSentinel }), JSON.stringify([[1, 1, 2, 0]]),
    JSON.stringify([[1, -1, 2, 0, 1]]), JSON.stringify([[1, 2, 1, 0, 1]]),
    JSON.stringify([[1, 1, 2, 1.5, 1]]), '[[1,1e999,1e999,0,1e999]]',
    JSON.stringify([[0, 1, 2, 0, 1]]), JSON.stringify([[8_640_000_000_000_001, 1, 2, 0, 1]]),
    JSON.stringify([[1, 1, 2, 0, 1], [1, 1, 2, 0, 1]]),
    JSON.stringify([[2, 1, 2, 0, 1], [1, 1, 2, 0, 1]]),
    JSON.stringify(Array.from({ length: 1001 }, (_, i) => [i + 1, 1, 2, 0, 1])),
  ];
  let body = '';
  const sim = simulation(() => new Response(body));
  for (const input of bad) {
    body = input;
    const result = await json(await callRoute(sim));
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'upstream_invalid_response');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secretSentinel));
  }
  assert.deepEqual(sim.state.cacheLives.at(-1), { stale: 0, revalidate: 0, expire: 1 });
});

test('accepts exactly 1 MiB of decoded JSON and rejects over-limit declared or chunked bodies', async () => {
  const exact = encoder.encode('[]' + ' '.repeat(LIMIT - 2));
  let selected = bodyResponse([exact], { headers: { 'content-length': String(LIMIT) } });
  const sim = simulation(() => selected.response);
  assert.deepEqual((await sim.provider.getMarketCandles('bitcoin', 7, 'USD')).candles, []);
  selected = bodyResponse([], { headers: { 'content-length': String(LIMIT + 1) } });
  // A response with a declared excess is rejected without acquiring its reader.
  selected.response.body.cancel = () => { selected.response.canceledAtHeader = true; return Promise.resolve(); };
  await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  assert.equal(selected.response.canceledAtHeader, true);
  selected = bodyResponse([exact, encoder.encode(' ')], { headers: { 'content-length': '2' } });
  await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  assert.equal(selected.canceled(), 1, 'lying or absent length cannot bypass the streamed byte cap');
  selected = bodyResponse([exact, encoder.encode(' ')]);
  await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  assert.equal(selected.canceled(), 1);
});

test('counts decoded UTF-8 bytes and rejects malformed UTF-8 and invalid length headers', async () => {
  const multibyte = encoder.encode('["' + '€'.repeat(Math.floor(LIMIT / 3) + 1) + '"]');
  let selected = bodyResponse([multibyte]);
  const sim = simulation(() => selected.response);
  await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  assert.equal(selected.canceled(), 1);
  selected = bodyResponse([new Uint8Array([0x5b, 0xff, 0x5d])]);
  await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  for (const length of ['-1', '1.5', '999999999999999999999']) {
    selected = bodyResponse([], { headers: { 'content-length': length } });
    selected.response.body.cancel = () => Promise.resolve();
    await assert.rejects(sim.provider.getMarketCandles('bitcoin', 7, 'USD'), { kind: 'invalid_response' });
  }
});

test('the 8-second abort signal covers a connection that has not returned headers', async () => {
  const sim = simulation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  }));
  const pending = callRoute(sim);
  await flush();
  assert.equal(sim.state.deadlines[0].ms, 8_000);
  sim.state.deadlines[0].controller.abort();
  const result = await json(await pending);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'market_data_unavailable');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(sim.state.calls.length, 1);
});

test('a nonsettling body read is aborted and cancellation is not awaited', { timeout: 2000 }, async () => {
  const stuck = bodyResponse([], { neverFinish: true });
  const sim = simulation(() => stuck.response);
  const pending = callRoute(sim);
  await flush();
  assert.equal(sim.state.deadlines[0].ms, 8_000);
  sim.state.deadlines[0].controller.abort();
  const result = await json(await pending);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'market_data_unavailable');
  assert.equal(stuck.canceled(), 1);
  assert.equal(sim.state.calls.length, 1);
});

test('missing credentials fail before reserving quota or calling the provider', async () => {
  const sim = simulation(() => reply(fixture), { COINGECKO_DEMO_API_KEY: '' });
  const failed = await json(await callRoute(sim));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'market_data_not_configured');
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal(sim.state.calls.length, 0);
  sim.env.COINGECKO_DEMO_API_KEY = 'synthetic-test-key';
  for (let i = 0; i < 24; i += 1) assert.equal((await callRoute(sim)).status, 200);
  assert.equal(sim.state.calls.length, 24, 'a missing key did not consume a provider reservation');
  assert.equal((await callRoute(sim)).status, 429);
});

test('upstream 429 and redirect failures never fall back to fabricated candles or leak bodies', async () => {
  let mode = '429';
  const sim = simulation(() => {
    if (mode === 'redirect') throw new TypeError('synthetic blocked redirect');
    return new Response(secretSentinel, { status: 429, headers: { 'retry-after': '7' } });
  });
  let result = await json(await callRoute(sim));
  assert.equal(result.status, 429);
  assert.equal(result.body.error.code, 'market_data_rate_limited');
  assert.equal(result.headers.get('retry-after'), '7');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secretSentinel));
  assert.equal(sim.state.calls.length, 1);
  mode = 'redirect';
  result = await json(await callRoute(sim));
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'market_data_unavailable');
  assert.equal(sim.state.calls.length, 2, 'no chart or sparkline fallback was requested');
  assert.ok(sim.state.calls.every((call) => call.options.redirect === 'error' && call.url.pathname.endsWith('/ohlc')));
});

test('candles, line history and quotes share one rolling 24-per-minute provider budget', async () => {
  const sim = simulation((url) => {
    if (url.pathname.endsWith('/ohlc')) return reply(fixture);
    if (url.pathname.endsWith('/market_chart')) return reply({ prices: [[T0, 1]], market_caps: [], total_volumes: [] });
    if (url.pathname.endsWith('/markets')) return reply([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 1, market_cap: 10, total_volume: 1, high_24h: 2, low_24h: 0.5 }]);
    throw new Error('Unexpected synthetic provider route');
  });
  for (let i = 0; i < 22; i += 1) await sim.provider.getMarketCandles('bitcoin', 7, 'USD');
  await sim.provider.getMarketChart('bitcoin', 30, 'USD');
  await sim.provider.getMarketQuotes('USD');
  assert.equal(sim.state.calls.length, 24);
  let denied = await json(await callRoute(sim));
  assert.equal(denied.status, 429);
  assert.equal(denied.body.error.code, 'market_data_rate_limited');
  assert.equal(denied.headers.get('retry-after'), '60');
  assert.equal(sim.state.calls.length, 24);
  sim.clock.now += 59_000;
  denied = await json(await callRoute(sim));
  assert.equal(denied.headers.get('retry-after'), '1');
  sim.clock.now += 1_000;
  assert.equal((await callRoute(sim)).status, 200);
  assert.equal(sim.state.calls.length, 25);
});

test('invalid asset, days, currency, unknown or repeated parameters are rejected before upstream', async () => {
  const sim = simulation(() => { throw new Error('invalid requests must not reach the provider'); });
  const cases = [
    ['', 'unsupported', 'unsupported_coin'], ['?days=2', 'bitcoin', 'unsupported_days'],
    ['?days=07', 'bitcoin', 'unsupported_days'], ['?currency=XYZ', 'bitcoin', 'unsupported_currency'],
    ['?currency=usd', 'bitcoin', 'unsupported_currency'], ['?interval=hourly', 'bitcoin', 'unsupported_parameters'],
    ['?days=1&days=7', 'bitcoin', 'unsupported_parameters'], ['?currency=GBP&currency=USD', 'bitcoin', 'unsupported_parameters'],
  ];
  for (const [query, coin, code] of cases) {
    const result = await json(await callRoute(sim, query, coin));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, code);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(sim.state.calls.length, 0);
});

test('GET and OPTIONS enforce origin/method/header rules and set cache and CORS headers', async () => {
  const sim = simulation(() => reply(fixture));
  const allowed = 'http://localhost:8081';
  const denied = 'https://not-allowed.invalid';
  let result = await json(await callRoute(sim, '?days=7&currency=GBP', 'bitcoin', { origin: allowed }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), allowed);
  assert.match(result.headers.get('vary'), /origin/i);
  assert.equal(result.headers.get('cache-control'), 'public, s-maxage=60, stale-while-revalidate=240');
  result = await json(await callRoute(sim, '', 'bitcoin', { origin: denied }));
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(sim.state.calls.length, 1);
  const options = (origin, method, headers = 'accept') => sim.route.OPTIONS(new Request('http://markets.local/api/market/candles/bitcoin', { method: 'OPTIONS', headers: { host: 'markets.local', origin, 'access-control-request-method': method, 'access-control-request-headers': headers } }));
  let preflight = options(allowed, 'GET');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowed);
  assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
  assert.match(preflight.headers.get('vary'), /access-control-request-method/i);
  for (const response of [options(denied, 'GET'), options(allowed, 'POST'), options(allowed, 'GET', 'x-unapproved')]) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(sim.state.calls.length, 1);
});
