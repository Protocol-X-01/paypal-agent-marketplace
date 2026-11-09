// Synthetic hook races; no device, storage or provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const slots = [];
  const pending = [];
  const calls = [];
  const intradayCalls = [];
  let cursor = 0;
  const react = {
    createContext: () => ({}),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; });
      }
    },
    useCallback: (callback) => callback,
  };
  const market = {
    ASSETS: [],
    fetchMarketCandles(coinId, days, currency, signal) {
      const item = { coinId, days, currency, signal, ...deferred() };
      calls.push(item);
      return item.promise;
    },
    fetchIntradayCandles(coinId, interval, days, signal) {
      const item = { coinId, interval, days, signal, ...deferred() };
      intradayCalls.push(item);
      return item.promise;
    },
  };
  const dependencies = {
    react, 'react/jsx-runtime': { jsx() {}, jsxs() {} },
    'react-native': { Platform: { OS: 'android' } },
    '@react-native-async-storage/async-storage': {}, 'expo-secure-store': {},
    './currency': { DEFAULT_DISPLAY_CURRENCY: 'USD' }, './market': market,
    './holding-input': {}, './portfolio-persistence': {},
    './customer-storage-scope': { createCustomerStorageFence: () => ({}) },
    './market-resource': { createLatestCacheWriter: () => () => {} },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/data-context.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected candle-hook dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return {
    calls, intradayCalls,
    render(coin = 'bitcoin', days = 7, currency = 'USD', enabled = true) {
      cursor = 0;
      const result = loaded.exports.useMarketCandles(coin, days, currency, enabled);
      while (pending.length) pending.shift()();
      return result;
    },
    renderIntraday(coin = 'bitcoin', interval = '3m', days = 1, enabled = true) {
      cursor = 0;
      const result = loaded.exports.useIntradayCandles(coin, interval, days, enabled);
      while (pending.length) pending.shift()();
      return result;
    },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('indicator history is on demand and old asset/currency responses cannot replace a new view', async () => {
  const app = harness();
  assert.equal(app.render('bitcoin', 7, 'USD', false).loading, false);
  assert.equal(app.calls.length, 0);
  assert.equal(app.render().loading, true);
  assert.equal(app.calls.length, 1);
  let current = app.render('ethereum', 7, 'GBP', true);
  assert.equal(current.data, null);
  assert.equal(current.loading, true);
  assert.equal(app.calls[0].signal.aborted, true);
  assert.equal(app.calls.length, 2);
  app.calls[0].resolve({ coinId: 'bitcoin', currency: 'USD', candles: ['old'] });
  app.calls[1].resolve({ coinId: 'ethereum', currency: 'GBP', candles: ['new'] });
  await flush();
  current = app.render('ethereum', 7, 'GBP', true);
  assert.equal(current.loading, false);
  assert.deepEqual(current.data, { coinId: 'ethereum', currency: 'GBP', candles: ['new'] });
  app.close();
});

test('intraday source, interval, window and asset fence late responses and retries', async () => {
  const app = harness();
  assert.equal(app.renderIntraday('bitcoin', null, 1, false).loading, false);
  assert.equal(app.intradayCalls.length, 0);
  assert.equal(app.renderIntraday().loading, true);
  let current = app.renderIntraday('bitcoin', '15m', 7);
  assert.equal(current.data, null);
  assert.equal(app.intradayCalls[0].signal.aborted, true);
  app.intradayCalls[0].resolve({ coinId: 'bitcoin', interval: '3m', candles: ['old'] });
  app.intradayCalls[1].resolve({ coinId: 'bitcoin', interval: '15m', days: 7, candles: ['new'] });
  await flush();
  current = app.renderIntraday('bitcoin', '15m', 7);
  assert.deepEqual(current.data.candles, ['new']);
  assert.match(current.requestKey, /^binance:USDT:bitcoin:15m:7:/);
  current = app.renderIntraday('ethereum', '15m', 7);
  assert.equal(current.data, null);
  assert.equal(app.intradayCalls[1].signal.aborted, true);
  app.intradayCalls[2].resolve({ coinId: 'ethereum', interval: '15m', days: 7, candles: ['eth'] });
  await flush();
  current = app.renderIntraday('ethereum', '15m', 7);
  current.retry();
  current = app.renderIntraday('ethereum', '15m', 7);
  assert.equal(current.data, null);
  assert.equal(current.loading, true);
  app.close();
});

test('retry hides the previous data until the new matching response settles', async () => {
  const app = harness();
  let current = app.render();
  app.calls[0].resolve({ coinId: 'bitcoin', currency: 'USD', candles: ['first'] });
  await flush();
  current = app.render();
  assert.deepEqual(current.data.candles, ['first']);
  current.retry();
  current = app.render();
  assert.equal(current.data, null);
  assert.equal(current.loading, true);
  assert.equal(app.calls[0].signal.aborted, true);
  app.calls[1].reject(new Error('offline'));
  await flush();
  current = app.render();
  assert.equal(current.data, null);
  assert.equal(current.error, 'offline');
  app.close();
});
