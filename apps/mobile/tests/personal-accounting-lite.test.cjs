// Synthetic session-only component checks; no device, saved data, or network.
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
function text(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree !== 'object') return String(tree);
  return text(tree.props?.children);
}
const snapshot = load('src/lib/business-snapshot.ts');
const model = load('src/lib/personal-accounting-lite.ts', { './business-snapshot': snapshot });
const element = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxRuntime = { jsx: element, jsxs: element, Fragment: 'Fragment' };

test('native playground calculates exact scenarios and only offers an available portfolio', () => {
  const slots = [];
  let cursor = 0;
  const react = { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = value; }]; } };
  const { PersonalAccountingLite } = load('src/components/personal-accounting-lite.tsx', {
    react, 'react/jsx-runtime': jsxRuntime,
    'react-native': { KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: (styles) => styles }, Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/lib/personal-accounting-lite': model,
  });
  const root = PersonalAccountingLite({ currency: 'GBP', portfolioTotal: null, portfolioAvailable: false });
  assert.equal(root.key, 'GBP');
  assert.equal(PersonalAccountingLite({ currency: 'USD', portfolioTotal: null, portfolioAvailable: false }).key, 'USD');
  const render = (props = root.props) => { cursor = 0; return root.type(props); };
  let tree = render();
  const portfolioButton = () => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Use portfolio estimate'));
  assert.equal(portfolioButton().props.disabled, true);
  const enter = (label, value) => { nodes(tree).find((node) => node.props?.label === label).props.onChange(value); tree = render(); };
  enter('Starting amount', '100.00');
  enter('Planned income', '50.00');
  enter('Planned spending', '25.00');
  enter('Savings target', '300.00');
  enter('Monthly contribution', '75.00');
  assert.match(text(tree), /GBP 125\.00/);
  assert.match(text(tree), /3 months/);
  assert.match(text(tree), /no interest or returns/i);
  tree = render({ currency: 'GBP', portfolioTotal: 23.456, portfolioAvailable: true });
  assert.equal(portfolioButton().props.disabled, false);
  portfolioButton().props.onPress();
  tree = render({ currency: 'GBP', portfolioTotal: 23.456, portfolioAvailable: true });
  assert.match(text(tree), /GBP 23\.46/);
  assert.match(text(tree), /not a cash balance/i);
  tree = render({ currency: 'GBP', portfolioTotal: null, portfolioAvailable: false });
  assert.match(text(tree), /complete portfolio estimate is unavailable/i);
  assert.doesNotMatch(text(tree), /GBP 23\.46/);
});

test('native playground retains and rejects an overlong paste in every amount field', () => {
  const slots = [];
  let cursor = 0;
  const react = { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = value; }]; } };
  const { PersonalAccountingLite } = load('src/components/personal-accounting-lite.tsx', {
    react, 'react/jsx-runtime': jsxRuntime,
    'react-native': { KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: (styles) => styles }, Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/lib/personal-accounting-lite': model,
  });
  const root = PersonalAccountingLite({ currency: 'GBP', portfolioTotal: null, portfolioAvailable: false });
  function expand(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if (typeof value.type === 'function') return expand(value.type(value.props));
    return { ...value, props: { ...value.props, children: expand(value.props?.children) } };
  }
  const render = () => { cursor = 0; return expand(root.type(root.props)); };
  let tree = render();
  const input = (label) => nodes(tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === `${label} in GBP`);
  const enter = (label, value) => {
    const field = input(label);
    assert.ok(field, `Missing ${label}`);
    // The native maxLength prop truncates a paste before onChangeText.
    const delivered = typeof field.props.maxLength === 'number' ? value.slice(0, field.props.maxLength) : value;
    field.props.onChangeText(delivered);
    tree = render();
  };
  const result = (label) => {
    const panel = nodes(tree).find((node) => node.type === 'View' && node.props.accessibilityLiveRegion === 'polite' && text(node).includes(label));
    assert.ok(panel, `Missing ${label} result`);
    return text(panel);
  };
  const fields = [
    ['Starting amount', '100.00', true, true],
    ['Planned income', '50.00', true, false],
    ['Planned spending', '25.00', true, false],
    ['Savings target', '300.00', false, true],
    ['Monthly contribution', '75.00', false, true],
  ];
  for (const [label, value] of fields) enter(label, value);
  assert.match(result('Scenario closing amount'), /GBP 125\.00/);
  assert.match(result('Estimated time'), /3 months/);
  const pasted = '0'.repeat(32) + '1';
  assert.equal(model.parseLiteMoney('0'.repeat(32), 'GBP').kind, 'valid');
  assert.equal(model.parseLiteMoney(pasted, 'GBP').kind, 'invalid');
  for (const [label, validValue, cashflowInvalid, savingsInvalid] of fields) {
    enter(label, pasted);
    assert.equal(input(label).props.value, pasted, `${label} must retain the complete pasted amount`);
    assert.match(input(label).props.accessibilityHint, /no more than 32 characters/i);
    assert.ok(nodes(tree).some((node) => node.props?.accessibilityRole === 'alert' && /no more than 32 characters/i.test(text(node))));
    assert.match(result('Scenario closing amount'), cashflowInvalid ? /Scenario closing amount—/ : /GBP 125\.00/);
    assert.match(result('Estimated time'), savingsInvalid ? /Estimated time—/ : /3 months/);
    enter(label, validValue);
    assert.match(result('Scenario closing amount'), /GBP 125\.00/);
    assert.match(result('Estimated time'), /3 months/);
  }
});

