// Synthetic component interaction tests: no device, storage or provider access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relativePath, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected module in synthetic test: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const currency = load('src/lib/currency.ts');
const market = load('src/lib/market.ts', { './currency': currency });
const element = (type, props, key) => ({ type, props: props ?? {}, key });
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const points = [1, 2, 3, 4, 5, 6].map((value) => ({ timestamp: value * 1_000, value }));

function makeScreen(chartPoints = points) {
  const slots = [];
  let next = 0;
  let lastChartRequest = null;
  let lastCandleRequest = null;
  let lastIntradayRequest = null;
  let currentCurrency = 'USD';
  let candleRevision = 0;
  let candleError = null;
  let responsiveLayout = { wideCanvas: false, pairedPanels: false, shopGrid: false };
  const react = {
    useState(initial) {
      const index = next++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useMemo(callback) { return callback(); },
  };
  const overview = {
    data: {
      retrievedAt: '2026-11-06T10:00:00Z',
      coins: market.ASSETS.map((asset, index) => ({ ...asset, price: 100 + index, marketCap: 200 + index, volume24h: 10 + index, change24hPct: index ? -2 : 5, lastUpdated: '2026-11-06T09:59:00Z' })),
    },
    loading: false, stale: false, error: null,
  };
  const chart = {
    data: { availableMetrics: ['price', 'marketCap', 'volume'], prices: chartPoints, marketCaps: chartPoints, volumes: chartPoints, retrievedAt: '2026-11-06T10:00:00Z', seriesSource: 'market_chart' },
    loading: false, stale: false, error: null, retry() {}, showLatestResponse() {},
  };
  const native = Object.fromEntries(['Pressable', 'RefreshControl', 'ScrollView', 'Text', 'View'].map((name) => [name, name]));
  native.StyleSheet = { create: (styles) => styles };
  const { default: Screen } = load('src/app/index.tsx', {
    react,
    'react/jsx-runtime': jsx,
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@/components/candle-chart': { CandleChart: 'CandleChart', CandleIndicatorControls: 'CandleIndicatorControls' },
    '@/components/market-chart': { MarketChart: 'MarketChart' },
    '@/components/market-header': { MarketHeader: 'MarketHeader' },
    '@/components/native-button': { NativeButton: 'NativeButton' },
    '@/lib/currency': currency,
    '@/lib/responsive-layout': { useResponsiveLayout: () => responsiveLayout },
    '@/lib/data-context': {
      useData: () => ({ overview, refreshOverview() {}, showLatestOverviewResponse() {}, currency: currentCurrency, currencyReady: true }),
      useMarketChart: (coinId, days, displayCurrency) => { lastChartRequest = { coinId, days, displayCurrency }; return chart; },
      useMarketCandles: (coinId, days, displayCurrency, enabled) => {
        lastCandleRequest = { coinId, days, displayCurrency, enabled };
        return { data: enabled && !candleError ? { candles: [{ timestamp: 1000, open: 1, high: 2, low: 1, close: 2 }], candleIntervalMinutes: 240, retrievedAt: '2026-11-06T10:00:00Z' } : null, loading: false, error: enabled ? candleError : null, retry() { candleRevision += 1; }, requestKey: `${displayCurrency}:${coinId}:${days}:${candleRevision}` };
      },
      useIntradayCandles: (coinId, interval, days, enabled) => {
        lastIntradayRequest = { coinId, interval, days, enabled };
        return { data: enabled ? { candles: [{ timestamp: 1000, open: 1, high: 2, low: 1, close: 2 }], intervalMinutes: Number(interval.slice(0, -1)), count: 1, coveredStart: 1, coveredEnd: 1000, observedAt: '2026-11-06T09:59:59Z', retrievedAt: '2026-11-06T10:00:00Z' } : null, loading: false, error: null, retry() {}, requestKey: `binance:USDT:${coinId}:${interval}:${days}` };
      },
    },
    '@/lib/market': market,
  });
  return {
    render() { next = 0; return Screen(); },
    chartRequest: () => lastChartRequest,
    candleRequest: () => lastCandleRequest,
    intradayRequest: () => lastIntradayRequest,
    candleRevision: () => candleRevision,
    setCandleError(value) { candleError = value; },
    setChartSource(value) { chart.data.seriesSource = value; },
    setCurrency(value) { currentCurrency = value; },
    setLayout(value) { responsiveLayout = value; },
    replaceChartPoints(nextPoints) { chart.data.prices = nextPoints; chart.data.marketCaps = nextPoints; chart.data.volumes = nextPoints; },
  };
}

test('candles load only when selected and indicator toggles keep the line chart available', () => {
  const screen = makeScreen();
  let tree = screen.render();
  assert.equal(screen.candleRequest().enabled, false);
  const candlesButton = nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Candles');
  assert.ok(candlesButton);
  candlesButton.props.onPress();
  tree = screen.render();
  assert.deepEqual(screen.candleRequest(), { coinId: 'bitcoin', days: 7, displayCurrency: 'USD', enabled: true });
  let candleChart = nodes(tree).find((node) => node.type === 'CandleChart');
  assert.ok(candleChart);
  assert.deepEqual(candleChart.props.indicators, { sma: false, ema: false, rsi: false });
  candleChart.props.onIndicatorChange('sma');
  tree = screen.render();
  candleChart = nodes(tree).find((node) => node.type === 'CandleChart');
  assert.equal(candleChart.props.indicators.sma, true);
  metricButton(tree, 'volume').props.onPress();
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, false);
  assert.ok(nodes(tree).find((node) => node.type === 'MarketChart'));
});

