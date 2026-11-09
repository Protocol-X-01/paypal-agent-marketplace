// Fictional data only. Exercises the comparison helper and actual screen component.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const requireModule = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected dependency in synthetic comparison test: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, requireModule, loaded);
  return loaded.exports;
}

const snapshotLib = load('src/lib/business-snapshot.ts');
const comparisonLib = load('src/lib/business-comparison.ts', { './business-snapshot': snapshotLib });
const channelComparisonLib = load('src/lib/business-channel-comparison.ts', { './business-snapshot': snapshotLib });
const businessPercentageLib = load('src/lib/business-percentage.ts');
const { buildBusinessComparison } = comparisonLib;
const example = {
  windowDays: 7,
  currency: 'GBP',
  sourceUpdatedAt: '2026-11-06T00:00:00Z',
  periods: {
    previous: { startDate: '2026-10-23', endExclusive: '2026-10-30', transactions: 100, grossMinor: 100000, refundMinor: 2000 },
    current: { startDate: '2026-10-30', endExclusive: '2026-11-06', transactions: 120, grossMinor: 120000, refundMinor: 3000 },
  },
  rows: [],
  summary: { transactionChangePct: 20, refundRatioPct: 2.5 },
};

function clone(value) { return structuredClone(value); }

test('shows exact previous and current values and their UTC period boundaries', () => {
  const transactions = buildBusinessComparison(example, 'transactions');
  assert.equal(transactions.bothZero, false);
  assert.deepEqual(transactions.rows.map(({ label, formatted }) => [label, formatted]), [
    ['Previous period', '100'], ['Current period', '120'],
  ]);
  assert.deepEqual(transactions.rows.map(({ startDate, endExclusive }) => [startDate, endExclusive]), [
    ['2026-10-23', '2026-10-30'], ['2026-10-30', '2026-11-06'],
  ]);
  assert.ok(Math.abs(parseFloat(transactions.rows[0].width) - 100 * 100 / 120) < 1e-9);
  assert.equal(transactions.rows[1].width, '100%');

  const gross = buildBusinessComparison(example, 'gross');
  assert.deepEqual(gross.rows.map(({ formatted }) => formatted), ['£1,000.00', '£1,200.00']);
  const refunds = buildBusinessComparison(example, 'refunds');
  assert.deepEqual(refunds.rows.map(({ formatted }) => formatted), ['£20.00', '£30.00']);
});

test('uses the report currency minor units without converting or rounding them', () => {
  const kwd = clone(example);
  kwd.currency = 'KWD';
  kwd.periods.previous.grossMinor = 12345;
  kwd.periods.current.grossMinor = 9876;
  const results = buildBusinessComparison(kwd, 'gross').rows.map(({ formatted }) => formatted);
  assert.match(results[0], /12\.345/);
  assert.match(results[1], /9\.876/);

  const jpy = clone(example);
  jpy.currency = 'JPY';
  jpy.periods.current.grossMinor = 1234;
  assert.match(buildBusinessComparison(jpy, 'gross').rows[1].formatted, /1,234/);
  assert.doesNotMatch(buildBusinessComparison(jpy, 'gross').rows[1].formatted, /1,234\.00/);
});

test('zero totals have zero-width bars and no invented percentage', () => {
  const zero = clone(example);
  zero.periods.previous.transactions = 0;
  zero.periods.current.transactions = 0;
  let result = buildBusinessComparison(zero, 'transactions');
  assert.equal(result.bothZero, true);
  assert.deepEqual(result.rows.map(({ formatted, width }) => [formatted, width]), [['0', '0%'], ['0', '0%']]);
  zero.periods.current.transactions = 4;
  result = buildBusinessComparison(zero, 'transactions');
  assert.equal(result.bothZero, false);
  assert.deepEqual(result.rows.map(({ width }) => width), ['0%', '100%']);
});

