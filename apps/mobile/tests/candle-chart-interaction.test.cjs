// Synthetic render/gesture checks: no device, storage or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(relativePath, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected module in synthetic test: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const currency = load('src/lib/currency.ts');
const market = load('src/lib/market.ts', { './currency': currency });
const series = load('src/lib/candle-series.ts');
const viewport = load('src/lib/candle-viewport.ts');
const responsive = load('src/lib/responsive-layout.ts', { 'react-native': {}, 'react-native-safe-area-context': {} });
const element = (type, props, key) => typeof type === 'function' && type.name === 'CandleIndicatorControls'
  ? type(props ?? {})
  : { type, props: props ?? {}, key };
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const makeCandles = () => Array.from({ length: 24 }, (_, index) => ({
  timestamp: 1_000 + index * 240 * 60_000, open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index,
}));

function makeChart(platform = 'android', candles = makeCandles(), options = {}) {
  const slots = [];
  let next = 0;
  let indicators = { sma: false, ema: false, rsi: false, ...options.initialIndicators };
  const react = {
    useState(initial) {
      const index = next++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
  };
  const native = { PanResponder: { create: (handlers) => ({ panHandlers: { testPan: handlers } }) }, Platform: { OS: platform }, Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } };
  const svg = { __esModule: true, default: 'Svg', Line: 'Line', Path: 'Path', Rect: 'Rect' };
  const { CandleChart } = load('src/components/candle-chart.tsx', {
    react, 'react/jsx-runtime': jsx, 'react-native': native, 'react-native-svg': svg,
    '@/lib/candle-series': series, '@/lib/candle-viewport': viewport, '@/lib/market': market, '@/lib/responsive-layout': responsive,
  });
  return {
    render() {
      next = 0;
      return CandleChart({ candles, currency: options.currency ?? 'GBP', quote: options.quote, intervalMinutes: options.intervalMinutes ?? 240, isPaypalUsd: options.isPaypalUsd ?? false, indicators, onIndicatorChange: (name) => { indicators = { ...indicators, [name]: !indicators[name] }; } });
    },
  };
}

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const chartControl = (tree) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Candlestick chart');
const button = (tree, label) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === label);
const gesture = (tree) => nodes(tree).find((node) => node.type === 'View' && node.props.testPan);
function allText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(allText).join('');
  return typeof node === 'object' ? allText(node.props?.children) : String(node);
}

test('tap and horizontal drag select real candles while vertical gestures remain available for scrolling', () => {
  const chart = makeChart();
  let tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 24);
  gesture(tree).props.onLayout({ nativeEvent: { layout: { width: 320 } } });
  tree = chart.render();
  chartControl(tree).props.onPress({ nativeEvent: { locationX: 0 } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 1);
  const pan = gesture(tree).props.testPan;
  assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 15, dy: 3 }), true);
  assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 3, dy: 15 }), false);
  pan.onPanResponderGrant({ nativeEvent: { locationX: 160 } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 13);
  pan.onPanResponderMove({ nativeEvent: { locationX: 320 } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 24);
  assert.match(chartControl(tree).props.accessibilityValue.text, /Candle 24 of 24.*UTC.*open.*high.*low.*close/i);
  gesture(tree).props.onLayout({ nativeEvent: { layout: { width: 640 } } });
  tree = chart.render();
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.height, 269);
  assert.equal(chartControl(tree).props.accessibilityValue.now, 24, 'resizing does not reset selection');
  chartControl(tree).props.onPress({ nativeEvent: { locationX: 320 } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 13, 'the same plot position works after resize');
});

test('positive candles use PayPal blue and negative candles remain red', () => {
  const candles = [
    { timestamp: 1, open: 2, high: 4, low: 1, close: 3 },
    { timestamp: 2, open: 3, high: 4, low: 1, close: 2 },
  ];
  const tree = makeChart('android', candles).render();
  const colors = nodes(tree).filter((node) => typeof node.type === 'function' && node.type.name === 'ViewCandle').map((node) => node.props.color);
  assert.deepEqual(colors, ['#0070E0', '#C1434E']);
});

test('minute candle labels and accessible inspector identify USDT without fiat symbols or a USD peg', () => {
  const chart = makeChart('android', makeCandles(), { quote: 'USDT', currency: 'USD', intervalMinutes: 3, isPaypalUsd: true });
  let tree = chart.render();
  assert.match(allText(tree), /3-minute/);
  assert.match(allText(tree), /USDT/);
  assert.doesNotMatch(allText(tree), /\$|USD peg/);
  assert.match(chartControl(tree).props.accessibilityValue.text, /open \d+(?:\.\d+)? USDT/);
  button(tree, 'Indicators').props.onPress();
  tree = chart.render();
  nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox').props.onPress();
  tree = chart.render();
  assert.match(allText(tree), /SMA 20.*USDT/);
});

test('zoom and accessible previous/next controls maintain a visible selected candle', () => {
  const chart = makeChart();
  let tree = chart.render();
  button(tree, 'Zoom in candles').props.onPress();
  tree = chart.render();
  assert.match(allText(tree), /12 of 24 candles/);
  assert.equal(chartControl(tree).props.accessibilityValue.now, 24);
  chartControl(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 23);
  button(tree, 'Select previous candle').props.onPress();
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 22);
  chartControl(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  tree = chart.render();
  assert.equal(chartControl(tree).props.accessibilityValue.now, 23);
});

