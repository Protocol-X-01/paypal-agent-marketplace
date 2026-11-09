// Run from apps/mobile: node --test tests/market-display.test.cjs
// Uses the project's existing TypeScript compiler; no network or device is needed.
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
  const source = fs.readFileSync(absolute, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const localRequire = (name) => name.startsWith('.')
    ? loadSource(path.resolve(path.dirname(absolute), name))
    : require(name);
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports, localRequire, module, absolute, path.dirname(absolute),
  );
  return module.exports;
}

const source = (name) => path.join(__dirname, '..', 'src', 'lib', name);
const { filterDisplayCurrencies, formatCurrency } = loadSource(source('currency'));
const { chartPercentageChange, chronologicalChartPoints, describeMarketChart, fetchMarketChart, fetchMarketOverview, formatChartSampleTime, formatProviderUpdate, formatRetrievalComparison, formatTimestamp, formatUsd, isMarketChart, isMarketOverview, metricValueLabel, pointsForMetric, selectHeadlineMetric, shouldShowUsdPeg } = loadSource(source('market'));
const { estimatePortfolio } = loadSource(source('portfolio-value'));
const { buildChartPath } = loadSource(source('chart-path'));

function coin(id, price) {
  return {
    id, symbol: id === 'bitcoin' ? 'BTC' : 'ETH', name: id, rank: 1, price,
    marketCap: 100, volume24h: 10, change24hPct: -2, change7dPct: 1,
    high24h: 110, low24h: 90, sparkline7d: [90, 100], lastUpdated: null,
  };
}

const overview = {
  currency: 'GBP', provider: 'CoinGecko', retrievedAt: '2026-11-06T00:00:00Z',
  coins: [coin('bitcoin', 100), coin('ethereum', null)],
};

class FakeMarketRequest {
  static last = null;
  static count = 0;
  constructor() {
    FakeMarketRequest.last = this;
    FakeMarketRequest.count += 1;
    this.headers = {};
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.aborted = false;
  }
  open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader() {}
  getResponseHeader(name) { return this.headers[name.toLowerCase()] ?? null; }
  send() { this.sent = true; }
  abort() { this.aborted = true; this.onabort?.(); }
  headersReceived(headers) {
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.readyState = 2;
    this.onreadystatechange?.();
  }
  progress(loaded, text) { this.responseText = text; this.onprogress?.({ loaded }); }
  complete(status, text) { this.status = status; this.responseText = text; this.readyState = 4; this.onload?.(); }
}

async function withFakeMarketRequest(run) {
  const previous = global.XMLHttpRequest;
  FakeMarketRequest.count = 0;
  FakeMarketRequest.last = null;
  global.XMLHttpRequest = FakeMarketRequest;
  try { await run(); } finally { global.XMLHttpRequest = previous; }
}

test('currency search accepts codes and names and has an empty result', () => {
  assert.equal(filterDisplayCurrencies('').length, 27);
  assert.deepEqual(filterDisplayCurrencies('  usd  ').map((item) => item.code), ['USD']);
  assert.deepEqual(filterDisplayCurrencies('british').map((item) => item.code), ['GBP']);
  assert.deepEqual(filterDisplayCurrencies('iNr').map((item) => item.code), ['INR']);
  assert.equal(filterDisplayCurrencies('no-such-currency').length, 0);
});

test('headline prefers the overview and identifies chart fallback', () => {
  const point = { timestamp: 1, value: 99 };
  assert.deepEqual(selectHeadlineMetric(coin('bitcoin', 100), 'price', point), { value: 100, source: 'overview' });
  assert.deepEqual(selectHeadlineMetric(coin('ethereum', null), 'price', point), { value: 99, source: 'chart' });
  assert.deepEqual(selectHeadlineMetric(coin('bitcoin', 0), 'price', point), { value: 0, source: 'overview' });
  assert.deepEqual(selectHeadlineMetric(null, 'price'), { value: null, source: 'unavailable' });
});

