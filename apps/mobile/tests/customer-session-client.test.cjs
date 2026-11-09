// Mocked transport only; no actual auth/provider/credential calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file, aliases = {}) { const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const m = { exports: {} }; new Function('exports', 'require', 'module', code)(m.exports, (key) => { if (Object.hasOwn(aliases, key)) return aliases[key]; throw Error('Unexpected dependency'); }, m); return m.exports; }
const links = load('customer-session-links.ts', { './customer-storage-scope': load('customer-storage-scope.ts') });
const p = load('customer-session-client.ts', { './customer-session-links': links });
const h = (n) => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/auth/android', iosReturnUrl: 'https://app.example.test/auth/ios' };
const now = 1_800_000_000_000;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const validIdentity = { accountType: 'business', dataScope: `v1_${h(7)}` };
const validSession = { authenticated: true, ...validIdentity, expiresAt: new Date(now + 1_700_000).toISOString() };
const input = { state: h(1), codeChallenge: h(2), codeChallengeMethod: 'S256', platform: 'android' };
const exchange = { handoff: h(3), code: h(4), state: h(1), codeVerifier: h(2) };
const client = (fetch, options = {}) => p.createCustomerSessionClient(config, { fetch, now: () => now, ...options });
const codeIs = (code) => (error) => error instanceof p.CustomerSessionError && error.code === code;

test('all endpoints send bounded exact-origin requests without cookies, redirects, caches or retries', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.ok(init.signal); assert.equal(init.headers['Cache-Control'], 'no-store, no-cache'); assert.equal(init.headers.Pragma, 'no-cache');
    assert.ok(url.startsWith(config.origin + '/api/auth/native/'));
    if (url.endsWith('/availability')) return json({ loginAvailable: true });
    if (url.endsWith('/handoffs')) return json({ handoff: h(3), authorizationUrl: `${config.origin}/api/auth/native/authorize?handoff=${h(3)}`, expiresIn: 300 }, 201);
    if (url.endsWith('/exchange')) return json({ sessionToken: h(5), expiresIn: 1800, ...validIdentity });
    if (url.endsWith('/session')) return json(validSession);
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await api.availability(), { loginAvailable: true });
  const handoff = await api.createHandoff(input, h(8)); assert.equal(handoff.expiresAt, now + 300_000);
  const provisional = await api.exchange(exchange); assert.equal(provisional.expiresAt, now + 1_800_000); assert.equal('authenticated' in provisional, false);
  assert.deepEqual(await api.session(h(5)), { authenticated: true, ...validIdentity, expiresAt: now + 1_700_000 });
  await api.cancel({ handoff: h(3), codeVerifier: h(2) }); await api.logout(h(5));
  assert.equal(calls.length, 6); assert.equal(calls[1].init.headers.Authorization, `Bearer ${h(8)}`); assert.equal(calls[2].init.headers.Authorization, undefined); assert.equal(calls[5].init.body, undefined);
});

test('invalid input and invalid configuration never invoke fetch', async () => {
  let count = 0; const fetch = async () => { count++; return json({}); }, api = client(fetch);
  for (const value of [{ ...input, returnUrl: 'https://evil.test' }, { ...input, platform: 'web' }, { ...input, state: h(1) + '=' }]) await assert.rejects(api.createHandoff(value), codeIs('invalid_input'));
  await assert.rejects(api.createHandoff(input, ''), codeIs('invalid_input'));
  await assert.rejects(api.exchange({ ...exchange, codeVerifier: undefined }), codeIs('invalid_input'));
  await assert.rejects(api.cancel({ handoff: h(3), codeVerifier: h(2), extra: true }), codeIs('invalid_input'));
  await assert.rejects(api.session(''), codeIs('invalid_input')); await assert.rejects(api.logout('bad'), codeIs('invalid_input'));
  assert.throws(() => p.createCustomerSessionClient({ ...config, origin: 'http://localhost:3000' }, { fetch }), codeIs('invalid_input'));
  assert.equal(count, 0);
});

test('response fields are exact and duplicate decoded JSON keys are rejected', async () => {
  const responses = [json({ loginAvailable: true, token: h(1) }), new Response('{"loginAvailable":true,"login\\u0041vailable":false}', { headers: { 'content-type': 'application/json' } }), json({ loginAvailable: 'true' }), json({ loginAvailable: { nested: true } }), new Response('{"loginAvailable":true,}', { headers: { 'content-type': 'application/json' } })];
  for (const response of responses) await assert.rejects(client(async () => response).availability(), codeIs('invalid_response'));
  await assert.rejects(client(async () => json({ handoff: h(3), authorizationUrl: `https://evil.test/?handoff=${h(3)}`, expiresIn: 300 }, 201)).createHandoff(input), codeIs('invalid_response'));
  await assert.rejects(client(async () => json({ sessionToken: h(5), expiresIn: 1801, ...validIdentity })).exchange(exchange), codeIs('invalid_response'));
});

