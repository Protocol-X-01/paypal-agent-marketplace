// Run from apps/mobile with node --test. All data and storage are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/market-resource.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { loadMarketResource, chooseNewestMarketData, isOlderMarketData, reconcileCachedMarketData, reconcileMarketResponse, selectNetworkAlternative, marketDataToPersist, writeMarketCacheIfNotOlder, createLatestCacheWriter, loadPreferenceWithTimeout } = loaded.exports;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('fresh data loads while cache is stuck and a late cache is delivered for comparison', async () => {
  const cache = deferred();
  const live = deferred();
  const events = [];
  let requests = 0;
  loadMarketResource({
    readCache: () => cache.promise,
    fetchFresh: () => { requests += 1; return live.promise; },
    onCache: (...args) => events.push(['cache', ...args]),
    onFresh: (value) => events.push(['fresh', value]),
    onError: (error) => events.push(['error', error]),
  });
  await flush();
  assert.equal(requests, 1);
  live.resolve('new');
  await flush();
  cache.resolve('old');
  await flush();
  assert.deepEqual(events, [['fresh', 'new'], ['cache', 'old', false, null, 'new']]);
});

test('a late cache read can still supply clearly stale data after a network failure', async () => {
  const cache = deferred();
  const live = deferred();
  const error = new Error('offline');
  const events = [];
  loadMarketResource({
    readCache: () => cache.promise,
    fetchFresh: () => live.promise,
    onCache: (...args) => events.push(['cache', ...args]),
    onFresh: (value) => events.push(['fresh', value]),
    onError: (value) => events.push(['error', value]),
  });
  live.reject(error);
  await flush();
  cache.resolve('saved');
  await flush();
  assert.deepEqual(events, [['error', error], ['cache', 'saved', false, error, null]]);
});

test('a previous on-screen value is not replaced with an older cached snapshot', () => {
  const current = { retrievedAt: '2026-11-06T10:00:00Z' };
  const older = { retrievedAt: '2026-11-05T10:00:00Z' };
  const newer = { retrievedAt: '2026-11-07T10:00:00Z' };
  assert.equal(chooseNewestMarketData(current, older), current);
  assert.equal(chooseNewestMarketData(current, newer), newer);
  assert.equal(chooseNewestMarketData(current, { retrievedAt: 'invalid' }), current);
  assert.equal(chooseNewestMarketData(null, older), older);
});

test('a response with an older retrieval time is not treated as newer market data', () => {
  const current = { retrievedAt: '2026-11-06T10:00:00Z' };
  const older = { retrievedAt: '2026-11-06T09:59:59Z' };
  const newer = { retrievedAt: '2026-11-06T10:00:01Z' };
  assert.equal(isOlderMarketData(current, older), true);
  assert.equal(isOlderMarketData(current, { retrievedAt: '2026-11-06T10:00:00Z' }), false);
  assert.equal(isOlderMarketData(current, newer), false);
  assert.equal(isOlderMarketData(null, { retrievedAt: '2026-11-06T09:59:59Z' }), false);
  const held = reconcileMarketResponse(current, older, 'older response', true);
  assert.deepEqual(held, { data: current, loading: false, stale: true, error: 'older response', cacheReady: true, networkAlternative: older, networkSelected: false });
  assert.equal(marketDataToPersist(held), null);
  const refreshed = reconcileMarketResponse(current, newer, 'older response', true);
  assert.deepEqual(refreshed, { data: newer, loading: false, stale: false, error: null, cacheReady: true, networkAlternative: null, networkSelected: false });
  assert.equal(marketDataToPersist(refreshed), newer);
});

function resourceHarness(cache, network, initial) {
  let state = initial ?? { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null };
  const cancel = loadMarketResource({
    readCache: () => cache.promise,
    fetchFresh: () => network.promise,
    onCache: (saved, loading, error, fresh) => {
      state = reconcileCachedMarketData(state, saved, loading, error, fresh, 'Saved timestamp is newer; clocks may differ.', 'Unavailable');
    },
    onFresh: (fresh) => {
      state = reconcileMarketResponse(state.data, fresh, 'Saved timestamp is newer; clocks may differ.', state.cacheReady);
    },
    onError: (error) => { state = { ...state, loading: false, stale: Boolean(state.data), error: error.message, networkAlternative: null }; },
  });
  return { cancel, current: () => state, selectLatest: () => { state = selectNetworkAlternative(state); } };
}

