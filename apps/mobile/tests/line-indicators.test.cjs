// Synthetic line/indicator alignment and rendering checks; no device or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected line indicator dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const series = load('src/lib/candle-series.ts');
const geometry = load('src/lib/chart-path.ts');
const indicator = load('src/lib/line-indicators.ts', { './candle-series': series });
const currency = load('src/lib/currency.ts');
const market = load('src/lib/market.ts', { './currency': currency });
const description = load('src/lib/chart-description.ts', { './market': market });
const responsive = load('src/lib/responsive-layout.ts', { 'react-native': {}, 'react-native-safe-area-context': {} });
const element = (type, props, key) => typeof type === 'function' && type.name === 'ViewIndicator' ? type(props) : { type, props: props ?? {}, key };
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const native = { PanResponder: { create: (handlers) => ({ panHandlers: { testPan: handlers } }) }, Platform: { OS: 'android' }, Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } };
const svg = { __esModule: true, default: 'Svg', Circle: 'Circle', Defs: 'Defs', LinearGradient: 'LinearGradient', Line: 'Line', Path: 'Path', Stop: 'Stop' };
const { MarketChart } = load('src/components/market-chart.tsx', {
  react: { useState: (initial) => [initial, () => {}], useMemo: (fn) => fn(), useCallback: (fn) => fn }, 'react/jsx-runtime': jsx, 'react-native': native, 'react-native-svg': svg,
  '@/lib/chart-path': geometry, '@/lib/chart-description': description, '@/lib/currency': currency,
  '@/lib/line-indicators': indicator, '@/lib/market': market, '@/lib/responsive-layout': responsive,
});

const INTERVAL = 240 * 60_000;
const candles = Array.from({ length: 30 }, (_, i) => ({ timestamp: 1_000 + i * INTERVAL, open: i + 1, high: i + 2, low: i, close: i + 1 }));
const active = { sma: true, ema: true, rsi: true };
const fixture = { coinId: 'bitcoin', currency: 'USD', days: 7, source: 'CoinGecko', retrievedAt: '2026-11-06T10:00:00Z', timestampKind: 'close', candleIntervalMinutes: 240, candles };

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}

test('indicators use full-history warm-up and clip by actual close timestamps, not array index', () => {
  const from = candles[23].timestamp - INTERVAL / 2;
  const to = candles[26].timestamp + INTERVAL / 2;
  const result = indicator.buildVisibleLineIndicators(candles, from, to, 240, active);
  assert.equal(result.visibleCandles, 4);
  assert.deepEqual(result.segments.sma[0].map((point) => point.value), [14.5, 15.5, 16.5, 17.5]);
  assert.deepEqual(result.segments.ema[0].map((point) => point.value), [14.5, 15.5, 16.5, 17.5]);
  assert.deepEqual(result.segments.rsi[0].map((point) => point.value), [100, 100, 100, 100]);
  const projected = indicator.projectIndicatorSegments(result.segments.sma, (timestamp) => (timestamp - from) / INTERVAL, (value) => value);
  assert.match(projected.path, /^M 0\.50 14\.50 L 1\.50 15\.50/);
  assert.match(projected.path, /L 3\.50 17\.50$/);
});

test('missing intervals split paths while preserving calculation values and singleton markers', () => {
  const gapped = candles.map((candle, index) => index >= 25 ? { ...candle, timestamp: candle.timestamp + 2 * INTERVAL } : candle);
  const result = indicator.buildVisibleLineIndicators(gapped, gapped[23].timestamp, gapped[27].timestamp, 240, active);
  assert.deepEqual(result.segments.sma.map((segment) => segment.map((point) => point.value)), [[14.5, 15.5], [16.5, 17.5, 18.5]]);
  for (const name of ['sma', 'ema', 'rsi']) assert.equal(result.segments[name].length, 2);
  const single = indicator.projectIndicatorSegments([[{ timestamp: 20, value: 3 }]], (timestamp) => timestamp / 2, (value) => value * 2);
  assert.equal(single.path, 'M 10.00 6.00');
  assert.deepEqual(single.singletons, [{ x: 10, y: 6 }]);
});