test('minute controls use the USDT feed, fence unsupported windows and leave Auto available for PYUSD', () => {
  const screen = makeScreen();
  let tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, false);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Candles').props.onPress();
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, true);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '3m').props.onPress();
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, false);
  assert.deepEqual(screen.intradayRequest(), { coinId: 'bitcoin', interval: '3m', days: 1, enabled: true });
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').props.quote, 'USDT');
  assert.match(text(tree), /USDT is a crypto quote, not USD/);
  assert.equal(nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '7D').props.disabled, true);
  nodes(tree).find((node) => node.type === 'CandleChart').props.onIndicatorChange('sma');
  screen.setCurrency('GBP');
  tree = screen.render();
  assert.deepEqual(screen.intradayRequest(), { coinId: 'bitcoin', interval: '3m', days: 1, enabled: true });
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').props.indicators.sma, true);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Line').props.onPress();
  tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, false);
  assert.equal(screen.candleRequest().enabled, true);
  assert.equal(nodes(tree).find((node) => node.type === 'MarketChart').props.indicators.sma, true);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Candles').props.onPress();
  tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, true);
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').props.indicators.sma, true);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '15m').props.onPress();
  tree = screen.render();
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '7D').props.onPress();
  tree = screen.render();
  assert.deepEqual(screen.intradayRequest(), { coinId: 'bitcoin', interval: '15m', days: 7, enabled: true });
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '3m').props.onPress();
  tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, false);
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart'), undefined);
  assert.match(text(tree), /Choose 1D for 3m or 5m candles/);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === '1D').props.onPress();
  tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, true);
  const pyusd = market.ASSETS.find((asset) => asset.id === 'paypal-usd');
  assetButton(tree, pyusd).props.onPress();
  tree = screen.render();
  assert.equal(screen.intradayRequest().enabled, false);
  assert.match(text(tree), /Minute candles unavailable for PYUSD/);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Use Auto').props.onPress();
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, true);
  assert.equal(screen.intradayRequest().enabled, false);
});

test('line indicator opt-in loads OHLC once and shares the choice with candle view', () => {
  const screen = makeScreen();
  let tree = screen.render();
  let controls = nodes(tree).find((node) => node.type === 'CandleIndicatorControls');
  assert.ok(controls);
  assert.equal(screen.candleRequest().enabled, false);
  controls.props.onIndicatorChange('sma');
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, true);
  assert.equal(screen.candleRevision(), 1);
  let line = nodes(tree).find((node) => node.type === 'MarketChart');
  assert.equal(line.props.indicators.sma, true);
  assert.ok(line.props.indicatorHistory);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Candles').props.onPress();
  tree = screen.render();
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').props.indicators.sma, true);
  assert.equal(screen.candleRevision(), 1, 'switching style reuses the same in-flight or completed OHLC request');
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Line').props.onPress();
  tree = screen.render();
  controls = nodes(tree).find((node) => node.type === 'CandleIndicatorControls');
  assert.equal(controls.props.indicators.sma, true);
  assert.equal(screen.candleRevision(), 1);
  controls.props.onIndicatorChange('sma');
  tree = screen.render();
  assert.equal(screen.candleRequest().enabled, false);
  line = nodes(tree).find((node) => node.type === 'MarketChart');
  assert.ok(line);
});