test('chart points are ordered without mutation, keeping equal timestamps stable', () => {
  const prices = Object.freeze([
    Object.freeze({ timestamp: 300, value: 30 }),
    Object.freeze({ timestamp: 100, value: 10 }),
    Object.freeze({ timestamp: 200, value: 20 }),
    Object.freeze({ timestamp: 200, value: 21 }),
    Object.freeze({ timestamp: 100, value: 11 }),
  ]);
  const chart = { prices, marketCaps: [], volumes: [] };
  const ordered = chronologicalChartPoints(pointsForMetric(chart, 'price'));
  assert.notEqual(ordered, prices);
  assert.deepEqual(ordered.map(({ timestamp, value }) => [timestamp, value]), [[100, 10], [100, 11], [200, 20], [200, 21], [300, 30]]);
  assert.deepEqual(prices.map(({ timestamp }) => timestamp), [300, 100, 200, 200, 100]);
  assert.deepEqual(selectHeadlineMetric(null, 'price', ordered.at(-1)), { value: 30, source: 'chart' });
  assert.equal(chartPercentageChange(ordered), 200);
  assert.deepEqual(chronologicalChartPoints([]), []);
});

test('duplicate-only chart timestamps do not imply a period change', () => {
  const points = chronologicalChartPoints([{ timestamp: 100, value: 10 }, { timestamp: 100, value: 20 }]);
  assert.deepEqual(points.map(({ value }) => value), [10, 20]);
  assert.equal(chartPercentageChange(points), null);
  assert.equal(chartPercentageChange([{ timestamp: 1, value: 0 }, { timestamp: 2, value: 20 }]), null);
  assert.equal(chartPercentageChange([{ timestamp: 1, value: Number.MIN_VALUE }, { timestamp: 2, value: Number.MAX_VALUE }]), null);
});

test('retrieval times include year, seconds and UTC, keeping clock disagreements distinguishable', () => {
  const saved = '2099-11-06T10:00:00.123Z';
  const response = '2026-11-06T11:00:00.000+01:00';
  assert.equal(formatTimestamp(saved), '2099-11-06 10:00:00.123 UTC');
  assert.equal(formatTimestamp(response), '2026-11-06 10:00:00.000 UTC');
  assert.equal(formatTimestamp(null), 'Time unavailable');
  assert.equal(formatTimestamp('invalid'), 'Time unavailable');
  assert.equal(formatTimestamp(Number.NaN), 'Time unavailable');
  assert.equal(formatRetrievalComparison(saved, response),
    'Displayed view retrieved 2099-11-06 10:00:00.123 UTC\nResponse retrieved 2026-11-06 10:00:00.000 UTC');
  assert.equal(formatRetrievalComparison(null, response),
    'Displayed view retrieved Time unavailable\nResponse retrieved 2026-11-06 10:00:00.000 UTC');
  assert.equal(formatRetrievalComparison(saved, null), null);
});

test('chart fallback identifies sample time separately and labels estimates', () => {
  const sample = { timestamp: Date.parse('2020-01-01T12:34:56Z'), value: 99 };
  assert.deepEqual(selectHeadlineMetric(null, 'price', sample), { value: 99, source: 'chart' });
  assert.equal(formatChartSampleTime(sample, 'market_chart'), 'Chart sample time 2020-01-01 12:34:56.000 UTC');
  assert.equal(formatChartSampleTime(sample, 'market_overview_sparkline'), 'Estimated sample time 2020-01-01 12:34:56.000 UTC');
  assert.equal(formatChartSampleTime(undefined, 'market_chart'), 'Chart sample time Time unavailable');
  assert.notEqual(formatTimestamp(sample.timestamp), formatTimestamp('2026-11-06T10:00:00Z'));
});

test('provider update time is shown only for an unambiguous valid UTC value', () => {
  assert.equal(formatProviderUpdate('2026-11-06T10:00:00.123456Z'), '2026-11-06 10:00:00.123 UTC');
  for (const value of [null, undefined, '', '0', '2026-11-06', '2026-02-30T00:00:00Z', '2026-11-06T10:00:00+01:00']) {
    assert.equal(formatProviderUpdate(value), 'Time unavailable');
  }
});

