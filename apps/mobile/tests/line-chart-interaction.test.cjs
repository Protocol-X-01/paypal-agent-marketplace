// Synthetic mobile line-chart gestures and rendering. No device, storage or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { Pressable: WebPressable } = require('react-native-web');

function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected line chart dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const series = load('src/lib/candle-series.ts');
const geometry = load('src/lib/chart-path.ts');
const indicators = load('src/lib/line-indicators.ts', { './candle-series': series });
const currency = load('src/lib/currency.ts');
const market = load('src/lib/market.ts', { './currency': currency });
const description = load('src/lib/chart-description.ts', { './market': market });
const responsive = load('src/lib/responsive-layout.ts', { 'react-native': {}, 'react-native-safe-area-context': {} });
const element = (type, props, key) => typeof type === 'function' && type.name === 'ViewIndicator' ? type(props ?? {}) : { type, props: props ?? {}, key };
const jsx = { jsx: element, jsxs: element, Fragment: 'Fragment' };
const svg = { __esModule: true, default: 'Svg', Circle: 'Circle', Defs: 'Defs', LinearGradient: 'LinearGradient', Line: 'Line', Path: 'Path', Stop: 'Stop' };

function makeChart(overrides = {}, platform = 'android') {
  const slots = [];
  let next = 0;
  let props = { points: [], metric: 'price', color: '#00CCFF', currency: 'GBP', seriesSource: 'market_chart', selectionScope: 'bitcoin:GBP:7', ...overrides };
  const react = {
    useState(initial) {
      const index = next++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useMemo(callback, deps) {
      const index = next++;
      const previous = slots[index];
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, value: callback() };
      }
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
  };
  const native = { PanResponder: { create: (handlers) => ({ panHandlers: { testPan: handlers } }) }, Platform: { OS: platform }, Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } };
  const { MarketChart } = load('src/components/market-chart.tsx', {
    react, 'react/jsx-runtime': jsx, 'react-native': native, 'react-native-svg': svg,
    '@/lib/chart-path': geometry, '@/lib/chart-description': description, '@/lib/currency': currency,
    '@/lib/line-indicators': indicators, '@/lib/market': market, '@/lib/responsive-layout': responsive,
  });
  return {
    setProps(value) { props = { ...props, ...value }; },
    render() { next = 0; return MarketChart(props); },
  };
}

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function allText(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(allText).join('');
  return typeof value === 'object' ? allText(value.props?.children) : String(value);
}
const control = (tree) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Line chart');
const button = (tree, label) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === label);
const gesture = (tree) => nodes(tree).find((node) => node.type === 'View' && node.props.testPan);
const marker = (tree) => nodes(tree).find((node) => node.type === 'Circle' && node.props.stroke === '#00CCFF');
function renderWebControl(tree) {
  const { children: _children, ...props } = control(tree).props;
  return renderToStaticMarkup(React.createElement(WebPressable, props));
}
const base = Date.parse('2026-11-06T10:00:00Z');
const points = [{ timestamp: base, value: 1 }, { timestamp: base + 60_000, value: 2 }, { timestamp: base + 600_000, value: 3 }];

test('tap and horizontal drag inspect actual timestamp-spaced samples while vertical scrolling is available', () => {
  const chart = makeChart({ points });
  let tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 3);
  gesture(tree).props.onLayout({ nativeEvent: { layout: { width: 640 } } });
  tree = chart.render();
  control(tree).props.onPress({ nativeEvent: { locationX: 76.8 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  assert.match(control(tree).props.accessibilityValue.text, /Price £2\.00.*Chart sample time 2026-11-06 10:01:00\.000 UTC/);
  assert.equal(marker(tree).props.cx, 76.8);
  assert.ok(nodes(tree).some((node) => node.type === 'Path' && node.props.stroke === '#00CCFF' && node.props.d.includes(`L ${marker(tree).props.cx.toFixed(1)} ${marker(tree).props.cy.toFixed(1)}`)));
  const pan = gesture(tree).props.testPan;
  assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 15, dy: 3 }), true);
  assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 3, dy: 15 }), false);
  pan.onPanResponderGrant({ nativeEvent: { locationX: 0 } });
  tree = chart.render();
  assert.equal(gesture(tree).props.testPan, pan, 'the active gesture survives selection rerenders');
  chart.setProps({ points: points.map((point) => ({ ...point })) });
  tree = chart.render();
  assert.equal(gesture(tree).props.testPan, pan, 'an equivalent parent redraw does not replace the active gesture');
  assert.equal(control(tree).props.accessibilityValue.now, 1);
  pan.onPanResponderMove({ nativeEvent: { locationX: 640 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 3);
  assert.equal(button(tree, 'Select next chart point').props.disabled, true);
});

test('inspection matches drawn samples after downsampling and exposes accessible step controls', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ timestamp: base + i * 60_000, value: i === 183 ? 10_000 : i }));
  const plotted = geometry.buildChartPath(many).samples;
  assert.ok(plotted.length <= 120);
  assert.ok(plotted.some((point) => point.value === 10_000), 'true high is retained');
  const chart = makeChart({ points: many });
  let tree = chart.render();
  assert.match(allText(tree), new RegExp(`Showing ${plotted.length} of 400 samples; zoom in`));
  assert.equal(control(tree).props.accessibilityValue.max, plotted.length);
  button(tree, 'Select previous chart point').props.onPress();
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, plotted.length - 1);
  const expected = plotted.at(-2);
  assert.equal(marker(tree).props.cx, expected.x);
  assert.equal(marker(tree).props.cy, expected.y);
  assert.match(control(tree).props.accessibilityValue.text, new RegExp(market.formatTimestamp(expected.timestamp).replaceAll('.', '\\.')));
  control(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, plotted.length);
  control(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, plotted.length - 1);
});

