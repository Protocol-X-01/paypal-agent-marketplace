// Fictional clipboard content only. No OS clipboard, device, network, or files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

function load(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const requireModule = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(module.exports, requireModule, module);
  return module.exports;
}

const parser = load('src/lib/paypal-activity-import.ts');
const clipboardLib = load('src/lib/paypal-activity-clipboard.ts', { './paypal-activity-import': parser });
const lifecycle = load('src/lib/report-lifecycle.ts');
const percentage = load('src/lib/business-percentage.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const rows = [
  'Date,Time,TimeZone,Status,Transaction Event Code,Balance Impact,Transaction ID,Name',
  '23/10/2020,12:00:00,UTC,Completed,T0006,Credit,TEST0000000000001,Fictional Person',
  '30/10/2020,12:00:00,UTC,Completed,T0007,Credit,TEST0000000000002,Fictional Person',
].join('\n');

function nodes(value) {
  if (value === null || value === undefined || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  return typeof value === 'object' ? text(value.props?.children) : String(value);
}

function createPanel() {
  const slots = [];
  let cursor = 0;
  let mounted = false;
  let blur;
  let stateChange;
  let read = async () => rows;
  const reports = [];
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback(callback) { return callback; },
    useEffect(callback) { if (!mounted) callback(); },
  };
  const element = (type, props) => ({ type, props: props ?? {} });
  const native = Object.fromEntries(['Pressable', 'Switch', 'Text', 'TextInput', 'View'].map((name) => [name, name]));
  Object.assign(native, {
    StyleSheet: { create: (styles) => styles }, Platform: { OS: 'android' }, Keyboard: { dismiss() {} },
    AppState: { addEventListener(_name, callback) { stateChange = callback; return { remove() {} }; } },
  });
  const component = load('src/components/paypal-activity-panel.tsx', {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: Symbol('Fragment') },
    'react-native': native, 'expo-clipboard': { getStringAsync: () => read() },
    'expo-router': { useFocusEffect(callback) { if (!blur) blur = callback(); } },
    '@/components/native-button': { NativeButton: 'NativeButton' }, '@/lib/business-percentage': percentage,
    '@/lib/paypal-activity-clipboard': clipboardLib, '@/lib/report-lifecycle': lifecycle,
  }).PayPalActivityPanel;
  const render = () => { cursor = 0; const tree = component({ onReportChange: (report) => reports.push(report) }); mounted = true; return tree; };
  const press = (name) => { const node = nodes(render()).find((item) => item.type === 'Pressable' && item.props.accessibilityLabel === name); assert.ok(node, `Missing ${name}`); node.props.onPress(); };
  const toggle = (part, value) => { const node = nodes(render()).find((item) => item.type === 'Switch' && item.props.accessibilityLabel?.includes(part)); assert.ok(node, `Missing ${part}`); node.props.onValueChange(value); };
  const button = (label) => nodes(render()).find((item) => item.type === 'NativeButton' && item.props.label === label);
  function prepare() {
    render();
    press('Show PayPal activity preview');
    press('Day / month / year (UK)');
    press('UTC / GMT: UTC or GMT');
    press('7 days');
    nodes(render()).find((item) => item.type === 'TextInput' && item.props.accessibilityLabel === 'First day after the current period, in UTC').props.onChangeText('2020-11-06');
    toggle('I am authorized', true);
    toggle('I copied every row', true);
    assert.equal(button('Read copied text').props.disabled, false);
    reports.length = 0;
  }
  return { render, press, toggle, button, prepare, reports, setRead: (value) => { read = value; }, background: () => stateChange('background'), blur: () => blur() };
}

test('the actual native panel shares aggregate counts, retains them after a failed replacement, and clears them on criteria change', async () => {
  const panel = createPanel();
  panel.prepare();
  panel.button('Read copied text').props.onPress();
  await tick();
  assert.equal(panel.reports.length, 1);
  assert.equal(panel.reports[0].previous.included, 1);
  assert.equal(panel.reports[0].current.included, 1);
  assert.doesNotMatch(JSON.stringify(panel.reports[0]), /Fictional Person|TEST0000/);
  panel.toggle('I copied every row', true);
  panel.setRead(async () => `${rows}\n30/10/2020,13:00:00,UTC,Completed,T0006,Credit,TEST0000000000003,Fictional Person`);
  panel.button('Read copied text').props.onPress();
  await tick();
  assert.equal(panel.reports.length, 2);
  assert.equal(panel.reports[1].current.included, 2, 'A successful replacement updates the parent summary');
  panel.toggle('I copied every row', true);
  panel.setRead(async () => 'not a supported report');
  panel.button('Read copied text').props.onPress();
  await tick();
  assert.equal(panel.reports.length, 2, 'Failure keeps the parent overview unchanged');
  assert.match(text(panel.render()), /previous preview remains displayed/i);
  panel.press('UK: GMT or BST');
  assert.equal(panel.reports.at(-1), null);
  assert.doesNotMatch(text(panel.render()), /Selected PayPal checkout activity/);
});

test('background and blur clear the parent summary and fence a pending clipboard result', async () => {
  const panel = createPanel();
  panel.prepare();
  let finish;
  panel.setRead(() => new Promise((resolve) => { finish = resolve; }));
  panel.button('Read copied text').props.onPress();
  panel.background();
  assert.equal(panel.reports.at(-1), null);
  finish(rows);
  await tick();
  assert.equal(panel.reports.filter(Boolean).length, 0);
  panel.blur();
  assert.equal(panel.reports.at(-1), null);
});

test('hiding the panel discards coverage confirmation for a later clipboard read', () => {
  const panel = createPanel();
  panel.prepare();
  panel.press('Hide PayPal activity preview');
  panel.press('Show PayPal activity preview');
  const coverage = nodes(panel.render()).find((item) => item.type === 'Switch' && item.props.accessibilityLabel?.includes('I copied every row'));
  assert.equal(coverage.props.value, false);
  assert.equal(panel.button('Read copied text').props.disabled, true);
});