test('native account selection unmounts each view and clears the Lite session on blur', () => {
  const slots = [];
  let cursor = 0;
  let blur;
  let identity = null;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useCallback: (fn) => fn,
  };
  const native = { AppState: {}, Keyboard: {}, KeyboardAvoidingView: 'KeyboardAvoidingView', Linking: {}, Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: (styles) => styles }, Text: 'Text', TextInput: 'TextInput', View: 'View' };
  const { AccountWorkspace: AccountScreen } = load('src/app/business.tsx', {
    react, 'react/jsx-runtime': jsxRuntime, 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useFocusEffect: (callback) => { if (!blur) blur = callback(); } },
    '@/components/customer-private-boundary': {}, '@/components/customer-session-panel': {},
    '@/lib/customer-session-context': { useCustomerSession: () => ({ status: identity ? 'authenticated' : 'guest', identity }) },
    '@/components/native-button': {}, '@/components/paypal-activity-panel': {}, '@/components/business-period-comparison': {},
    '@/components/personal-accounting-lite': { PersonalAccountingLite: 'PersonalAccountingLite' },
    '@/lib/business-percentage': {}, '@/lib/report-lifecycle': {}, '@/lib/business-snapshot': {},
    '@/lib/data-context': { useData: () => ({ currency: 'GBP', holdings: {}, holdingDrafts: {}, overview: { data: null }, portfolioReady: true }) },
    '@/lib/holding-input': { hasHoldingInputIssue: () => false, previewHoldingInputs: () => ({}) },
    '@/lib/portfolio-value': { estimatePortfolio: () => ({ state: 'empty', estimatedValue: null }) },
    '@/lib/responsive-layout': { useResponsiveLayout: () => ({ wideCanvas: false, pairedPanels: false, shopGrid: false }) },
  });
  const render = () => { cursor = 0; return AccountScreen(); };
  let tree = render();
  const lite = () => nodes(tree).find((node) => node.type === 'PersonalAccountingLite');
  assert.equal(lite().key, 'GBP-0');
  blur();
  tree = render();
  assert.equal(lite().key, 'GBP-1');
  nodes(tree).find((node) => node.props?.accessibilityLabel === 'Business preview').props.onPress();
  tree = render();
  assert.equal(lite(), undefined);
  nodes(tree).find((node) => node.props?.accessibilityLabel === 'Personal Lite view').props.onPress();
  tree = render();
  assert.equal(lite().key, 'GBP-1');
  identity = { accountType: 'business' }; slots.length = 0; tree = render();
  assert.equal(lite(), undefined);
  assert.equal(nodes(tree).find(node => node.props?.accessibilityLabel === 'Business preview').props.accessibilityState.selected, true);
});