test('indicator load failure leaves the ordinary price line and zoom usable', () => {
  const screen = makeScreen();
  screen.setCandleError('Check your connection and try again.');
  let tree = screen.render();
  nodes(tree).find((node) => node.type === 'CandleIndicatorControls').props.onIndicatorChange('ema');
  tree = screen.render();
  assert.match(text(tree), /Indicators unavailable: Check your connection/);
  assert.ok(nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Retry indicators'));
  const line = nodes(tree).find((node) => node.type === 'MarketChart');
  assert.ok(line);
  assert.equal(line.props.indicatorHistory, null);
  zoomControl(tree).props.onAction('in');
  tree = screen.render();
  assert.ok(plottedPoints(tree).length < points.length);
});

test('estimated-time fallback never overlays OHLC and offers the candle view', () => {
  const screen = makeScreen();
  screen.setChartSource('market_overview_sparkline');
  let tree = screen.render();
  nodes(tree).find((node) => node.type === 'CandleIndicatorControls').props.onIndicatorChange('rsi');
  tree = screen.render();
  assert.match(text(tree), /Indicators are unavailable on this estimated-time line/);
  assert.equal(nodes(tree).find((node) => node.type === 'MarketChart').props.indicatorHistory, null);
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'View candles').props.onPress();
  tree = screen.render();
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').props.indicators.rsi, true);
});

test('candle chart remounts for a new asset, period, currency, or response request', () => {
  const screen = makeScreen();
  let tree = screen.render();
  const mode = (label) => nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === label);
  mode('Candles').props.onPress();
  tree = screen.render();
  let key = nodes(tree).find((node) => node.type === 'CandleChart').key;
  assetButton(tree, market.ASSETS[1]).props.onPress();
  tree = screen.render();
  let nextKey = nodes(tree).find((node) => node.type === 'CandleChart').key;
  assert.notEqual(nextKey, key);
  key = nextKey;
  mode('1D').props.onPress();
  tree = screen.render();
  nextKey = nodes(tree).find((node) => node.type === 'CandleChart').key;
  assert.notEqual(nextKey, key);
  key = nextKey;
  screen.setCurrency('GBP');
  tree = screen.render();
  nextKey = nodes(tree).find((node) => node.type === 'CandleChart').key;
  assert.notEqual(nextKey, key);
  key = nextKey;
  mode('Line').props.onPress();
  tree = screen.render();
  mode('Candles').props.onPress();
  tree = screen.render();
  assert.notEqual(nodes(tree).find((node) => node.type === 'CandleChart').key, key);
});

test('tablet resizing pairs panels without resetting the asset, zoom, or candle view', () => {
  const screen = makeScreen();
  let tree = screen.render();
  const safeArea = nodes(tree).find((node) => node.type === 'SafeAreaView');
  assert.deepEqual(safeArea.props.edges, ['top', 'left', 'right']);
  assetButton(tree, market.ASSETS[1]).props.onPress();
  tree = screen.render();
  zoomControl(tree).props.onAction('in');
  tree = screen.render();
  const viewport = zoomControl(tree).props.viewport;
  screen.setLayout({ wideCanvas: true, pairedPanels: true, shopGrid: true });
  tree = screen.render();
  assert.equal(assetButton(tree, market.ASSETS[1]).props.accessibilityState.selected, true);
  assert.deepEqual(zoomControl(tree).props.viewport, viewport);
  assert.ok(nodes(tree).some((node) => node.type === 'View' && node.props.style?.flexDirection === 'row' && node.props.style?.gap === 20));
  nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === 'Candles').props.onPress();
  tree = screen.render();
  const key = nodes(tree).find((node) => node.type === 'CandleChart').key;
  screen.setLayout({ wideCanvas: false, pairedPanels: false, shopGrid: false });
  tree = screen.render();
  assert.equal(nodes(tree).find((node) => node.type === 'CandleChart').key, key, 'rotation does not remount the candle inspector');
  assert.equal(assetButton(tree, market.ASSETS[1]).props.accessibilityState.selected, true);
});

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

function selector(tree) {
  const result = nodes(tree).find((node) => node.type === 'ScrollView' && node.props.accessibilityLabel === 'Choose a crypto asset');
  assert.ok(result, 'The asset selector is present near the chart.');
  return result;
}

function assetButton(tree, asset) {
  const button = nodes(selector(tree)).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === `Select ${asset.name}, ${asset.symbol}`);
  assert.ok(button, `The selector contains ${asset.name}.`);
  return button;
}

function metricButton(tree, metric) {
  const button = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'MetricButton' && node.props.metric === metric);
  assert.ok(button, `The ${metric} control is present.`);
  return button;
}

function text(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}

function zoomControl(tree) {
  const result = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'ChartZoomControls');
  assert.ok(result, 'The chart zoom controls are present.');
  return result;
}

function plottedPoints(tree) {
  const chart = nodes(tree).find((node) => node.type === 'MarketChart');
  assert.ok(chart, 'The chart is present.');
  return chart.props.points;
}

function priceChangeBadge(tree) {
  return nodes(tree).find((node) => typeof node.props?.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('24-hour price change'));
}

