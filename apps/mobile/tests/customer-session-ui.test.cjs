const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');
let session;
const element = (type, props, key) => ({ type, props: props ?? {}, key });
function load(name) {
 const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components', name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 const m = { exports: {} }; const deps = {
  react: { Fragment: 'Fragment' }, 'react/jsx-runtime': { jsx: element, jsxs: element },
  'react-native': { View: 'View', Text: 'Text', StyleSheet: { create: x => x } },
  '@/lib/customer-session-context': { useCustomerSession: () => session },
  './native-button': { NativeButton: 'NativeButton' },
 };
 new Function('exports', 'require', 'module', code)(m.exports, k => { if (k in deps) return deps[k]; if (k.startsWith('@/lib/')) return loadMobileAlias(k); throw Error('Unexpected dependency'); }, m); return m.exports;
}
const { CustomerPrivateBoundary } = load('customer-private-boundary.tsx');
const { CustomerSessionPanel } = load('customer-session-panel.tsx');
function nodes(x) { if (!x || typeof x !== 'object') return []; return [x, ...[x.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(x) { if (typeof x === 'string') return x; if (!x || typeof x !== 'object') return ''; return [x.props?.children].flat(Infinity).map(text).join(' '); }
test('holding boundary excludes private forms and identity revisions force fresh form instances', () => {
 const child = { type: 'PrivateForm', props: { children: 'private sample' } }; let retries = 0;
 session = { status: 'holding', revision: 1, retry: async () => { retries++; } };
 let tree = CustomerPrivateBoundary({ children: child }); assert.ok(!nodes(tree).includes(child)); assert.ok(!text(tree).includes('private sample'));
 nodes(tree).find(x => x.type === 'NativeButton').props.onPress(); assert.equal(retries, 1);
 session = { ...session, status: 'guest', revision: 2 }; tree = CustomerPrivateBoundary({ children: child }); assert.equal(tree.key, 2); assert.equal(tree.props.children, child);
 session = { ...session, status: 'authenticated', revision: 4 }; assert.equal(CustomerPrivateBoundary({ children: child }).key, 4);
});
test('account actions reflect availability and unknown type stays explicit', () => {
 let starts = 0, logouts = 0;
 session = { status: 'guest', identity: null, loginAvailable: false, start: async () => starts++, logout: async () => logouts++, retry: async () => {} };
 let tree = CustomerSessionPanel(); assert.ok(!nodes(tree).some(x => x.props?.label === 'Continue with PayPal'));
 session.loginAvailable = true; tree = CustomerSessionPanel(); nodes(tree).find(x => x.props?.label === 'Continue with PayPal').props.onPress(); assert.equal(starts, 1);
 session = { ...session, status: 'authenticated', identity: { accountType: 'unknown' } }; tree = CustomerSessionPanel(); assert.match(text(tree), /did not confirm an account type/);
 nodes(tree).find(x => x.props?.label === 'Sign out of this app').props.onPress(); assert.equal(logouts, 1);
 session = { ...session, status: 'holding', identity: null }; tree = CustomerSessionPanel(); assert.ok(!nodes(tree).some(x => x.props?.label === 'Continue with PayPal')); assert.ok(!text(tree).includes('Connected account'));
});
