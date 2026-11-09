// Synthetic window, insets and configuration checks; no emulator or device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relative, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected responsive test dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

let window = { width: 390, fontScale: 1 };
let insets = { top: 0, bottom: 0, left: 0, right: 0 };
const layout = load('src/lib/responsive-layout.ts', {
  'react-native': { useWindowDimensions: () => window },
  'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
});

test('window width, insets and large text decide layout without guessing device type', () => {
  assert.deepEqual(layout.resolveResponsiveLayout(390, 1), { contentWidth: 350, wideCanvas: false, pairedPanels: false, shopGrid: false });
  assert.deepEqual(layout.resolveResponsiveLayout(768, 1), { contentWidth: 728, wideCanvas: true, pairedPanels: false, shopGrid: true });
  assert.deepEqual(layout.resolveResponsiveLayout(1024, 1), { contentWidth: 984, wideCanvas: true, pairedPanels: true, shopGrid: true });
  assert.equal(layout.resolveResponsiveLayout(1024, 1.6).pairedPanels, false);
  assert.equal(layout.resolveResponsiveLayout(1024, 1.6).shopGrid, false);
  assert.equal(layout.resolveResponsiveLayout(920, 1, 40, 20).pairedPanels, false);
  assert.equal(layout.resolveResponsiveLayout(500, 1).shopGrid, false);
  assert.equal(layout.resolveResponsiveLayout(2400, 1).contentWidth, 1120);
  window = { width: 1024, fontScale: 1 };
  insets = { top: 0, bottom: 24, left: 40, right: 20 };
  assert.equal(layout.useResponsiveLayout().contentWidth, 924);
  window = { width: 500, fontScale: 1 };
  assert.equal(layout.useResponsiveLayout().pairedPanels, false, 'a resized split window returns to one column');
});

test('chart height follows measured panel width while preserving phone size', () => {
  assert.equal(layout.responsiveChartHeight(320), 190);
  assert.equal(layout.responsiveChartHeight(559), 190);
  assert.equal(layout.responsiveChartHeight(560), 235);
  assert.equal(layout.responsiveChartHeight(640), 269);
  assert.equal(layout.responsiveChartHeight(900), 300);
  assert.equal(layout.responsiveChartHeight(NaN), 190);
  assert.equal(layout.responsiveAllocationSize(0), 220);
  assert.equal(layout.responsiveAllocationSize(240), 200);
  assert.equal(layout.responsiveAllocationSize(340), 300);
  assert.equal(layout.responsiveAllocationSize(900), 300);
});

test('rotation is enabled in source config and iPad support remains enabled', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  assert.equal(config.expo.orientation, 'default');
  assert.equal(config.expo.ios.supportsTablet, true);
});

test('tab navigation preserves the phone size and accounts for larger bottom insets', () => {
  const element = (type, props) => ({ type, props: props ?? {} });
  const Tabs = function Tabs() {};
  Tabs.Screen = 'TabScreen';
  const identityFence = {};
  const { default: RootLayout } = load('src/app/_layout.tsx', {
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'expo-router': { Tabs }, 'expo-status-bar': { StatusBar: 'StatusBar' },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', useSafeAreaInsets: () => insets },
    'react-native': { View: 'View', StyleSheet: { create: (styles) => styles }, useWindowDimensions: () => ({ width: 768, fontScale: 1 }) },
    'react-native-svg': { default: 'Svg', Path: 'Path' }, '@/lib/data-context': { DataProvider: 'DataProvider' },
    '@/lib/customer-session-context': { CustomerSessionProvider: 'CustomerSessionProvider', useCustomerSession: () => ({ storageFence: identityFence, revision: 7 }) },
  });
  function nodes(value) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    return [value, ...nodes(value.props?.children)];
  }
  const root = RootLayout();
  assert.ok(nodes(root).some(node => node.type === 'CustomerSessionProvider'));
  const workspace = nodes(root).find(node => typeof node.type === 'function' && node.type.name === 'CustomerWorkspace').type();
  assert.equal(workspace.props.storageFence, identityFence);
  assert.equal(workspace.props.storageRevision, 7);
  const tabsElement = nodes(workspace).find((node) => typeof node.type === 'function' && node.type.name === 'TabsWithInsets');
  assert.ok(tabsElement);
  insets = { top: 0, bottom: 0, left: 0, right: 0 };
  let options = tabsElement.type().props.screenOptions({ route: { name: 'index' } });
  assert.equal(options.tabBarStyle.height, 64);
  assert.equal(options.tabBarStyle.paddingBottom, 8);
  insets = { top: 0, bottom: 24, left: 0, right: 0 };
  options = tabsElement.type().props.screenOptions({ route: { name: 'index' } });
  assert.equal(options.tabBarStyle.height, 80);
  assert.equal(options.tabBarStyle.paddingBottom, 24);
});