test('indicators begin off, expose warming up, and keyboard arrows step selection on web', () => {
  const chart = makeChart('web');
  let tree = chart.render();
  button(tree, 'Indicators').props.onPress();
  tree = chart.render();
  const options = nodes(tree).filter((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox');
  assert.equal(options.length, 3);
  assert.ok(options.every((option) => option.props.accessibilityState.checked === false));
  options[0].props.onPress();
  tree = chart.render();
  assert.match(allText(tree), /SMA 20/);
  let prevented = false;
  chartControl(tree).props.onKeyDown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  tree = chart.render();
  assert.equal(prevented, true);
  assert.equal(chartControl(tree).props.accessibilityValue.now, 23);
  gesture(tree).props.onLayout({ nativeEvent: { layout: { width: 320 } } });
  tree = chart.render();
  chartControl(tree).props.onPress({ nativeEvent: { locationX: 0 } });
  tree = chart.render();
  assert.match(allText(tree), /SMA 20.*Warming up.*needs 20 closes/);
});

test('indicator availability follows the 20-close and 15-close warm-up boundaries', () => {
  for (const [count, enabled] of [[14, [false, false, false]], [15, [false, false, true]], [19, [false, false, true]], [20, [true, true, true]]]) {
    const chart = makeChart('android', makeCandles().slice(0, count));
    let tree = chart.render();
    button(tree, 'Indicators').props.onPress();
    tree = chart.render();
    const options = nodes(tree).filter((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox');
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((option) => !option.props.disabled), enabled);
    assert.deepEqual(options.map((option) => !option.props.accessibilityState.disabled), enabled);
    assert.match(allText(tree), /Needs 20 closes/);
    assert.match(allText(tree), /Needs 15 closes \(14 changes\)/);
    assert.match(options[2].props.accessibilityLabel, /requires 15 closes \(14 changes\)/);
  }
});

test('already-on indicators can be switched off after moving to a shorter history', () => {
  const chart = makeChart('android', makeCandles().slice(0, 10), { initialIndicators: { sma: true, ema: true, rsi: true } });
  let tree = chart.render();
  button(tree, 'Indicators').props.onPress();
  tree = chart.render();
  let options = nodes(tree).filter((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox');
  assert.ok(options.every((option) => option.props.accessibilityState.checked && !option.props.disabled));
  assert.match(allText(tree), /SMA 20.*Warming up.*needs 20 closes/);
  assert.match(allText(tree), /EMA 20.*Warming up.*needs 20 closes/);
  assert.match(allText(tree), /RSI 14.*Warming up.*needs 15 closes \(14 changes\)/);
  options[0].props.onPress();
  options[2].props.onPress();
  tree = chart.render();
  options = nodes(tree).filter((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox');
  assert.deepEqual(options.map((option) => option.props.accessibilityState.checked), [false, true, false]);
  assert.deepEqual(options.map((option) => option.props.disabled), [true, false, true]);
  assert.match(options[0].props.accessibilityHint, /Not enough candle history/);
  assert.match(options[1].props.accessibilityHint, /switch this indicator off/);
});

test('missing candle intervals are marked and break indicator lines', () => {
  const candles = makeCandles().map((candle, index) => index >= 21 ? { ...candle, timestamp: candle.timestamp + 480 * 60_000 } : candle);
  const chart = makeChart('android', candles);
  let tree = chart.render();
  assert.match(allText(tree), /Dashed separators mark missing intervals/);
  button(tree, 'Indicators').props.onPress();
  tree = chart.render();
  nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox').props.onPress();
  tree = chart.render();
  const sma = nodes(tree).find((node) => node.type === 'Path' && node.props.stroke === '#D08A12');
  assert.equal((sma.props.d.match(/M /g) ?? []).length, 2);
});

test('the PYUSD peg guide is shown only in the USD view', () => {
  const candles = [{ timestamp: 1, open: 1, high: 1.001, low: 0.999, close: 1.0001 }];
  const usd = makeChart('android', candles, { currency: 'USD', isPaypalUsd: true }).render();
  const gbp = makeChart('android', candles, { currency: 'GBP', isPaypalUsd: true }).render();
  assert.match(allText(usd), /\$1\.00 USD peg/);
  assert.ok(nodes(usd).some((node) => node.type === 'Line' && node.props.stroke === '#795716'));
  assert.doesNotMatch(allText(gbp), /peg/);
});

test('visible and spoken OHLC values use readable precision while retaining stablecoin movement', () => {
  const btc = [{ timestamp: 1, open: 75810.55922100782, high: 75820.123456789, low: 75800.111111111, close: 75815.987654321 }];
  const tree = makeChart('android', btc, { currency: 'USD' }).render();
  assert.match(allText(tree), /\$75,810\.56/);
  assert.match(chartControl(tree).props.accessibilityValue.text, /open \$75,810\.56/);
  assert.doesNotMatch(allText(tree), /55922100782/);
  assert.doesNotMatch(chartControl(tree).props.accessibilityValue.text, /55922100782/);
  const stable = [{ timestamp: 1, open: 1.00001234, high: 1.00001235, low: 0.99998765, close: 1.00001234 }];
  const stableTree = makeChart('android', stable, { currency: 'USD', isPaypalUsd: true }).render();
  assert.match(allText(stableTree), /\$1\.00001234/);
  assert.match(chartControl(stableTree).props.accessibilityValue.text, /\$0\.99998765/);
});