test('the nearby asset selector supports every tracked asset and resets chart zoom on selection', () => {
  const screen = makeScreen();
  let tree = screen.render();
  assert.equal(selector(tree).props.horizontal, true);
  for (const asset of market.ASSETS) assert.equal(assetButton(tree, asset).props.accessibilityState.selected, asset.id === 'bitcoin');

  const zoom = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'ChartZoomControls');
  assert.ok(zoom);
  zoom.props.onAction('in');
  tree = screen.render();
  assert.ok(nodes(tree).find((node) => node.type === zoom.type).props.viewport.start > 0);

  const ethereum = market.ASSETS.find((asset) => asset.id === 'ethereum');
  assetButton(tree, ethereum).props.onPress();
  tree = screen.render();
  assert.equal(assetButton(tree, ethereum).props.accessibilityState.selected, true);
  assert.equal(assetButton(tree, market.ASSETS[0]).props.accessibilityState.selected, false);
  assert.deepEqual(nodes(tree).find((node) => node.type === zoom.type).props.viewport, { start: 0, end: 1 });
  assert.deepEqual(screen.chartRequest(), { coinId: 'ethereum', days: 7, displayCurrency: 'USD' });
  assert.match(priceChangeBadge(tree).props.accessibilityLabel, /-2\.00%/);
});

test('the 24-hour price change badge does not imply market-cap or volume changes', () => {
  const screen = makeScreen();
  let tree = screen.render();
  assert.match(priceChangeBadge(tree).props.accessibilityLabel, /24-hour price change.*5\.00%/);
  assert.ok(nodes(priceChangeBadge(tree)).some((node) => node.type === 'Text' && node.props.children === '24h price'));

  for (const metric of ['marketCap', 'volume']) {
    metricButton(tree, metric).props.onPress();
    tree = screen.render();
    assert.equal(priceChangeBadge(tree), undefined, `${metric} must not show a price-change badge`);
    assert.ok(nodes(tree).some((node) => node.type === 'Text' && text(node) === `${market.metricLabel(metric)} history`));
  }
  metricButton(tree, 'price').props.onPress();
  tree = screen.render();
  assert.ok(priceChangeBadge(tree));
});

test('five chart samples zoom to a real three-sample window', () => {
  const screen = makeScreen(points.slice(0, 5));
  let tree = screen.render();
  zoomControl(tree).props.onAction('in');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree).map((point) => point.value), [3, 4, 5]);
  const controls = zoomControl(tree).type(zoomControl(tree).props);
  const zoomIn = nodes(controls).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Zoom in');
  assert.equal(zoomIn.props.disabled, true);
});

test('a long chart can zoom beyond four times and pan without losing its endpoints', () => {
  const samples = Array.from({ length: 365 }, (_, index) => ({ timestamp: index * 86_400_000, value: index + 1 }));
  const screen = makeScreen(samples);
  let tree = screen.render();
  for (let step = 0; step < 5; step += 1) {
    zoomControl(tree).props.onAction('in');
    tree = screen.render();
  }
  const latest = plottedPoints(tree);
  assert.ok(latest.length >= 3 && latest.length <= 14);
  assert.equal(latest.at(-1).timestamp, samples.at(-1).timestamp);
  const controls = zoomControl(tree).type(zoomControl(tree).props);
  assert.match(text(controls), /30\.3× view/);

  zoomControl(tree).props.onAction('earlier');
  tree = screen.render();
  assert.ok(plottedPoints(tree).at(-1).timestamp < latest.at(-1).timestamp);
  zoomControl(tree).props.onAction('later');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree), latest);
  zoomControl(tree).props.onAction('reset');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree), samples);
});

test('zoom level describes elapsed visible time for irregular samples', () => {
  const samples = [0, 1, 2, 3, 4, 100].map((timestamp) => ({ timestamp, value: timestamp + 1 }));
  const screen = makeScreen(samples);
  let tree = screen.render();
  zoomControl(tree).props.onAction('in');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree).map((point) => point.timestamp), [2, 3, 4, 100]);
  const controls = zoomControl(tree).type(zoomControl(tree).props);
  assert.match(text(controls), /1\.0× view/);
  assert.doesNotMatch(text(controls), /2\.0× view/);
});

test('a refreshed shorter series still shows at least three samples and can zoom out', () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({ timestamp: index * 1_000, value: index + 1 }));
  const screen = makeScreen(samples);
  let tree = screen.render();
  for (let step = 0; step < 5; step += 1) {
    zoomControl(tree).props.onAction('in');
    tree = screen.render();
  }
  screen.replaceChartPoints(samples.slice(0, 4));
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree), samples.slice(1, 4));
  zoomControl(tree).props.onAction('earlier');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree), samples.slice(0, 3));
  zoomControl(tree).props.onAction('out');
  tree = screen.render();
  assert.deepEqual(plottedPoints(tree), samples.slice(0, 4));
});