test('session validation rejects unknown types, malformed scopes, noncanonical or expired timestamps', async () => {
  for (const changed of [{ authenticated: false }, { accountType: 'PREMIER' }, { dataScope: `v1_${h(0).slice(0, -1)}B` }, { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 1_800_001).toISOString() }, { expiresAt: '2027-02-30T00:00:00.000Z' }, { expiresAt: '2027-01-15T08:30:00Z' }, { private: 'profile' }]) await assert.rejects(client(async () => json({ ...validSession, ...changed })).session(h(5)), codeIs('invalid_response'));
  assert.equal((await client(async () => json({ ...validSession, accountType: 'unknown' })).session(h(5))).accountType, 'unknown');
});

test('provider/transport errors are generic and replay401 is not retried', async () => {
  let count = 0; const secret = `sensitive ${h(5)} https://private.test/callback?code=secret`;
  const api = client(async () => { count++; return new Response(secret, { status: 401 }); });
  await assert.rejects(api.exchange(exchange), (error) => { assert.equal(error.code, 'unauthorized'); assert.equal(error.status, 401); assert.doesNotMatch(JSON.stringify(error) + error.message, /sensitive|private.test|secret/); return true; });
  assert.equal(count, 1);
  await assert.rejects(client(async () => { throw Error(secret); }).session(h(5)), (error) => { assert.equal(error.code, 'unavailable'); assert.doesNotMatch(error.message + JSON.stringify(error), /sensitive|private.test|secret/); return true; });
  await assert.rejects(client(async () => new Response(secret, { status: 429, headers: { 'retry-after': '60' } })).availability(), (error) => error.code === 'rate_limited' && error.retryAfterSeconds === 60);
  await assert.rejects(client(async () => new Response(secret, { status: 429, headers: { 'retry-after': '9999999' } })).availability(), (error) => error.code === 'rate_limited' && error.retryAfterSeconds === undefined);
});

test('body/header/redirect limits fail closed without fallback buffering', async () => {
  for (const response of [json({ loginAvailable: true }, 200, { 'content-length': '2049' }), json({ loginAvailable: true }, 200, { 'content-length': '1' }), new Response(' '.repeat(2049), { headers: { 'content-type': 'application/json' } }), new Response('é', { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } }), new Response(null, { status: 200 }), new Response(null, { status: 302, headers: { location: 'https://evil.test' } })]) await assert.rejects(client(async () => response).availability(), (error) => error instanceof p.CustomerSessionError);
  const redirected = json({ loginAvailable: true }); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(async () => redirected).availability(), codeIs('invalid_response'));
  const wrongUrl = json({ loginAvailable: true }); Object.defineProperty(wrongUrl, 'url', { value: 'https://evil.test' });
  await assert.rejects(client(async () => wrongUrl).availability(), codeIs('invalid_response'));
});

test('deadline covers both hanging fetch and hanging body; abort is issued', async () => {
  let signal;
  await assert.rejects(client(async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 10 }).availability(), codeIs('timeout'));
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(client(async () => response, { timeoutMs: 10 }).availability(), codeIs('timeout'));
  assert.equal(cancelled, true);
});

 test('clock rollback rejects local expiry derivation and disabled availability remains false', async () => {
  assert.deepEqual(await client(async () => json({ loginAvailable: false })).availability(), { loginAvailable: false });
  let reads = 0;
  await assert.rejects(client(async () => json({ loginAvailable: true }), { now: () => reads++ === 0 ? now : now - 1 }).availability(), codeIs('invalid_response'));
});


test('Expo 204 streams must finish empty within the same deadline', async () => {
  const response = (body) => ({ status: 204, redirected: false, url: '', headers: new Headers(), body });
  await client(async () => response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array()); c.close(); } }))).logout(h(5));
  await assert.rejects(client(async () => response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(1)); c.close(); } }))).logout(h(5)), codeIs('invalid_response'));
  let cancelled = false;
  let signal;
  await assert.rejects(client(async (_url, init) => { signal = init.signal; return response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } })); }, { timeoutMs: 10 }).logout(h(5)), codeIs('timeout'));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});
