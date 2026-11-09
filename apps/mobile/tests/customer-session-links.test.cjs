const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file, aliases = {}) { const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const m = { exports: {} }; new Function('exports', 'require', 'module', code)(m.exports, (key) => { if (Object.hasOwn(aliases, key)) return aliases[key]; throw Error('Unexpected dependency'); }, m); return m.exports; }
const p = load('customer-session-links.ts', { './customer-storage-scope': load('customer-storage-scope.ts') });
const h = (n) => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/auth/android', iosReturnUrl: 'https://app.example.test/auth/ios' };
test('pure byte encoder matches canonical32bytebase64url including pad bits', () => {
  for (let n = 0; n <= 255; n++) { const bytes = Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256); assert.equal(p.encodeCustomerHandle(bytes), Buffer.from(bytes).toString('base64url')); assert.equal(p.isCanonicalCustomerHandle(p.encodeCustomerHandle(bytes)), true); }
  for (const value of [new Uint8Array(31), new Uint8Array(33), [], null]) assert.throws(() => p.encodeCustomerHandle(value));
  assert.equal(p.isCanonicalCustomerHandle(h(0).slice(0, -1) + 'B'), false);
  assert.equal(p.isCanonicalCustomerHandle(h(1) + '='), false);
});
test('config rejects localhost, ports, redirects and URL-normalization ambiguity', () => {
  assert.deepEqual(p.validateCustomerSessionLinkConfig(config), config);
  for (const origin of ['http://app.example.test', 'https://localhost', 'https://127.0.0.1', 'https://app.example.test:443', 'https://app.example.test/', 'https://a..example.test', 'https://-a.example.test']) assert.throws(() => p.validateCustomerSessionLinkConfig({ origin, androidReturnUrl: `${origin}/auth/android`, iosReturnUrl: `${origin}/auth/ios` }));
  for (const androidReturnUrl of [config.androidReturnUrl + '#', config.androidReturnUrl + '?', config.androidReturnUrl + '/..', config.androidReturnUrl.replace('/auth/', '/%61uth/'), config.androidReturnUrl.replace('app.example.test', 'evil.example.test')]) assert.throws(() => p.validateCustomerSessionLinkConfig({ ...config, androidReturnUrl }));
});
test('authorization URL is exactly fixed server path and matching handoff', () => {
  const url = `${config.origin}/api/auth/native/authorize?handoff=${h(1)}`;
  assert.equal(p.validateCustomerAuthorizationUrl(url, h(1), config), url);
  for (const bad of [url + '&handoff=' + h(1), url + '&returnUrl=https://evil.test', url + '#', url.replace('https:', 'http:'), url.replace('handoff=', 'handoff=%41'), url.replace('authorize?', 'authorize/?')]) assert.throws(() => p.validateCustomerAuthorizationUrl(bad, h(1), config));
  assert.throws(() => p.validateCustomerAuthorizationUrl(url, h(2), config));
});
test('return parsing requires exact platform path and pending state with canonical single fields', () => {
  const url = `${config.androidReturnUrl}?code=${h(2)}&state=${h(1)}`;
  assert.deepEqual(p.parseCustomerSessionReturnUrl(url, 'android', h(1), config), { code: h(2), state: h(1) });
  for (const bad of [url + '#x', url + '&state=' + h(1), url + '&extra=x', url.replace('code=', 'co%64e='), url.replace('/android?', '/android/x?'), url.replace('app.example.test', 'app.example.test.evil.test'), url + '\n']) assert.throws(() => p.parseCustomerSessionReturnUrl(bad, 'android', h(1), config));
  assert.throws(() => p.parseCustomerSessionReturnUrl(url, 'ios', h(1), config));
  assert.throws(() => p.parseCustomerSessionReturnUrl(url, 'android', h(9), config));
});