test('selection resets to a visible point for changed response, zoom, metric, currency and asset scope', () => {
  const chart = makeChart({ points });
  let tree = chart.render();
  button(tree, 'Select previous chart point').props.onPress();
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  assert.equal(control(chart.render()).props.accessibilityValue.now, 2, 'unchanged rerenders preserve inspection');
  chart.setProps({ points: [points[0], points[1], { ...points[2], value: 4 }] });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 3, 'changed data resets');
  button(tree, 'Select previous chart point').props.onPress();
  chart.setProps({ points: points.slice(0, 2) });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2, 'zoomed range uses its last visible point');
  button(tree, 'Select previous chart point').props.onPress();
  chart.setProps({ selectionScope: 'ethereum:GBP:7' });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2, 'new asset resets even with identical samples');
  button(tree, 'Select previous chart point').props.onPress();
  chart.setProps({ metric: 'volume' });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  assert.match(control(tree).props.accessibilityValue.text, /24h volume/);
  button(tree, 'Select previous chart point').props.onPress();
  chart.setProps({ currency: 'USD' });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  assert.match(control(tree).props.accessibilityValue.text, /\$/);
});

test('estimated fallback times are disclosed and web keyboard navigation uses actual plotted points', () => {
  const chart = makeChart({ points, seriesSource: 'market_overview_sparkline' }, 'web');
  let tree = chart.render();
  assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === 'Estimated sample time'));
  assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === '2026-11-06 10:10:00.000\u00a0UTC'));
  assert.match(control(tree).props.accessibilityValue.text, /Estimated sample time/);
  let html = renderWebControl(tree);
  assert.match(html, /role="slider"/);
  assert.match(html, /aria-valuemin="1"/);
  assert.match(html, /aria-valuemax="3"/);
  assert.match(html, /aria-valuenow="3"/);
  assert.match(html, /aria-valuetext="[^"]*Plotted point 3 of 3[^\"]*Estimated sample time/);
  let prevented = false;
  control(tree).props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => { prevented = true; } });
  tree = chart.render();
  assert.equal(prevented, true);
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === '2026-11-06 10:01:00.000\u00a0UTC'));
  html = renderWebControl(tree);
  assert.match(html, /aria-valuenow="2"/);
  assert.match(html, /aria-valuetext="[^"]*Plotted point 2 of 3[^\"]*10:01:00\.000 UTC/);
  // RN Web Pressable forwards a DOM MouseEvent for onPress. A coordinate at
  // the page origin from keyboard activation must not move the selection.
  const target = { getBoundingClientRect: () => ({ left: 105, width: 320 }) };
  control(tree).props.onPress({ currentTarget: target, nativeEvent: { clientX: 0, detail: 0 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2);
  // Use the element's rendered rectangle, including its page offset, even
  // before an onLayout callback has provided a width.
  control(tree).props.onPress({ currentTarget: target, nativeEvent: { clientX: 105, detail: 1 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 1);
  assert.match(renderWebControl(tree), /aria-valuenow="1"/);
  control(tree).props.onPress({ currentTarget: target, nativeEvent: { clientX: 143.4, detail: 1 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2, 'mouse click selects the timestamp-spaced plotted sample');
});

test('duplicate timestamps remain separately reachable and too few points do not offer inspection', () => {
  const duplicate = [points[0], { ...points[0], value: 2 }, points[2]];
  const chart = makeChart({ points: duplicate });
  let tree = chart.render();
  gesture(tree).props.onLayout({ nativeEvent: { layout: { width: 640 } } });
  tree = chart.render();
  control(tree).props.onPress({ nativeEvent: { locationX: 16 } });
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 2, 'direct selection prefers later equal-x sample');
  button(tree, 'Select previous chart point').props.onPress();
  tree = chart.render();
  assert.equal(control(tree).props.accessibilityValue.now, 1);
  assert.match(control(tree).props.accessibilityValue.text, /£1\.00/);
  chart.setProps({ points: [points[0]] });
  tree = chart.render();
  assert.equal(control(tree), undefined);
  assert.match(allText(tree), /Chart points are not available/);
});

test('extreme finite inputs do not produce an invalid point marker', () => {
  const extreme = [{ timestamp: -1e308, value: -1e308 }, { timestamp: 0, value: 0 }, { timestamp: 1e308, value: 1e308 }];
  const plotted = geometry.buildChartPath(extreme);
  assert.ok(plotted.samples.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.doesNotMatch(plotted.line, /NaN|Infinity/);
  const chart = makeChart({ points: extreme });
  const tree = chart.render();
  assert.equal(Number.isFinite(marker(tree).props.cx), true);
  assert.equal(Number.isFinite(marker(tree).props.cy), true);
  assert.match(control(tree).props.accessibilityValue.text, /Time unavailable/);
});
