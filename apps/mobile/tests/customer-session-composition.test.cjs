// Composition proof with real client, validators, storage and manager; synthetic transport only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', 'module', code)(m.exports, k => { if (!k.startsWith('./customer-')) throw Error('Unexpected dependency'); return load(k.slice(2)); }, m);
  modules.set(name, m.exports); return m.exports;
}
const token = n => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/native/android', iosReturnUrl: 'https://app.example.test/native/ios' };
const now = 1793980800000;
const { createCustomerSessionClient } = load('customer-session-client');
const { createCustomerSessionStorage, CUSTOMER_SESSION_STORAGE_KEY } = load('customer-session-storage');
const { createCustomerSessionManager } = load('customer-session-manager');
const { createCustomerSessionRuntime } = load('customer-session-runtime');
function fixture(invalidSession = false) {
 const values = new Map([['paypal-markets.mobile.manual-holdings.secure.v1', 'untouched guest value']]);
 const calls = [];
 let sessionScope = 'v1_' + token(5);
 const adapter = { kind: 'native-secure-device-only', getItem: async k => values.get(k) ?? null, setItem: async (k, v) => values.set(k, v) };
 const storage = createCustomerSessionStorage(adapter, config, { now: () => now });
 const fetch = async (url, init) => {
  assert.ok(url.startsWith(config.origin + '/api/auth/native/'));
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.headers['Cache-Control'], 'no-store, no-cache');
  const endpoint = new URL(url).pathname.split('/').at(-1); calls.push(endpoint);
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (endpoint === 'availability') return json({ loginAvailable: true });
  if (endpoint === 'handoffs') return json({ handoff: token(3), authorizationUrl: config.origin + '/api/auth/native/authorize?handoff=' + token(3), expiresIn: 300 }, 201);
  if (endpoint === 'exchange') {
   const body = JSON.parse(init.body); assert.equal(body.codeVerifier, token(2)); assert.equal(body.state, token(1));
   return json({ sessionToken: token(8), expiresIn: 1800, accountType: 'business', dataScope: 'v1_' + token(5) });
  }
  if (endpoint === 'session') {
   assert.equal(init.headers.Authorization, 'Bearer ' + token(8));
   return json({ authenticated: true, accountType: invalidSession ? 'administrator' : 'business', dataScope: sessionScope, expiresAt: new Date(now + 1700000).toISOString() });
  }
  if (endpoint === 'logout' || endpoint === 'cancel') return new Response(null, { status: 204 });
  throw Error('Unexpected endpoint');
 };
 const client = createCustomerSessionClient(config, { fetch, now: () => now });
 const deps = { client, storage, platform: 'android', now: () => now, setTimer: () => 1, clearTimer: () => {},
  secrets: async () => ({ state: token(1), codeVerifier: token(2), codeChallenge: token(4), codeChallengeMethod: 'S256' }),
  openBrowser: async () => {
   const saved = JSON.parse(values.get(CUSTOMER_SESSION_STORAGE_KEY)); assert.equal(saved.pending.handoff, token(3));
   return { type: 'success', url: config.androidReturnUrl + '?code=' + token(6) + '&state=' + token(1) };
  },
 };
 const manager = createCustomerSessionManager(config, deps);
 return { manager, values, calls, adapter, deps, setSessionScope(value) { sessionScope = value; } };
}
test('real client/storage/manager compose sign-in, revalidation and logout without touching guest records', async () => {
 const f = fixture(); const observed = []; f.manager.subscribe(s => observed.push(s));
 await f.manager.restore(); await f.manager.start();
 assert.equal(f.manager.getState().status, 'authenticated'); assert.equal(f.manager.getState().identity.accountType, 'business');
 await f.manager.restore(); assert.equal(f.calls.filter(x => x === 'session').length, 2);
 const done = f.manager.logout(); assert.equal(f.manager.getState().status, 'holding'); await done;
 assert.equal(f.manager.getState().status, 'guest');
 assert.equal(f.values.get('paypal-markets.mobile.manual-holdings.secure.v1'), 'untouched guest value');
 assert.equal(JSON.parse(f.values.get(CUSTOMER_SESSION_STORAGE_KEY)).session, null);
 assert.ok(!JSON.stringify(observed).includes(token(8))); f.manager.dispose();
});
test('validated exchange cannot bypass invalid server identity; cancellation proof remains until cleanup', async () => {
 const f = fixture(true); await f.manager.restore(); await f.manager.start();
 assert.equal(f.manager.getState().status, 'holding');
 assert.equal(JSON.parse(f.values.get(CUSTOMER_SESSION_STORAGE_KEY)).pending.codeVerifier, token(2));
 await f.manager.retryCleanup(); assert.ok(f.calls.includes('cancel')); assert.equal(f.manager.getState().status, 'guest'); f.manager.dispose();
});
test('each runtime lease and identity is held before another runtime observes sign-out', async () => {
 const f=fixture();f.manager.dispose();
 const createRuntime=()=>createCustomerSessionRuntime({platform:'android',configuration:{status:'ready',links:config},foreground:true,
  loadNative:async()=>({...f.deps,storage:createCustomerSessionStorage(f.adapter,config,{now:()=>now})}),presence:async()=> 'present'});
 const a=createRuntime(),b=createRuntime();await a.initialize();await b.initialize();await a.start();await b.retry();
 assert.equal(a.getState().session.status,'authenticated');assert.equal(b.getState().session.status,'authenticated');
 const lease=b.storageFence.capture('portfolioSecure');let during;
 a.subscribe(state=>{if(state.session.status==='holding')during={status:b.getState().session.status,current:b.storageFence.isCurrent(lease)}});
 const out=a.logout();assert.deepEqual(during,{status:'holding',current:false});await out;
 a.dispose();b.dispose();
});
test('starting an account change holds other runtimes until they revalidate the new owner', {timeout:5000}, async () => {
 const f=fixture();f.manager.dispose();
 const createRuntime=()=>createCustomerSessionRuntime({platform:'android',configuration:{status:'ready',links:config},foreground:true,
  loadNative:async()=>({...f.deps,storage:createCustomerSessionStorage(f.adapter,config,{now:()=>now})}),presence:async()=> 'present'});
 const a=createRuntime(),b=createRuntime();await a.initialize();await b.initialize();await a.start();await b.retry();
 const lease=b.storageFence.capture('portfolioSecure'),newOwner='v1_'+token(7);f.setSessionScope(newOwner);let during,checking;
 a.subscribe(state=>{if(state.session.status==='holding'&&!during){during={status:b.getState().session.status,current:b.storageFence.isCurrent(lease)};checking=b.retry()}});
 const change=a.start();assert.deepEqual(during,{status:'holding',current:false});await Promise.all([change,checking]);
 assert.equal(a.getState().session.status,'authenticated');assert.equal(a.getState().session.identity.dataScope,newOwner);
 assert.equal(b.getState().session.status,'authenticated');assert.equal(b.getState().session.identity.dataScope,newOwner);
 a.dispose();b.dispose();
});
