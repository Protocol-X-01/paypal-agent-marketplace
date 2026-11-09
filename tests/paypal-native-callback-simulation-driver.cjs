// Invoked only by the isolated fictional Postman simulation runner.
/* eslint-disable @typescript-eslint/no-require-imports -- This fixture loads transpiled CommonJS modules. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const snapshot = path.resolve(process.argv[2] || '');
const port = Number(process.argv[3]);
assert(Number.isInteger(port) && port > 0 && port < 65536);

function load(relative, aliases = {}) {
  const source = fs.readFileSync(path.join(snapshot, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const loadedModule = { exports: {} };
  new Function('exports', 'require', 'module', code)(loadedModule.exports, (name) => {
    if (name === 'server-only') return {};
    return Object.hasOwn(aliases, name) ? aliases[name] : require(name);
  }, loadedModule);
  return loadedModule.exports;
}

const configModule = load('src/lib/customer-auth/config.ts');
const protocol = load('src/lib/customer-auth/native-protocol.ts');
const nativeStoreModule = load('src/lib/customer-auth/native-store.ts');
const webStoreModule = load('src/lib/customer-auth/store.ts');
const provider = load('src/lib/customer-auth/provider.ts', { './config': configModule });
const providerCallback = load('src/lib/customer-auth/provider-callback.ts');
const { createNativeAuthController } = load('src/lib/customer-auth/native-controller.ts', {
  './request-budget': { consumeAuthRequestBudget: async () => ({ allowed: true, retryAfter: 60 }) },
  './provider': provider, './provider-callback': providerCallback, './native-store': nativeStoreModule, './native-protocol': protocol,
});
const { createAuthController } = load('src/lib/customer-auth/controller.ts', {
  './request-budget': { consumeAuthRequestBudget: async () => ({ allowed: true, retryAfter: 60 }) },
  './config': configModule, './provider': provider, './provider-callback': providerCallback, './store': webStoreModule,
});
const { NextRequest } = require('next/server');

const origin = 'https://app.example.test';
const issuer = 'https://www.sandbox.paypal.com';
const config = {
  environment: 'sandbox', origin,
  clientId: 'fictional-client', clientSecret: 'fictional-secret',
  databaseUrl: 'postgresql://fictional:fictional@db.example.test/fictional',
  subjectHmacKey: Buffer.alloc(32, 7).toString('base64url'), accountAttributes: false,
  callback: `${origin}/api/auth/native/paypal/callback`, contextHash: 'f'.repeat(64),
  links: { origin, android: `${origin}/native/android`, ios: `${origin}/native/ios` },
};
const fixtureBase = `http://127.0.0.1:${port}/identity`;
const appState = Buffer.alloc(32, 1).toString('base64url');
const appVerifier = Buffer.alloc(32, 2).toString('base64url');
const appChallenge = protocol.nativeS256Challenge(appVerifier);
const failureUrl = `${origin}/api/auth/native/failure`;
const transportEvents = [];

function transport(input, init) {
  const url = new URL(input);
  assert(['https://www.sandbox.paypal.com', 'https://api.sandbox.paypal.com'].includes(url.origin));
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  const headers = new Headers(init.headers);
  transportEvents.push({ path: url.pathname, method: init.method ?? 'GET', authScheme: headers.get('authorization')?.split(' ')[0] ?? null });
  // Verify the actual caller's fictional authorization header here, then use
  // a fixture-only signal so credentials are not passed through Postman logs.
  if (url.pathname === '/v1/oauth2/token') {
    const basic = headers.get('authorization') ?? '';
    const pieces = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
    transportEvents.at(-1).basicChecks = { client: pieces[0] === config.clientId, secret: pieces[1] === config.clientSecret, count: pieces.length };
    assert(basic.startsWith('Basic ') && pieces.length === 2 && pieces[0] === config.clientId && pieces[1] === config.clientSecret);
    headers.delete('authorization');
    headers.set('x-fixture-client-auth', 'validated');
  }
  if (url.pathname === '/v1/oauth2/token/userinfo') {
    assert.equal(headers.get('authorization'), 'Bearer fictional-access-token');
    headers.delete('authorization');
    headers.set('x-fixture-token-auth', 'validated');
  }
  return fetch(`${fixtureBase}${url.pathname}${url.search}`, { ...init, headers });
}

function fakeStore() {
  const handoffs = new Map();
  let reservations = 0;
  return {
    handoffs, get reservations() { return reservations; },
    async ready() { return true; },
    async createHandoff(key, context, input) { handoffs.set(key, { ...input, context, status: 'pending' }); },
    async canStartHandoff(key, context) { const row = handoffs.get(key); return row?.context === context && row.status === 'pending'; },
    async claimHandoff(key, context, browser, transaction, claim) {
      const row = handoffs.get(key);
      if (!row || row.context !== context || row.status !== 'pending') throw Error('invalid fixture handoff');
      Object.assign(row, { status: 'claimed', browser, transaction, claim });
    },
    async abortClaim(key, context, browser, claim) {
      const row = handoffs.get(key);
      if (row?.context === context && row.status === 'claimed' && row.browser === browser && row.claim === claim)
        Object.assign(row, { status: 'cancelled', browser: null, transaction: null, claim: null });
    },
    async reserveProvider(key, context, browser, state, reservation) {
      reservations += 1;
      const row = handoffs.get(key);
      if (!row || row.context !== context || row.status !== 'claimed' || row.browser !== browser || row.transaction.state !== state) return null;
      const transaction = row.transaction;
      Object.assign(row, { status: 'processing', reservation, transaction: null, claim: null });
      return { transaction, appState: row.state, platform: row.platform };
    },
    async completeProvider(key, context, reservation, code, identity) {
      const row = handoffs.get(key);
      if (!row || row.context !== context || row.status !== 'processing' || row.reservation !== reservation) throw Error('invalid fixture reservation');
      Object.assign(row, { status: 'ready', code, identity });
    },
  };
}

const store = fakeStore();
const controller = createNativeAuthController({
  config: () => config, store: () => store,
  provider: (current) => provider.discoverProvider(current, transport),
});
function fakeWebStore() {
  const transactions = new Map(), sessions = new Map();
  return {
    transactions, sessions, rejectNextStart: false, rejectNextIssue: false,
    async ready() { return true; },
    async createTransaction(key, context, login, session, previous) {
      if (this.rejectNextStart) { this.rejectNextStart = false; assert(previous); throw Error('fictional prior transaction unavailable'); }
      transactions.set(key, { context, login, session, previous, status: 'pending' });
    },
    async consumeTransaction(key, context, expectedState) {
      const row = transactions.get(key);
      if (!row || row.context !== context || row.status !== 'pending' || row.login.state !== expectedState) return null;
      const claimed = row.login;
      row.status = 'processing';
      row.login = { state: '', nonce: '', verifier: '' };
      return claimed;
    },
    async createSession(key, context, identity, transaction) {
      const row = transactions.get(transaction);
      if (!row || row.context !== context || row.status !== 'processing') throw Error('invalid fictional transaction');
      if (this.rejectNextIssue) { this.rejectNextIssue = false; throw Error('fictional authority expired'); }
      row.status = 'completed';
      row.login = null;
      sessions.set(key, identity);
    },
  };
}
const webStore = fakeWebStore();
const webController = createAuthController({
  webAdmission: () => true, config: () => config, store: () => webStore,
  provider: (current) => provider.discoverProvider(current, transport),
});
function request(endpoint, method = 'GET', body, headers = {}) {
  return new Request(`${origin}/api/auth/native${endpoint}`, { method, ...(body === undefined ? {} : { body }), headers });
}
async function fixtureStats() {
  const response = await fetch(`${fixtureBase}/_fixture/stats`);
  assert.equal(response.status, 200);
  return response.json();
}
async function prepareFixture(providerUrl, callbackUrl) {
  assert.equal(providerUrl.origin, issuer);
  const prepared = await fetch(`${fixtureBase}/_fixture/prepare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: providerUrl.searchParams.get('nonce'), challenge: providerUrl.searchParams.get('code_challenge'), callback: callbackUrl }),
  });
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200, `fictional provider preparation: ${JSON.stringify(preparedBody)}`);
}
async function startAttempt() {
  const created = await controller.handoffs(request('/handoffs', 'POST', JSON.stringify({
    state: appState, codeChallenge: appChallenge, codeChallengeMethod: 'S256', platform: 'android',
  }), { 'Content-Type': 'application/json' }));
  assert.equal(created.status, 201);
  const handoff = await created.json();
  const page = await controller.authorizeGet(new Request(handoff.authorizationUrl));
  assert.equal(page.status, 200);
  const browserCookie = page.headers.get('set-cookie').split(';')[0];
  const formToken = (await page.text()).match(/name="formToken" value="([A-Za-z0-9_-]+)"/)[1];
  const authorized = await controller.authorizePost(request('/authorize', 'POST',
    `handoff=${handoff.handoff}&formToken=${formToken}`,
    { Origin: origin, Cookie: browserCookie, 'Content-Type': 'application/x-www-form-urlencoded' }));
  assert.equal(authorized.status, 303);
  const providerUrl = new URL(authorized.headers.get('location'));
  await prepareFixture(providerUrl, config.callback);
  return { state: providerUrl.searchParams.get('state'), cookie: `${browserCookie}; ${authorized.headers.get('set-cookie').split(';')[0]}` };
}
async function startWebAttempt(previousCookie = null) {
  const headers = { Origin: origin, ...(previousCookie ? { Cookie: previousCookie } : {}) };
  const response = await webController.start(new NextRequest(`${origin}/api/auth/paypal/start`, { method: 'POST', headers }));
  assert.equal(response.status, 303);
  const transaction = response.cookies.get('__Host-paypal-markets-login');
  assert(transaction?.value);
  const providerUrl = new URL(response.headers.get('location'));
  await prepareFixture(providerUrl, `${origin}/api/auth/paypal/callback`);
  return { state: providerUrl.searchParams.get('state'), cookie: `__Host-paypal-markets-login=${transaction.value}` };
}
async function webCallback(attempt, extras = []) {
  const query = new URLSearchParams([['code', 'fictional-code'], ['state', attempt.state], ...extras]);
  return webController.callback(new NextRequest(`${origin}/api/auth/paypal/callback?${query}`, { headers: { Cookie: attempt.cookie } }));
}
async function callback(attempt, extras = []) {
  const params = new URLSearchParams([['code', 'fictional-code'], ['state', attempt.state], ...extras]);
  const response = await controller.callback(request(`/paypal/callback?${params}`, 'GET', undefined, { Cookie: attempt.cookie }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  return response.headers.get('location');
}

(async () => {
  const first = await startAttempt();
  const firstLocation = await callback(first, [['scope', 'openid profile'], ['iss', issuer]]);
  const returnUrl = new URL(firstLocation);
  assert.equal(`${returnUrl.origin}${returnUrl.pathname}`, config.links.android);
  assert.deepEqual([...returnUrl.searchParams.keys()], ['code', 'state']);
  assert.equal(returnUrl.searchParams.get('state'), appState);
  assert(protocol.isCanonicalNativeHandle(returnUrl.searchParams.get('code')));
  assert(!firstLocation.includes('scope=') && !firstLocation.includes('iss='));
  const firstIdentity = [...store.handoffs.values()].find((row) => row.status === 'ready').identity;
  console.log('PASS signed fictional callback with scope and matching issuer');

  const second = await startAttempt();
  assert.equal(new URL(await callback(second, [['iss', issuer]])).pathname, '/native/android');
  console.log('PASS signed fictional callback without optional scope');

  const extra = await startAttempt();
  const extraLocation = await callback(extra, [['iss', issuer], ['returnUrl', 'https://attacker.example.test/'], ['unknown', 'fictional'], ['unknown', 'duplicate']]);
  const extraUrl = new URL(extraLocation);
  assert.equal(`${extraUrl.origin}${extraUrl.pathname}`, config.links.android);
  assert.deepEqual([...extraUrl.searchParams.keys()], ['code', 'state']);
  assert.equal(extraUrl.searchParams.get('state'), appState);
  assert(!extraLocation.includes('attacker') && !extraLocation.includes('unknown'));
  assert.deepEqual([...store.handoffs.values()].filter((row) => row.status === 'ready').at(-1).identity, firstIdentity);
  console.log('PASS unknown fields are ignored without changing identity or redirect');

  for (const [label, extra, reserves] of [
    ['duplicate scope', [['scope', 'openid'], ['scope', 'profile']], false],
    ['unsupported hybrid token', [['id_token', 'fictional']], false],
    ['control-bearing scope', [['scope', 'openid\nprofile']], false],
    ['mismatched issuer', [['iss', 'https://wrong.example.test']], true],
    ['required missing issuer', [], true],
  ]) {
    const attempt = await startAttempt();
    const before = store.reservations, stats = await fixtureStats();
    assert.equal(await callback(attempt, extra), failureUrl, label);
    assert.equal(store.reservations - before, Number(reserves), label);
    if (reserves) {
      const reserved = [...store.handoffs.values()].at(-1);
      assert.equal(reserved.status, 'processing', label);
      assert.equal(reserved.transaction, null, `${label}: fictional reserved provider values are cleared`);
    }
    assert.equal((await fixtureStats()).token, stats.token, `${label}: no token exchange`);
    console.log(`PASS ${label} fails closed without token exchange`);
  }
  const web = await startWebAttempt();
  const webResult = await webCallback(web, [['scope', 'openid profile'], ['iss', issuer], ['returnUrl', 'https://attacker.example.test/']]);
  assert.equal(webResult.status, 303);
  assert.equal(webResult.headers.get('location'), `${origin}/dashboard#account`);
  assert(webResult.cookies.get('__Host-paypal-markets-session')?.value);
  assert(!webResult.headers.get('location').includes('attacker'));
  console.log('PASS signed fictional web callback ignores extensions and keeps its fixed redirect');

  for (const [label, fields] of [
    ['web unsupported access token', [['iss', issuer], ['access_token', 'fictional']]],
    ['web mismatched issuer', [['iss', 'https://wrong.example.test']]],
  ]) {
    const attempt = await startWebAttempt();
    const before = await fixtureStats();
    const result = await webCallback(attempt, fields);
    assert.equal(result.headers.get('location'), `${origin}/dashboard?auth=failed#account`, label);
    assert.equal(result.cookies.get('__Host-paypal-markets-session'), undefined, label);
    assert.equal((await fixtureStats()).token, before.token, `${label}: no token exchange`);
    console.log(`PASS ${label} fails closed without token exchange`);
  }
  webStore.rejectNextStart = true;
  const staleCookie = `__Host-paypal-markets-login=${Buffer.alloc(32, 7).toString('base64url')}`;
  const failedStart = await webController.start(new NextRequest(`${origin}/api/auth/paypal/start`, {
    method: 'POST', headers: { Origin: origin, Cookie: staleCookie },
  }));
  assert.equal(failedStart.status, 503);
  assert.equal(failedStart.headers.get('location'), null);
  assert.equal(failedStart.cookies.get('__Host-paypal-markets-login'), undefined);
  console.log('PASS unavailable fictional prior transaction returns a generic start failure');

  const expiredIssue = await startWebAttempt();
  webStore.rejectNextIssue = true;
  const failedIssue = await webCallback(expiredIssue, [['iss', issuer]]);
  assert.equal(failedIssue.status, 303);
  assert.equal(failedIssue.headers.get('location'), `${origin}/dashboard?auth=failed#account`);
  assert.equal(failedIssue.cookies.get('__Host-paypal-markets-session'), undefined);
  const failedIssueRow = [...webStore.transactions.values()].at(-1);
  assert.equal(failedIssueRow.status, 'processing');
  assert.deepEqual(failedIssueRow.login, { state: '', nonce: '', verifier: '' });
  console.log('PASS rejected fictional session issuance redirects without a session cookie');

  const earlier = await startWebAttempt();
  const newer = await startWebAttempt(earlier.cookie);
  assert([...webStore.transactions.values()].at(-1).previous, 'newer attempt references the previous transaction');
  const beforeLate = await fixtureStats();
  const late = await webCallback({ state: earlier.state, cookie: newer.cookie }, [['iss', issuer]]);
  assert.equal(late.headers.get('location'), `${origin}/dashboard?auth=failed#account`);
  assert.equal((await fixtureStats()).token, beforeLate.token);
  const recovered = await webCallback(newer, [['iss', issuer], ['scope', 'openid']]);
  assert.equal(recovered.headers.get('location'), `${origin}/dashboard#account`);
  assert(recovered.cookies.get('__Host-paypal-markets-session')?.value);
  console.log('PASS late fictional callback does not consume the newer web attempt');
  const final = await fixtureStats();
  assert.equal(final.token, 6);
  assert.equal(final.jwks, 6);
  assert.equal(final.userinfo, 6);
  assert.equal(final.prepare, 14);
  console.log('PASS fictional provider observed exactly six token, JWKS and userinfo requests');
})().catch(async (error) => {
  console.error(`FAIL fictional native callback simulation: ${error.message}`);
  console.error(`Fictional transport: ${JSON.stringify(transportEvents)}`);
  try { console.error(`Fictional provider counts: ${JSON.stringify(await fixtureStats())}`); } catch { /* The simulation may already be down. */ }
  process.exitCode = 1;
});
