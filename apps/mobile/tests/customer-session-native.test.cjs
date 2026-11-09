const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, aliases = {}) { const m = { exports: {} }; new Function('exports', 'require', 'module', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(m.exports, k => { if (Object.hasOwn(aliases, k)) return aliases[k]; throw Error(k); }, m); return m.exports; }
const links = load('customer-session-links.ts', { './customer-storage-scope': load('customer-storage-scope.ts') });
const storage = load('customer-session-storage.ts', { './customer-session-links': links });
const h = n => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/auth/android', iosReturnUrl: 'https://app.example.test/auth/ios' };
const input = { authorizationUrl: config.origin + '/api/auth/native/authorize?handoff=' + h(1), handoff: h(1), state: h(2) };
function setup(os = 'android', version = '17.4') {
  const calls = [], platform = { OS: os, Version: version };
  let result = { type: 'cancel' };
  const fetch = () => {};
  const secure = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 9, isAvailableAsync: async () => true, getItemAsync: async (...args) => { calls.push(['get', ...args]); return null; }, setItemAsync: async (...args) => { calls.push(['set', ...args]); } };
  const secureModule = load('customer-session-secure-native.ts', { 'react-native': { Platform: platform }, 'expo-secure-store': secure, './customer-session-storage': storage });
  const mod = load('customer-session-native.ts', { './customer-session-secure-native': secureModule, 'react-native': { Platform: platform }, 'expo/fetch': { fetch }, 'expo-secure-store': secure, 'expo-web-browser': { dismissAuthSession: () => calls.push(['dismiss']), openAuthSessionAsync: async (...args) => { calls.push(['browser', ...args]); return await result; } }, './customer-session-client': { createCustomerSessionClient: (config, deps) => ({ config, deps }) }, './customer-session-storage': { classifyCustomerSessionStoragePresence: storage.classifyCustomerSessionStoragePresence, CUSTOMER_SESSION_STORAGE_KEY: 'paypal-markets.mobile.native-auth.secure.v1', createCustomerSessionStorage: adapter => ({ adapter }) }, './customer-session-links': links });
  return { mod, calls, secure, fetch, platform, result: value => { result = value; } };
}
test('native secure adapter singleton restricts key/value and uses explicit accessibility', async () => {
  const s = setup(), a = s.mod.createNativeCustomerSessionAdapters(config), b = s.mod.createNativeCustomerSessionAdapters(config);
  assert.equal(a.storage.adapter, b.storage.adapter); assert.equal(a.client.deps.fetch, s.fetch);
  const key = 'paypal-markets.mobile.native-auth.secure.v1';
  await a.storage.adapter.setItem(key, '{}'); await a.storage.adapter.getItem(key);
  assert.deepEqual(s.calls[0], ['set', key, '{}', { keychainAccessible: 9 }]);
  await assert.rejects(a.storage.adapter.getItem('other'));
  await assert.rejects(a.storage.adapter.setItem(key, 'a'.repeat(1901)));
  assert.equal(s.calls.length, 2);
  s.secure.getItemAsync = async () => { throw Error('secret-token'); };
  await assert.rejects(a.storage.adapter.getItem(key), e => e.message === 'Native sign-in is unavailable.');
});
test('web is rejected without storage/network/browser fallback', async () => {
  const s = setup('web'); assert.throws(() => s.mod.createNativeCustomerSessionAdapters(config));
  await assert.rejects(s.mod.customerSessionSecureAdapter.getItem('paypal-markets.mobile.native-auth.secure.v1'));
  assert.equal(s.calls.length, 0);
});
test('browser validates exact authorization and return state and uses iOS HTTPS option', async () => {
  const s = setup('ios'), a = s.mod.createNativeCustomerSessionAdapters(config);
  s.result({ type: 'success', url: config.iosReturnUrl + '?code=' + h(3) + '&state=' + h(2) });
  assert.equal((await a.openBrowser(input)).type, 'success');
  assert.deepEqual(s.calls[0], ['browser', input.authorizationUrl, config.iosReturnUrl, { preferUniversalLinks: true }]);
  await assert.rejects(a.openBrowser({ ...input, authorizationUrl: 'https://evil.test' }));
  s.result({ type: 'success', url: config.iosReturnUrl + '?code=' + h(3) + '&state=' + h(4) });
  await assert.rejects(a.openBrowser(input));
  for (const type of ['cancel', 'dismiss']) { s.result({ type }); assert.deepEqual(await a.openBrowser(input), { type }); }
  s.platform.Version = '17.3'; await assert.rejects(a.openBrowser(input));
});
test('browser concurrency blocked across adapter instances; no secret error forwarding', async () => {
  const s = setup(); let finish; s.result(new Promise(resolve => { finish = resolve; }));
  const a = s.mod.createNativeCustomerSessionAdapters(config), b = s.mod.createNativeCustomerSessionAdapters(config);
  const pending = a.openBrowser(input); await assert.rejects(b.openBrowser(input));
  finish({ type: 'cancel' }); await pending;
  s.result({ type: 'success', url: 'secret' }); await assert.rejects(b.openBrowser(input), e => e.message === 'Native sign-in is unavailable.');
});

