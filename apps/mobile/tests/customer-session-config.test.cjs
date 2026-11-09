const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(name, deps = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', name), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function('exports', 'require', 'module', code)(m.exports, k => { if (!(k in deps)) throw Error('Unexpected dependency'); return deps[k]; }, m);
  return m.exports;
}
const scope = load('customer-storage-scope.ts');
const links = load('customer-session-links.ts', { './customer-storage-scope': scope });
const { readCustomerSessionConfiguration: read } = load('customer-session-config.ts', { './customer-session-links': links });
const env = {
  EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED: 'true', EXPO_PUBLIC_CUSTOMER_LINKS_VERIFIED: 'true',
  EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN: 'https://accounts.example.com',
  EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL: 'https://accounts.example.com/native/android',
  EXPO_PUBLIC_CUSTOMER_IOS_RETURN_URL: 'https://accounts.example.com/native/ios',
};
test('login is explicitly disabled by default and never borrows public market origin', () => {
  assert.deepEqual(read({ EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000' }), { status: 'disabled' });
  assert.deepEqual(read({ ...env, EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED: 'false' }), { status: 'disabled' });
  assert.equal(read({ ...env, EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED: 'TRUE' }).status, 'invalid');
});
test('enabled configuration requires every canonical link and verification acknowledgement', () => {
  for (const key of Object.keys(env).filter(k => k !== 'EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED')) {
    assert.equal(read({ ...env, [key]: undefined }).status, 'invalid');
  }
  assert.equal(read({ ...env, EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL: 'https://other.example.com/native/android' }).status, 'invalid');
  assert.equal(read({ ...env, EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN: 'http://localhost:3000' }).status, 'invalid');
  const result = read(env);
  assert.equal(result.status, 'ready'); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.links));
});