test('no-overlap, zero-duration and inactive choices do not invent values', () => {
  const none = indicator.buildVisibleLineIndicators(candles, candles[29].timestamp + 1, candles[29].timestamp + 1000, 240, active);
  assert.equal(none.visibleCandles, 0);
  assert.deepEqual(none.segments, { sma: [], ema: [], rsi: [] });
  assert.equal(indicator.buildVisibleLineIndicators(candles, 1, 1, 240, active).visibleCandles, 0);
  const off = indicator.buildVisibleLineIndicators(candles, candles[0].timestamp, candles[29].timestamp, 240, { sma: false, ema: false, rsi: false });
  assert.deepEqual(off.segments, { sma: [], ema: [], rsi: [] });
});

test('only enabled visible averages widen the price domain; line-only geometry stays unchanged', () => {
  const points = [{ timestamp: 1, value: 20 }, { timestamp: 2, value: 25 }];
  assert.deepEqual(geometry.buildChartPath(points), geometry.buildChartPath(points, undefined, []));
  const extended = geometry.buildChartPath(points, undefined, [14.5, 17.5, NaN]);
  assert.equal(extended.low, 20);
  assert.equal(extended.high, 25);
  assert.equal(extended.domainLow, 14.5);
  assert.equal(extended.domainHigh, 25);
});

test('line renders timestamp-aligned averages and a separate RSI with OHLC provenance', () => {
  const points = [{ timestamp: candles[23].timestamp - INTERVAL / 2, value: 20 }, { timestamp: candles[26].timestamp + INTERVAL / 2, value: 25 }];
  const tree = MarketChart({ points, metric: 'price', color: '#123456', currency: 'USD', indicators: active, indicatorHistory: fixture, seriesSource: 'market_chart', selectionScope: 'fixture' });
  const paths = nodes(tree).filter((node) => node.type === 'Path');
  assert.ok(paths.some((node) => node.props.stroke === '#FFD166' && node.props.d.startsWith('M 92.00')));
  assert.ok(paths.some((node) => node.props.stroke === '#C4B5FD'));
  assert.ok(paths.some((node) => node.props.stroke === '#7650C8'));
  assert.match(text(tree), /CoinGecko OHLC.*4-hour candle closes/);
  assert.match(text(tree), /SMA 20.*\$17\.50/);
  assert.match(text(tree), /RSI 14.*100\.00/);
  assert.match(text(tree), /RSI 14.*0–100/);
});

test('no candle overlap leaves the ordinary line intact with an explicit note', () => {
  const points = [{ timestamp: candles[29].timestamp + 1000, value: 20 }, { timestamp: candles[29].timestamp + 2000, value: 25 }];
  const tree = MarketChart({ points, metric: 'price', color: '#123456', currency: 'USD', indicators: active, indicatorHistory: fixture, seriesSource: 'market_chart', selectionScope: 'fixture' });
  assert.ok(nodes(tree).some((node) => node.type === 'Path' && node.props.stroke === '#123456'));
  assert.match(text(tree), /No candle closes fall within this visible line range/);
  assert.equal(nodes(tree).filter((node) => node.type === 'Path' && ['#FFD166', '#C4B5FD', '#7650C8'].includes(node.props.stroke)).length, 0, 'no indicator samples are fabricated');
});

test('line chart grows with its measured panel without changing its plotted data', () => {
  let width = 0;
  const { MarketChart: ResponsiveMarketChart } = load('src/components/market-chart.tsx', {
    react: { useState: () => [width, (value) => { width = value; }], useMemo: (fn) => fn(), useCallback: (fn) => fn }, 'react/jsx-runtime': jsx,
    'react-native': native, 'react-native-svg': svg, '@/lib/chart-path': geometry, '@/lib/chart-description': description,
    '@/lib/currency': currency, '@/lib/line-indicators': indicator, '@/lib/market': market, '@/lib/responsive-layout': responsive,
  });
  const props = { points: [{ timestamp: 1, value: 20 }, { timestamp: 2, value: 25 }], metric: 'price', color: '#123456', currency: 'USD', seriesSource: 'market_chart', selectionScope: 'fixture' };
  let tree = ResponsiveMarketChart(props);
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.height, 190);
  const originalPath = nodes(tree).find((node) => node.type === 'Path' && node.props.stroke === '#123456').props.d;
  nodes(tree).find((node) => node.type === 'View' && node.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 700 } } });
  tree = ResponsiveMarketChart(props);
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.height, 294);
  assert.equal(nodes(tree).find((node) => node.type === 'Path' && node.props.stroke === '#123456').props.d, originalPath);
});