test('Markets notice shows both conflicting retrieval times and explains their limit', () => {
  const screen = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'index.tsx'), 'utf8');
  const tree = ts.createSourceFile('index.tsx', screen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let notice;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'DataNotice') notice = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(notice);
  const code = ts.transpileModule(`${notice}\nexports.DataNotice = DataNotice;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const requireJsx = (name) => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : require(name);
  const cjsModule = { exports: {} };
  new Function('exports', 'require', 'module', 'View', 'Text', 'NativeButton', 'styles', 'formatTimestamp', 'formatRetrievalComparison', code)(
    cjsModule.exports, requireJsx, cjsModule, 'View', 'Text', 'NativeButton', {}, formatTimestamp, formatRetrievalComparison,
  );
  const content = (node) => {
    if (Array.isArray(node)) return node.map(content).join(' ');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    return typeof node === 'object' ? content(node.props?.children) : String(node);
  };
  const rendered = cjsModule.exports.DataNotice({
    stale: true, loading: false, error: 'Retrieval times differ.',
    retrievedAt: '2099-11-06T10:00:00Z', alternativeRetrievedAt: '2026-11-06T10:00:00Z',
    onRetry() {}, onShowLatest() {},
  });
  const text = content(rendered);
  assert.match(text, /Displayed view retrieved 2099-11-06 10:00:00\.000 UTC/);
  assert.match(text, /Response retrieved 2026-11-06 10:00:00\.000 UTC/);
  assert.match(text, /Retrieval time alone does not confirm price freshness/);
});

test('market snapshots reject invalid retrieval timestamps', () => {
  assert.equal(isMarketOverview(overview), true);
  const chart = { coinId: 'bitcoin', currency: 'GBP', provider: 'CoinGecko', retrievedAt: '2026-11-06T00:00:00Z', days: 7, seriesSource: 'market_chart', availableMetrics: ['price'], prices: [], marketCaps: [], volumes: [] };
  assert.equal(isMarketChart(chart), true);
  for (const timestamp of ['unknown', '2026-02-30T00:00:00Z', '2026-11-06', '2026-11-06T00:00:00+01:00']) {
    assert.equal(isMarketOverview({ ...overview, retrievedAt: timestamp }), false);
    assert.equal(isMarketChart({ ...chart, retrievedAt: timestamp }), false);
  }
});

test('market snapshot validators cap strings and series lengths before iteration', () => {
  const normalCoin = overview.coins[0];
  assert.equal(isMarketOverview({ ...overview, coins: [{ ...normalCoin, sparkline7d: Array(512).fill(1) }] }), true);
  assert.equal(isMarketOverview({ ...overview, coins: [{ ...normalCoin, sparkline7d: Array(513).fill(1) }] }), false);
  assert.equal(isMarketOverview({ ...overview, coins: [{ ...normalCoin, name: 'n'.repeat(129) }] }), false);
  assert.equal(isMarketOverview({ ...overview, coins: [{ ...normalCoin, symbol: 's'.repeat(33) }] }), false);
  assert.equal(isMarketOverview({ ...overview, coins: [{ ...normalCoin, lastUpdated: 't'.repeat(65) }] }), false);

  const chart = { coinId: 'bitcoin', currency: 'GBP', provider: 'CoinGecko', retrievedAt: '2026-11-06T00:00:00Z', days: 7, seriesSource: 'market_chart', availableMetrics: ['price'], prices: [], marketCaps: [], volumes: [] };
  const point = { timestamp: 1, value: 1 };
  assert.equal(isMarketChart({ ...chart, prices: Array(2400).fill(point) }), true);
  assert.equal(isMarketChart({ ...chart, prices: Array(2401).fill(point) }), false);
  assert.equal(isMarketChart({ ...chart, marketCaps: Array(2401).fill(point) }), false);
  assert.equal(isMarketChart({ ...chart, volumes: Array(2401).fill(point) }), false);
  assert.equal(isMarketChart({ ...chart, availableMetrics: ['price', 'price'] }), false);
});

test('a missing quotes route reports an incompatible service without parsing HTML or falling back', async () => withFakeMarketRequest(async () => {
    const request = fetchMarketOverview('GBP');
    assert.match(FakeMarketRequest.last.url, /\/api\/market\/quotes\?currency=GBP$/);
    FakeMarketRequest.last.complete(404, '<html>not found</html>');
    await assert.rejects(request, /market service needs an update before display-currency prices can load/);
    assert.equal(FakeMarketRequest.count, 1);
}));

test('market response failures keep their own messages', async () => withFakeMarketRequest(async () => {
  const busy = fetchMarketOverview('USD');
  FakeMarketRequest.last.complete(429, '{}');
  await assert.rejects(busy, /busy right now/);
  const unavailable = fetchMarketOverview('USD');
  FakeMarketRequest.last.complete(503, '{}');
  await assert.rejects(unavailable, /temporarily unavailable/);
  const missingChart = fetchMarketChart('bitcoin', 7, 'USD');
  FakeMarketRequest.last.complete(404, '<html>not found</html>');
  await assert.rejects(missingChart, /could not load this view/);
  const invalidJson = fetchMarketOverview('USD');
  FakeMarketRequest.last.complete(200, '{');
  await assert.rejects(invalidJson, /unexpected response/);
}));

test('market JSON response bodies are bounded during transfer and remain cancelable', async () => withFakeMarketRequest(async () => {
  const limit = 1024 * 1024;
  const declared = fetchMarketOverview('USD');
  const first = FakeMarketRequest.last;
  first.headersReceived({ 'Content-Length': String(limit + 1) });
  await assert.rejects(declared, /response that was too large/);
  assert.equal(first.aborted, true);

  const streamed = fetchMarketOverview('USD');
  const second = FakeMarketRequest.last;
  second.progress(limit + 1, 'x');
  await assert.rejects(streamed, /response that was too large/);
  assert.equal(second.aborted, true);

  const decoded = fetchMarketOverview('USD');
  const third = FakeMarketRequest.last;
  third.progress(1, '€'.repeat(Math.floor(limit / 3) + 1));
  await assert.rejects(decoded, /response that was too large/);
  assert.equal(third.aborted, true);

  const exactPayload = JSON.stringify(overview);
  const atLimit = fetchMarketOverview('GBP');
  FakeMarketRequest.last.complete(200, exactPayload + ' '.repeat(limit - exactPayload.length));
  assert.deepEqual(await atLimit, overview);

  const controller = new AbortController();
  const pending = fetchMarketOverview('USD', controller.signal);
  const request = FakeMarketRequest.last;
  controller.abort();
  await assert.rejects(pending, /canceled/);
  assert.equal(request.aborted, true);
}));

test('incomplete holdings are identified and cached quotes reject invalid values', () => {
  assert.equal(isMarketOverview(overview), true);
  assert.equal(isMarketOverview({ ...overview, coins: [] }), false);
  assert.equal(isMarketOverview({ ...overview, coins: [coin('bitcoin', 100), coin('bitcoin', 200)] }), false);
  assert.equal(isMarketOverview({ ...overview, coins: [coin('bitcoin', 100)] }), true, 'a unique partial watchlist remains usable');
  for (const field of ['price', 'marketCap', 'volume24h', 'high24h', 'low24h']) {
    assert.equal(isMarketOverview({ ...overview, coins: [{ ...overview.coins[0], [field]: -1 }] }), false, field);
  }
  assert.deepEqual(estimatePortfolio({ bitcoin: '2', ethereum: '3' }, overview, true), { state: 'prices-unavailable', estimatedValue: null, enteredAssetCount: 2, missingPriceCount: 1 });
  assert.deepEqual(estimatePortfolio({ bitcoin: '2', ethereum: '0' }, overview, true), { state: 'ready', estimatedValue: 200, enteredAssetCount: 1, missingPriceCount: 0 });
  assert.deepEqual(estimatePortfolio({ bitcoin: '2' }, null, true), { state: 'prices-unavailable', estimatedValue: null, enteredAssetCount: 1, missingPriceCount: 1 });
  assert.deepEqual(estimatePortfolio({}, overview, true), { state: 'empty', estimatedValue: null, enteredAssetCount: 0, missingPriceCount: 0 });
  assert.deepEqual(estimatePortfolio({ bitcoin: '2' }, overview, false), { state: 'holdings-unavailable', estimatedValue: null, enteredAssetCount: null, missingPriceCount: 0 });
  assert.deepEqual(estimatePortfolio({}, overview, false), { state: 'holdings-unavailable', estimatedValue: null, enteredAssetCount: null, missingPriceCount: 0 });
});

test('a real zero quote can be valued, but an overflowing estimate is withheld', () => {
  assert.deepEqual(estimatePortfolio({ bitcoin: '3' }, { ...overview, coins: [coin('bitcoin', 0)] }, true), {
    state: 'ready', estimatedValue: 0, enteredAssetCount: 1, missingPriceCount: 0,
  });
  assert.deepEqual(estimatePortfolio({ bitcoin: '3' }, { ...overview, coins: [coin('bitcoin', 1e308)] }, true), {
    state: 'calculation-unavailable', estimatedValue: null, enteredAssetCount: 1, missingPriceCount: 0,
  });
  assert.deepEqual(estimatePortfolio({ bitcoin: '0.0000000001' }, { ...overview, coins: [coin('bitcoin', Number.MIN_VALUE)] }, true), {
    state: 'calculation-unavailable', estimatedValue: null, enteredAssetCount: 1, missingPriceCount: 0,
  });
});

test('PYUSD precision does not change ordinary USD amount formatting', () => {
  assert.equal(formatCurrency(1.0001, 'USD', false, 4), '$1.0001');
  assert.equal(metricValueLabel('price', 1.0001, 'USD', true), '$1.0001');
  assert.equal(formatUsd(1.0001), '$1.00');
});

test('chart positions use timestamps and sampled paths retain the true extrema', () => {
  const irregular = buildChartPath([{ timestamp: 10, value: 3 }, { timestamp: 0, value: 1 }, { timestamp: 1, value: 2 }]);
  assert.equal(irregular.line, 'M 16.0 210.0 L 76.8 114.0 L 624.0 18.0');
  const points = Array.from({ length: 1000 }, (_, index) => ({
    timestamp: index, value: index === 413 ? 0 : index === 587 ? 20 : 10,
  }));
  const chart = buildChartPath(points);
  assert.equal(chart.low, 0);
  assert.equal(chart.high, 20);
  assert.ok(chart.line.includes(`L ${(16 + 413 / 999 * 608).toFixed(1)} 210.0`));
  assert.ok(chart.line.includes(`L ${(16 + 587 / 999 * 608).toFixed(1)} 18.0`));
  assert.ok((chart.line.match(/[ML] /g) || []).length <= 120);
});

test('the USD PYUSD price guide keeps actual extrema and is described accessibly', () => {
  assert.equal(shouldShowUsdPeg(true, 'price', 'USD'), true);
  assert.equal(shouldShowUsdPeg(true, 'price', 'GBP'), false);
  assert.equal(shouldShowUsdPeg(true, 'marketCap', 'USD'), false);
  assert.equal(shouldShowUsdPeg(false, 'price', 'USD'), false);

  const chart = buildChartPath(
    [{ timestamp: 0, value: 0.9999 }, { timestamp: 10, value: 1.0001 }],
    { value: 1, minDomain: 0.98, maxDomain: 1.02 },
  );
  assert.equal(chart.low, 0.9999);
  assert.equal(chart.high, 1.0001);
  assert.ok(Math.abs(chart.referenceY - 114) < 0.000001);
  assert.equal(chart.line, 'M 16.0 114.5 L 624.0 113.5');
  const description = describeMarketChart('price', chart.low, chart.high, 'USD', true, 0.02);
  assert.match(description, /\$0\.9999.*\$1\.0001/);
  assert.match(description, /dashed line marks the \$1\.00 USD peg/);
  assert.doesNotMatch(describeMarketChart('price', chart.low, chart.high, 'GBP', true, 0.02), /peg/);
  assert.doesNotMatch(describeMarketChart('marketCap', 1, 2, 'USD', true, 0.02), /peg/);
});