test('handles refunds larger than gross and the maximum aggregate without inventing values', () => {
  const large = clone(example);
  large.periods.previous.refundMinor = 1;
  large.periods.current.refundMinor = 3_000_000_000_000;
  const refunds = buildBusinessComparison(large, 'refunds');
  assert.equal(refunds.rows[1].formatted, '£30,000,000,000.00');
  assert.equal(refunds.rows[1].width, '100%');
  assert.ok(parseFloat(refunds.rows[0].width) > 0);
  assert.ok(parseFloat(refunds.rows[0].width) < 1);
});

function nodes(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

function textOf(tree) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (typeof tree !== 'object') return String(tree);
  return textOf(tree.props?.children);
}

function createComponent(snapshot) {
  const slots = [];
  let cursor = 0;
  const react = {
    useMemo(factory) { return factory(); },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const component = load('src/components/business-period-comparison.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: Symbol('Fragment') },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles } },
    '@/lib/business-comparison': comparisonLib,
    '@/lib/business-channel-comparison': channelComparisonLib,
  });
  return () => { cursor = 0; return component.BusinessPeriodComparison({ snapshot }); };
}

test('the actual selector changes the comparison and exposes dates and totals to assistive technology', () => {
  const render = createComponent(example);
  let tree = render();
  const button = (name) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === `Compare ${name}`);
  assert.equal(button('transactions').props.accessibilityState.selected, true);
  assert.equal(button('gross').props.accessibilityState.selected, false);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Previous period, 2026-10-23 to before 2026-10-30 UTC. Transactions: 100.'));

  button('gross').props.onPress();
  tree = render();
  assert.equal(button('gross').props.accessibilityState.selected, true);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Current period, 2026-10-30 to before 2026-11-06 UTC. Gross volume: £1,200.00.'));
  assert.match(textOf(tree), /Bars are scaled to the larger period total/);

  button('refunds').props.onPress();
  tree = render();
  assert.equal(button('refunds').props.accessibilityState.selected, true);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Current period, 2026-10-30 to before 2026-11-06 UTC. Refund amount: £30.00.'));
});

test('the component explicitly explains two zero totals', () => {
  const zero = clone(example);
  zero.periods.previous.transactions = 0;
  zero.periods.current.transactions = 0;
  assert.match(textOf(createComponent(zero)()), /Both period totals are zero/);
});

test('channel comparisons are accessible and follow the selected metric', () => {
  const snapshot = clone(example);
  snapshot.rows = [
    { period: 'previous', channel: 'online', transactions: 100, grossMinor: 100000, refundMinor: 3000 },
    { period: 'current', channel: 'online', transactions: 120, grossMinor: 120000, refundMinor: 2000 },
    { period: 'previous', channel: 'in_person', transactions: 0, grossMinor: 0, refundMinor: 0 },
    { period: 'current', channel: 'in_person', transactions: 2, grossMinor: 1500, refundMinor: 0 },
  ];
  const render = createComponent(snapshot);
  let tree = render();
  let online = nodes(tree).find((node) => node.props.accessibilityLabel === 'Online. Transactions. Previous 100. Current 120. Increase of 20. +20.0% vs previous.');
  assert.ok(online);
  const barWidths = (row) => nodes(row).flatMap((node) => Array.isArray(node.props?.style) ? node.props.style.filter((style) => typeof style?.width === 'string').map((style) => style.width) : []);
  assert.deepEqual(barWidths(online), [`${100 / 120 * 100}%`, '100%']);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'In person. Transactions. Previous 0. Current 2. Increase of 2. Previous period is zero; percentage unavailable.'));
  const button = nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Compare refunds');
  button.props.onPress();
  tree = render();
  online = nodes(tree).find((node) => node.props.accessibilityLabel === 'Online. Refund amount. Previous £30.00. Current £20.00. Decrease of £10.00. −33.3% vs previous.');
  assert.ok(online);
  assert.deepEqual(barWidths(online), ['100%', `${2000 / 3000 * 100}%`]);
});