test('disabled-config presence check exposes only validated emptiness', async () => {
  const s = setup(); assert.equal(await s.mod.readNativeCustomerSessionPresence(), 'empty');
  for (const value of ['', 'corrupt', 'secret-token']) {
    s.secure.getItemAsync = async () => value;
    assert.equal(await s.mod.readNativeCustomerSessionPresence(), 'present');
  }
  s.secure.getItemAsync = async () => JSON.stringify({ version: 1, binding: 'old-config', session: null, pending: null, revocations: [] });
  assert.equal(await s.mod.readNativeCustomerSessionPresence(), 'empty');
  s.secure.getItemAsync = async () => { throw Error('secret-token'); };
  assert.equal(await s.mod.readNativeCustomerSessionPresence(), 'unavailable');
  assert.equal(await setup('web').mod.readNativeCustomerSessionPresence(), 'unavailable');
});


test('local dismissal unblocks cleanup but retains native busy lease until Expo settles', async () => {
  for (const os of ['android', 'ios']) {
    const s = setup(os); let finish; s.result(new Promise(resolve => { finish = resolve; }));
    const a = s.mod.createNativeCustomerSessionAdapters(config), b = s.mod.createNativeCustomerSessionAdapters(config);
    const pending = a.openBrowser(input);
    b.dismissBrowser(); assert.equal(s.calls.filter(c => c[0] === 'dismiss').length, 0);
    a.dismissBrowser(); assert.deepEqual(await pending, { type: 'dismiss' });
    assert.equal(s.calls.filter(c => c[0] === 'dismiss').length, os === 'ios' ? 1 : 0);
    await assert.rejects(b.openBrowser(input));
    finish({ type: 'success', url: 'late-invalid-secret' }); await Promise.resolve(); await Promise.resolve();
    s.result({ type: 'cancel' }); assert.deepEqual(await b.openBrowser(input), { type: 'cancel' });
  }
});


test('browser capability denies old or unknown iOS before any native action', async () => {
  for (const version of ['16.7', '17', '17.3.9', '', '17.4beta', '17.4.0.extra', null, undefined, 17.4]) {
    const s = setup('ios'); s.platform.Version = version;
    const a = s.mod.createNativeCustomerSessionAdapters(config);
    assert.equal(a.canStartSignIn(), false);
    await assert.rejects(a.openBrowser(input));
    assert.deepEqual(s.calls, []);
  }
  for (const version of ['17.4', '17.4.1', '18', '18.0']) {
    const s = setup('ios', version), a = s.mod.createNativeCustomerSessionAdapters(config);
    assert.equal(a.canStartSignIn(), true);
    assert.deepEqual(await a.openBrowser(input), { type: 'cancel' });
  }
  const s = setup('android', 35);
  assert.equal(s.mod.createNativeCustomerSessionAdapters(config).canStartSignIn(), true);
});
