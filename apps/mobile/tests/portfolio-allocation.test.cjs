// Synthetic component test: no device, saved quantities, or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relative, aliases = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', code)(loaded.exports, (name) => {
    if (Object.hasOwn(aliases, name)) return aliases[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected module: ${name}`);
  }, loaded);
  return loaded.exports;
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const allocation = load('src/lib/portfolio-allocation.ts');
const responsive = load('src/lib/responsive-layout.ts', { 'react-native': {}, 'react-native-safe-area-context': {} });
function component() {
  const slots = [];
  let cursor = 0;
  const element = (type, props) => ({ type, props: props ?? {} });
  const Component = load('src/components/portfolio-allocation.tsx', {
    react: { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = value; }]; } },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
    'react-native-svg': { __esModule: true, default: 'Svg', Circle: 'Circle' },
    '@/lib/portfolio-allocation': allocation,
    '@/lib/responsive-layout': responsive,
  }).PortfolioAllocation;
  return (positions, total) => { cursor = 0; return Component({ positions, total, currency: 'GBP', unavailableMessage: 'Price needed for one holding.', formatValue: (value) => `£${value}`, stale: false }); };
}

test('native chart and accessible legend select an asset and hide incomplete allocations', () => {
  const render = component();
  const positions = [
    { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', color: '#F7931A', value: 75 },
    { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627EEA', value: 25 },
  ];
  let tree = render(positions, 100);
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.width, 220);
  const button = (label) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith(label));
  assert.equal(button('Bitcoin').props.accessibilityState.selected, false);
  button('Bitcoin').props.onPress();
  tree = render(positions, 100);
  assert.equal(button('Bitcoin').props.accessibilityState.selected, true);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Bitcoin, 75.0% of portfolio, £75'));
  tree.props.onLayout({ nativeEvent: { layout: { width: 340 } } });
  tree = render(positions, 100);
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.width, 300);
  assert.equal(button('Bitcoin').props.accessibilityState.selected, true, 'resizing preserves the selected asset');
  tree.props.onLayout({ nativeEvent: { layout: { width: 240 } } });
  tree = render(positions, 100);
  assert.equal(nodes(tree).find((node) => node.type === 'Svg').props.width, 200);
  button('Ethereum').props.onPress();
  tree = render(positions, 100);
  assert.equal(button('Ethereum').props.accessibilityState.selected, true);
  tree = render([...positions, { id: 'solana', name: 'Solana', symbol: 'SOL', color: '#fff', value: null }], null);
  assert.equal(nodes(tree).some((node) => node.type === 'Svg'), false);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityRole === 'summary'));
});