test('the actual Business screen removes the comparison on clear, blur, and background', () => {
  const lifecycle = load('src/lib/report-lifecycle.ts');
  const slots = [];
  let cursor = 0;
  let blur;
  let appStateChange;
  let mounted = false;
  let responsiveLayout = { wideCanvas: false, pairedPanels: false, shopGrid: false };
  const react = {
    useMemo(factory) { return factory(); },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useCallback(callback) { return callback; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(callback) { if (!mounted) callback(); },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  native.StyleSheet = { create: (styles) => styles };
  native.Platform = { OS: 'android' };
  native.Keyboard = { dismiss() {} };
  const openedUrls = [];
  native.Linking = { openURL: async (url) => { openedUrls.push(url); } };
  native.AppState = { addEventListener(_name, callback) { appStateChange = callback; return { remove() {} }; } };
  const customerSession = { storageFence: { capture: () => null, isCurrent: () => false }, status: 'guest', identity: null, revision: 0 };
  const screen = load('src/app/business.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: Symbol('Fragment') },
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useFocusEffect(callback) { if (!blur) blur = callback(); } },
    '@/components/customer-private-boundary': {}, '@/components/customer-session-panel': {}, '@/lib/customer-session-context': { useCustomerSession: () => customerSession },
    '@/components/native-button': { NativeButton: 'NativeButton' },
    '@/components/paypal-activity-panel': { PayPalActivityPanel: 'PayPalActivityPanel' },
    '@/components/business-period-comparison': { BusinessPeriodComparison: 'BusinessPeriodComparison' },
    '@/components/personal-accounting-lite': { PersonalAccountingLite: 'PersonalAccountingLite' },
    '@/lib/data-context': {},
    '@/lib/holding-input': {},
    '@/lib/portfolio-value': {},
    '@/lib/business-snapshot': snapshotLib,
    '@/lib/report-lifecycle': lifecycle,
    '@/lib/business-percentage': businessPercentageLib,
    '@/lib/responsive-layout': { useResponsiveLayout: () => responsiveLayout },
  }).BusinessContent;
  const render = () => { cursor = 0; const tree = screen(); mounted = true; return tree; };
  const button = (tree, label) => nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === label);
  const perspective = (tree, label) => nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  const firstMetric = (tree) => nodes(tree).find((node) => ['Transactions', 'Activity change'].includes(node.props?.label))?.props.label;
  const hasComparison = (tree) => nodes(tree).some((node) => node.type === 'BusinessPeriodComparison');
  let tree = render();
  assert.equal(hasComparison(tree), false);
  nodes(tree).find((node) => node.props?.accessibilityLabel === 'Explore PayPal Point of Sale, UK information').props.onPress();
  assert.deepEqual(openedUrls, ['https://www.paypal.com/uk/business/pos-system']);
  assert.equal(perspective(tree, 'Activity').props.accessibilityState.selected, true);
  perspective(tree, 'Summary').props.onPress();
  tree = render();
  assert.equal(perspective(tree, 'Summary').props.accessibilityState.selected, true);
  assert.equal(hasComparison(tree), false, 'changing the presentation does not create a report');

  button(tree, 'Try fictional example').props.onPress();
  tree = render();
  assert.equal(hasComparison(tree), true);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Active customer accounts: unavailable'));
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Customer retention: unavailable'));
  assert.equal(firstMetric(tree), 'Activity change');
  responsiveLayout = { wideCanvas: true, pairedPanels: true, shopGrid: true };
  tree = render();
  assert.equal(hasComparison(tree), true, 'resizing keeps the current report');
  assert.equal(perspective(tree, 'Summary').props.accessibilityState.selected, true);
  assert.ok(nodes(tree).some((node) => node.type === 'View' && node.props.style?.flexDirection === 'row' && node.props.style?.gap === 20));
  perspective(tree, 'Activity').props.onPress();
  tree = render();
  assert.equal(firstMetric(tree), 'Transactions');
  assert.equal(hasComparison(tree), true, 'changing presentation preserves the report');
  button(tree, 'Clear report').props.onPress();
  tree = render();
  assert.equal(hasComparison(tree), false);

  button(tree, 'Try fictional example').props.onPress();
  assert.equal(hasComparison(render()), true);
  blur();
  tree = render();
  assert.equal(hasComparison(tree), false);

  button(tree, 'Try fictional example').props.onPress();
  assert.equal(hasComparison(render()), true);
  appStateChange('background');
  assert.equal(hasComparison(render()), false);

  const csv = (previous, current, gross, refunds) => [
    'window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at',
    `7,previous,2026-10-23,2026-10-30,online,GBP,${previous},${gross},${refunds},2026-11-06T00:00:00Z`,
    `7,current,2026-10-30,2026-11-06,online,GBP,${current},${gross},${refunds},2026-11-06T00:00:00Z`,
  ].join('\n');
  function importCsv(value) {
    let view = render();
    nodes(view).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Aggregate CSV report').props.onChangeText(value);
    view = render();
    nodes(view).find((node) => node.props.accessibilityRole === 'checkbox').props.onPress();
    view = render();
    button(view, 'View report').props.onPress();
    return render();
  }
  const cardValue = (view, label) => nodes(view).find((node) => node.props?.label === label)?.props.value;
  const staleExamplePress = button(render(), 'Try fictional example').props.onPress;
  tree = importCsv(csv(100, 555, 100000, 2000));
  assert.equal(cardValue(tree, 'Transactions'), '555');
  assert.equal(nodes(tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Aggregate CSV report').props.value, '', 'The imported text is intentionally cleared');
  assert.equal(button(tree, 'Try fictional example').props.disabled, true, 'A self-provided report must be cleared before loading the fictional example');
  assert.match(textOf(tree), /clear the aggregate report to explore fictional figures/i);
  assert.match(button(tree, 'Try fictional example').props.accessibilityLabel, /clear the aggregate report/i);
  staleExamplePress();
  tree = render();
  assert.equal(cardValue(tree, 'Transactions'), '555', 'An already queued example action must not replace the report');
  assert.ok(nodes(tree).some((node) => node.type === 'BusinessPeriodComparison' && node.props.snapshot.periods.current.transactions === 555));
  button(tree, 'Clear report').props.onPress();
  tree = render();
  assert.equal(button(tree, 'Try fictional example').props.disabled, false);
  button(tree, 'Try fictional example').props.onPress();
  tree = render();
  assert.equal(cardValue(tree, 'Transactions'), '120', 'The fictional example is available after clearing the report');
  tree = importCsv(csv(999999999, 1000000000, 1000000000000, 1));
  assert.equal(cardValue(tree, 'Activity change'), 'Increase under 0.1%');
  assert.equal(cardValue(tree, 'Refund ratio'), 'Under 0.1%');
  tree = importCsv(csv(1000000000, 999999999, 1000000000000, 1));
  assert.equal(cardValue(tree, 'Activity change'), 'Decrease under 0.1%');
  tree = importCsv(csv(100, 100, 1000, 0));
  assert.equal(cardValue(tree, 'Activity change'), '0.0%');
  assert.equal(cardValue(tree, 'Refund ratio'), '0.0%');
  tree = importCsv(csv(0, 1, 0, 0));
  assert.equal(cardValue(tree, 'Activity change'), 'Unavailable');
  assert.equal(cardValue(tree, 'Refund ratio'), 'Unavailable');
});

test('PayPal export overview stays source-aware alongside aggregate reports and clears on blur or background', () => {
  const lifecycle = load('src/lib/report-lifecycle.ts');
  const slots = [];
  let cursor = 0;
  let blur;
  let appStateChange;
  let mounted = false;
  const react = {
    useMemo(factory) { return factory(); },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback(callback) { return callback; },
    useEffect(callback) { if (!mounted) callback(); },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  Object.assign(native, { StyleSheet: { create: (styles) => styles }, Platform: { OS: 'android' }, Keyboard: { dismiss() {} }, Linking: {}, AppState: { addEventListener(_name, callback) { appStateChange = callback; return { remove() {} }; } } });
  const customerSession = { storageFence: { capture: () => null, isCurrent: () => false }, status: 'guest', identity: null, revision: 0 };
  const screen = load('src/app/business.tsx', {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: Symbol('Fragment') },
    'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useFocusEffect(callback) { if (!blur) blur = callback(); } },
    '@/components/customer-private-boundary': {}, '@/components/customer-session-panel': {}, '@/lib/customer-session-context': { useCustomerSession: () => customerSession },
    '@/components/native-button': { NativeButton: 'NativeButton' }, '@/components/paypal-activity-panel': { PayPalActivityPanel: 'PayPalActivityPanel' },
    '@/components/business-period-comparison': { BusinessPeriodComparison: 'BusinessPeriodComparison' }, '@/components/personal-accounting-lite': { PersonalAccountingLite: 'PersonalAccountingLite' },
    '@/lib/data-context': {}, '@/lib/holding-input': {}, '@/lib/portfolio-value': {}, '@/lib/business-snapshot': snapshotLib,
    '@/lib/report-lifecycle': lifecycle, '@/lib/business-percentage': businessPercentageLib,
    '@/lib/responsive-layout': { useResponsiveLayout: () => ({ wideCanvas: false, pairedPanels: false }) },
  }).BusinessContent;
  const render = () => { cursor = 0; const tree = screen(); mounted = true; return tree; };
  const button = (tree, label) => nodes(tree).find((node) => node.type === 'NativeButton' && node.props.label === label);
  const activity = (tree) => nodes(tree).find((node) => node.type === 'PayPalActivityPanel');
  const csv = [
    'window_days,period,start_date,end_exclusive,channel,currency,transactions,gross_minor,refund_minor,source_updated_at',
    '7,previous,2026-10-23,2026-10-30,online,GBP,100,100000,2000,2026-11-06T00:00:00Z',
    '7,current,2026-10-30,2026-11-06,online,GBP,120,120000,3000,2026-11-06T00:00:00Z',
  ].join('\n');
  let tree = render();
  button(tree, 'Try fictional example').props.onPress();
  tree = render();
  assert.match(textOf(tree), /FICTIONAL EXAMPLE/);
  const staleExamplePress = button(tree, 'Try fictional example').props.onPress;
  activity(tree).props.onReportChange({ current: { included: 17 } });
  staleExamplePress();
  tree = render();
  assert.match(textOf(tree), /PAYPAL EXPORT · UNVERIFIED/);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Included checkout rows: 17. Completed credit rows · current period.'));
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Gross activity: unavailable. Not calculated from this export.'));
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === 'Refund ratio: unavailable. Not calculated from this export.'));
  assert.equal(button(tree, 'Try fictional example').props.disabled, true);
  assert.match(textOf(tree), /clear the paypal preview to explore fictional figures/i);
  assert.match(button(tree, 'Try fictional example').props.accessibilityLabel, /clear the paypal preview/i);
  assert.ok(!nodes(tree).some((node) => node.type === 'BusinessPeriodComparison'), 'A previous fictional report is hidden');
  nodes(tree).find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === 'Aggregate CSV report').props.onChangeText(csv);
  tree = render();
  nodes(tree).find((node) => node.props.accessibilityRole === 'checkbox').props.onPress();
  tree = render();
  button(tree, 'View report').props.onPress();
  tree = render();
  assert.match(textOf(tree), /AGGREGATE CSV · UNVERIFIED/);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel?.startsWith('Report activity: 120.')));
  assert.equal(button(tree, 'Try fictional example').props.disabled, true);
  assert.match(textOf(tree), /clear both reports to explore fictional figures/i);
  assert.match(button(tree, 'Try fictional example').props.accessibilityLabel, /clear both reports/i);
  button(tree, 'Clear report').props.onPress();
  tree = render();
  assert.match(textOf(tree), /PAYPAL EXPORT · UNVERIFIED/);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel?.startsWith('Included checkout rows: 17.')));
  appStateChange('background');
  tree = render();
  assert.match(textOf(tree), /ACCOUNT PREVIEW/);
  assert.ok(!nodes(tree).some((node) => node.props.accessibilityLabel?.startsWith('Included checkout rows: 17.')));
  assert.equal(button(tree, 'Try fictional example').props.disabled, false);
  button(tree, 'Try fictional example').props.onPress();
  assert.match(textOf(render()), /FICTIONAL EXAMPLE/);
  activity(tree).props.onReportChange({ current: { included: 17 } });
  assert.match(textOf(render()), /PAYPAL EXPORT · UNVERIFIED/);
  blur();
  assert.match(textOf(render()), /ACCOUNT PREVIEW/);
});