for (const kind of ['overview', 'chart']) {
  test(`${kind}: a cache-first newer snapshot survives an older response`, async () => {
    const cache = deferred();
    const network = deferred();
    const view = resourceHarness(cache, network);
    const saved = { retrievedAt: '2026-11-06T10:00:00Z', kind, currency: 'GBP' };
    const response = { retrievedAt: '2026-11-06T09:00:00Z', kind, currency: 'GBP' };
    cache.resolve(saved);
    await flush();
    assert.equal(view.current().data, saved);
    assert.equal(view.current().stale, true);
    network.resolve(response);
    await flush();
    assert.equal(view.current().data, saved);
    assert.equal(view.current().networkAlternative, response);
    assert.equal(marketDataToPersist(view.current()), null);
    view.selectLatest();
    assert.equal(view.current().data, response);
    assert.equal(marketDataToPersist(view.current()), null);
  });

  test(`${kind}: a later cache read protects a newer snapshot and offers the latest response`, async () => {
    const cache = deferred();
    const network = deferred();
    const view = resourceHarness(cache, network);
    const response = { retrievedAt: '2026-11-06T09:00:00Z', kind, currency: 'GBP' };
    const saved = { retrievedAt: '2099-11-06T10:00:00Z', kind, currency: 'GBP' };
    network.resolve(response);
    await flush();
    assert.equal(view.current().data, response, 'network data is visible immediately');
    assert.equal(view.current().stale, false);
    assert.equal(marketDataToPersist(view.current()), null, 'do not write while the cache read is pending');
    cache.resolve(saved);
    await flush();
    assert.equal(view.current().data, saved);
    assert.equal(view.current().stale, true);
    assert.match(view.current().error, /clocks may differ/);
    assert.equal(view.current().networkAlternative, response);
    assert.equal(marketDataToPersist(view.current()), null);
    view.selectLatest();
    assert.equal(view.current().data, response, 'the customer is not trapped by a future timestamp');
    assert.equal(view.current().stale, true);
    assert.match(view.current().error, /saved cache was not replaced/i);
    assert.equal(marketDataToPersist(view.current()), null);
  });

  test(`${kind}: an older late cache does not replace the response and permits a guarded save`, async () => {
    const cache = deferred();
    const network = deferred();
    const view = resourceHarness(cache, network);
    const response = { retrievedAt: '2026-11-06T10:00:00Z', kind, currency: 'USD' };
    const saved = { retrievedAt: '2026-11-06T09:00:00Z', kind, currency: 'USD' };
    network.resolve(response);
    await flush();
    assert.equal(marketDataToPersist(view.current()), null);
    cache.resolve(saved);
    await flush();
    assert.equal(view.current().data, response);
    assert.equal(view.current().stale, false);
    assert.equal(marketDataToPersist(view.current()), response);
  });

  test(`${kind}: a late cache cannot undo an explicit network-response choice`, async () => {
    const cache = deferred();
    const network = deferred();
    const previous = { retrievedAt: '2099-11-06T10:00:00Z', kind };
    const response = { retrievedAt: '2026-11-06T09:00:00Z', kind };
    const view = resourceHarness(cache, network, { data: previous, loading: true, stale: true, error: null, cacheReady: false, networkAlternative: null });
    network.resolve(response);
    await flush();
    assert.equal(view.current().networkAlternative, response);
    view.selectLatest();
    cache.resolve(previous);
    await flush();
    assert.equal(view.current().data, response);
    assert.equal(view.current().stale, true);
    assert.equal(view.current().cacheReady, true);
    assert.equal(marketDataToPersist(view.current()), null);
  });
}

test('a permanently stalled or failed cache read never blocks the network view or permits an unchecked write', async () => {
  for (const fail of [false, true]) {
    const cache = deferred();
    const network = deferred();
    const view = resourceHarness(cache, network);
    const response = { retrievedAt: '2026-11-06T10:00:00Z' };
    network.resolve(response);
    if (fail) cache.reject(new Error('storage unavailable'));
    await flush();
    assert.equal(view.current().data, response);
    assert.equal(view.current().loading, false);
    assert.equal(marketDataToPersist(view.current()), null);
    view.cancel();
  }
});

test('cache writes recheck timestamps and retain newer stored data', async () => {
  const current = { retrievedAt: '2026-11-06T10:00:00Z' };
  const older = { retrievedAt: '2026-11-06T09:00:00Z' };
  const newer = { retrievedAt: '2026-11-06T11:00:00Z' };
  let saved = current;
  let writes = 0;
  const persist = (value) => writeMarketCacheIfNotOlder(value, async () => saved, async () => { saved = value; writes += 1; });
  assert.equal(await persist(older), false);
  assert.equal(saved, current);
  assert.equal(writes, 0);
  assert.equal(await persist(newer), true);
  assert.equal(saved, newer);
  assert.equal(writes, 1);
  await assert.rejects(writeMarketCacheIfNotOlder(older, async () => { throw new Error('unavailable'); }, async () => { writes += 1; }));
  assert.equal(writes, 1, 'a failed comparison must not overwrite an unknown cache');
});

test('switching currency cancels both late cache and response for the old view', async () => {
  const usdCache = deferred();
  const usdNetwork = deferred();
  const usd = resourceHarness(usdCache, usdNetwork);
  usd.cancel();
  const gbpCache = deferred();
  const gbpNetwork = deferred();
  const gbp = resourceHarness(gbpCache, gbpNetwork);
  const newResponse = { retrievedAt: '2026-11-06T10:00:00Z', currency: 'GBP' };
  gbpNetwork.resolve(newResponse);
  gbpCache.resolve(null);
  usdNetwork.resolve({ retrievedAt: '2026-11-06T11:00:00Z', currency: 'USD' });
  usdCache.resolve({ retrievedAt: '2026-11-06T12:00:00Z', currency: 'USD' });
  await flush();
  assert.equal(usd.current().data, null);
  assert.equal(gbp.current().data, newResponse);
  assert.equal(marketDataToPersist(gbp.current()), newResponse);
});

test('canceled loads ignore late results from transports that do not stop', async () => {
  const cache = deferred();
  const live = deferred();
  const events = [];
  const cancel = loadMarketResource({
    readCache: () => cache.promise,
    fetchFresh: () => live.promise,
    onCache: () => events.push('cache'),
    onFresh: () => events.push('fresh'),
    onError: () => events.push('error'),
  });
  await flush();
  cancel();
  cache.resolve('old');
  live.resolve('new');
  await flush();
  assert.deepEqual(events, []);
});

test('cache writes stay ordered per key and coalesce to the most recent value', async () => {
  const first = deferred();
  const writes = [];
  const save = createLatestCacheWriter(async (key, value) => {
    writes.push([key, value]);
    if (value === 'first') await first.promise;
  });
  save('GBP', 'first');
  save('GBP', 'intermediate');
  save('GBP', 'latest');
  save('USD', 'independent');
  assert.deepEqual(writes, [['GBP', 'first'], ['USD', 'independent']]);
  first.resolve();
  await flush();
  assert.deepEqual(writes, [['GBP', 'first'], ['USD', 'independent'], ['GBP', 'latest']]);
});

test('a slow currency preference falls back once and a late read cannot change it', async () => {
  const preference = deferred();
  const events = [];
  loadPreferenceWithTimeout(() => preference.promise, (value) => events.push(value), () => events.push('unavailable'), 10);
  await sleep(30);
  preference.resolve('GBP');
  await flush();
  assert.deepEqual(events, ['unavailable']);

  const pending = deferred();
  const cancel = loadPreferenceWithTimeout(() => pending.promise, () => events.push('value'), () => events.push('timeout'), 10);
  cancel();
  pending.resolve('USD');
  await sleep(20);
  assert.deepEqual(events, ['unavailable']);
});
