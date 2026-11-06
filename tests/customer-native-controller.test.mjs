import assert from "node:assert/strict";
import test from "node:test";
import { load, config as webConfig, fixtureProvider } from "./customer-auth-fixtures.mjs";

const protocol = load("src/lib/customer-auth/native-protocol.ts");
const storeModule = load("src/lib/customer-auth/native-store.ts");
const authConfig = load("src/lib/customer-auth/config.ts");
const provider = load("src/lib/customer-auth/provider.ts", { "./config": authConfig });
const { createNativeAuthController } = load("src/lib/customer-auth/native-controller.ts", { "./provider": provider, "./native-store": storeModule, "./native-protocol": protocol });
const token = n => Buffer.alloc(32, n).toString("base64url");
const config = { ...webConfig, links: { origin: webConfig.origin, android: `${webConfig.origin}/native/android`, ios: `${webConfig.origin}/native/ios` }, callback: `${webConfig.origin}/api/auth/native/paypal/callback`, contextHash: "f".repeat(64) };
const state = token(1), verifier = token(2), challenge = protocol.nativeS256Challenge(verifier);
const request = (path, method = "GET", body, headers = {}) => new Request(`${config.origin}/api/auth/native${path}`, { method, ...(body !== undefined ? { body } : {}), headers });
const jsonRequest = (path, value, headers) => request(path, "POST", JSON.stringify(value), { "Content-Type": "application/json", ...headers });
const newBody = () => ({ state, codeChallenge: challenge, codeChallengeMethod: "S256", platform: "android" });
const failureUrl = `${config.origin}/api/auth/native/failure`;
const handoffCookieName = "__Host-paypal-markets-native-handoff";
function checks(r) { assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("referrer-policy"), "no-referrer"); assert.equal(r.headers.get("access-control-allow-origin"), null); }

// Only controller sequencing is mocked here; real atomic race/quota behavior has
// its own isolated PostgreSQL fixture. Provider signatures/PKCE use real library.
function fakeStore() {
  const handoffs = new Map(), sessions = new Map(); const calls = [];
  const unavailable = () => { throw new storeModule.NativeStoreError("unavailable"); };
  return {
    handoffs, sessions, calls,
    async ready() { calls.push("ready"); return true; },
    async createHandoff(h, context, input, prior) { calls.push("create"); handoffs.set(h, { ...input, context, prior, status: "pending" }); },
    async canStartHandoff(h, context) { const r = handoffs.get(h); return r?.context === context && r.status === "pending"; },
    async claimHandoff(h, context, browser, transaction) { calls.push("claim"); const r = handoffs.get(h); if (r?.context !== context || r.status !== "pending") unavailable(); Object.assign(r, { status: "claimed", browser, transaction }); },
    async reserveProvider(h, context, browser, expected, reservation) {
      calls.push("reserve"); const r = handoffs.get(h);
      if (r?.context !== context || r.status !== "claimed" || r.browser !== browser || r.transaction.state !== expected) return null;
      Object.assign(r, { status: "processing", reservation }); return { transaction: r.transaction, appState: r.state, platform: r.platform };
    },
    async completeProvider(h, context, reservation, code, identity) { calls.push("complete"); const r = handoffs.get(h); if (r?.context !== context || r.status !== "processing" || r.reservation !== reservation) unavailable(); Object.assign(r, { status: "ready", code, identity }); },
    async exchange(h, context, input) { calls.push("exchange"); const r = handoffs.get(h); if (r?.context !== context || r.status !== "ready" || r.code !== input.codeHash || r.state !== input.state || r.challenge !== protocol.nativeS256Challenge(input.verifier)) unavailable(); r.status = "exchanged"; r.session = input.sessionHash; const result = { ...r.identity, expiresAt: new Date(Date.now() + 1800000).toISOString() }; sessions.set(input.sessionHash, result); return result; },
    async cancel(h, context, v) { calls.push("cancel"); const r = handoffs.get(h); if (!r) return true; if (r.context !== context || r.challenge !== protocol.nativeS256Challenge(v)) return false; r.status = "cancelled"; if (r.session) sessions.delete(r.session); return true; },
    async readSession(h) { calls.push("session"); return sessions.get(h) ?? null; },
    async logout(h) { calls.push("logout"); sessions.delete(h); return true; },
    async close() {},
  };
}
function setup(overrides = {}) {
  const store = overrides.store ?? fakeStore();
  const fixture = fixtureProvider({ callbackPath: "/api/auth/native/paypal/callback", ...overrides.providerOptions });
  let discovers = 0;
  const controller = createNativeAuthController({ config: () => config, store: () => store, provider: async c => { discovers++; return provider.discoverProvider(c, fixture.transport); }, ...overrides, store: () => store });
  return { store, fixture, controller, discovers: () => discovers };
}
async function handoff(f) {
  const created = await f.controller.handoffs(jsonRequest("/handoffs", newBody())); checks(created); assert.equal(created.status, 201);
  const entry = await created.json(); assert.equal(entry.expiresIn, 300); assert.equal(new URL(entry.authorizationUrl).origin, config.origin);
  const page = await f.controller.authorizeGet(new Request(entry.authorizationUrl)); assert.equal(page.status, 200); checks(page);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  assert.match(page.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Lax/);
  const text = await page.text(); assert.ok(text.length < 16384); assert.doesNotMatch(text, /<script|<img|https:\/\//);
  const formToken = text.match(/name="formToken" value="([A-Za-z0-9_-]+)"/)[1];
  return { ...entry, cookie, formToken, form: `handoff=${entry.handoff}&formToken=${formToken}` };
}
async function authorize(f, h) {
  const r = await f.controller.authorizePost(request("/authorize", "POST", h.form, { Origin: config.origin, Cookie: h.cookie, "Content-Type": "application/x-www-form-urlencoded" }));
  assert.equal(r.status, 303); checks(r); const location = r.headers.get("location");
  const providerState = f.fixture.acceptAuthorization(location);
  const cookie = `${h.cookie}; ${r.headers.get("set-cookie").split(";")[0]}`;
  return { cookie, providerState, callback: `/paypal/callback?code=fixture-code&state=${providerState}` };
}

test("disabled routes fail closed without store/provider calls", async () => {
  const fail = () => { throw Error("must not run"); };
  const c = createNativeAuthController({ config: () => null, store: fail, provider: fail });
  const available = await c.availability(request("/availability")); assert.deepEqual(await available.json(), { loginAvailable: false }); checks(available);
  for (const method of ["handoffs", "authorizeGet", "authorizePost", "callback", "exchange", "cancel", "session", "logout", "failure"]) {
    const r = await c[method](request("/unused")); assert.equal(r.status, 503); checks(r); assert.equal(r.headers.get("set-cookie"), null);
  }
});

test("native system-browser flow validates signed provider and returns only one-use code then opaque app session", async () => {
  const f = setup(), h = await handoff(f); assert.equal(f.discovers(), 0, "GET never starts provider authorization");
  const a = await authorize(f, h);
  assert.equal((await f.controller.authorizePost(request("/authorize", "POST", h.form, { Origin: config.origin, Cookie: h.cookie, "Content-Type": "application/x-www-form-urlencoded" }))).status, 409);
  const r = await f.controller.callback(request(a.callback, "GET", undefined, { Cookie: a.cookie })); assert.equal(r.status, 303); checks(r);
  const link = protocol.parseNativeReturnUrl(r.headers.get("location"), config.links, "android", state);
  assert.deepEqual([...new URL(r.headers.get("location")).searchParams.keys()], ["code", "state"]);
  assert.equal(r.headers.get("set-cookie"), null, "Delayed callback must not overwrite a newer browser cookie");
  assert.equal((await f.controller.callback(request(a.callback, "GET", undefined, { Cookie: a.cookie }))).headers.get("location"), failureUrl);
  const body = { handoff: h.handoff, code: link.code, state, codeVerifier: verifier };
  const exchanged = await f.controller.exchange(jsonRequest("/exchange", body)); assert.equal(exchanged.status, 200); checks(exchanged);
  const session = await exchanged.json(); assert.deepEqual(Object.keys(session).sort(), ["accountType", "dataScope", "expiresIn", "sessionToken"]); assert.equal(session.accountType, "business"); assert.equal(session.expiresIn, 1800); assert.ok(protocol.isCanonicalNativeHandle(session.sessionToken));
  assert.doesNotMatch(JSON.stringify(session), /synthetic-subject|synthetic-access|fixture-secret|id_token/);
  assert.equal((await f.controller.exchange(jsonRequest("/exchange", body))).status, 401);
  const read = await f.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${session.sessionToken}` })); assert.equal(read.status, 200); assert.equal((await read.json()).authenticated, true);
  const cookieOnly = await f.controller.session(request("/session", "GET", undefined, { Cookie: `__Host-paypal-markets-session=${session.sessionToken}` })); assert.equal(cookieOnly.status, 401);
  const logout = await f.controller.logout(request("/logout", "POST", undefined, { Authorization: `Bearer ${session.sessionToken}` })); assert.equal(logout.status, 204); assert.equal(await logout.text(), "");
  assert.equal((await f.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${session.sessionToken}` }))).status, 401);
});

test("browser form binds cookie, handoff, context, origin and expiry", async () => {
  let clock = Date.now(); const f = setup({ now: () => clock }), h = await handoff(f), other = await handoff(f);
  const send = (form = h.form, cookie = h.cookie, origin = config.origin) => f.controller.authorizePost(request("/authorize", "POST", form, { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }));
  assert.equal((await send(h.form, h.cookie, "https://foreign.example.test")).status, 403);
  assert.equal((await send(h.form, "")).status, 403);
  assert.equal((await send(h.form, other.cookie)).status, 403);
  assert.equal((await send(`handoff=${other.handoff}&formToken=${h.formToken}`)).status, 403);
  assert.equal((await send(h.form, `${h.cookie}; ${h.cookie}`)).status, 403);
  const parts = h.cookie.split("."); parts[1] = String(clock + 600000); assert.equal((await send(h.form, parts.join("."))).status, 403);
  const changed = setup({ store: f.store, config: () => ({ ...config, contextHash: "e".repeat(64) }) });
  assert.equal((await changed.controller.authorizePost(request("/authorize", "POST", h.form, { Origin: config.origin, Cookie: h.cookie, "Content-Type": "application/x-www-form-urlencoded" }))).status, 403);
  clock += 300001; assert.equal((await send()).status, 403); assert.equal(f.discovers(), 0);
});

test("strict body, query and bearer validation rejects malformed input before side effects", async () => {
  const f = setup();
  assert.equal((await f.controller.handoffs(request("/handoffs", "POST", JSON.stringify(newBody()), { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await f.controller.handoffs(request("/handoffs", "POST", "x".repeat(2049), { "Content-Type": "application/json" }))).status, 413);
  assert.equal((await f.controller.handoffs(request("/handoffs", "POST", JSON.stringify(newBody()).replace('{', '{"state":"'+state+'",'), { "Content-Type": "application/json" }))).status, 400);
  assert.equal((await f.controller.handoffs(jsonRequest("/handoffs", { ...newBody(), returnUrl: "https://evil.test/" }))).status, 400);
  assert.equal((await f.controller.handoffs(jsonRequest("/handoffs", newBody(), { Authorization: `Bearer ${token(10)}` }))).status, 401);
  assert.equal((await f.controller.handoffs(jsonRequest("/handoffs", newBody(), { Authorization: "invalid" }))).status, 401);
  assert.equal((await f.controller.authorizeGet(request(`/authorize?handoff=${token(8)}&handoff=${token(9)}`))).status, 400);
  assert.equal((await f.controller.authorizeGet(request(`/authorize?handoff=${token(8)}&returnUrl=https://evil.test`))).status, 400);
  assert.equal((await f.controller.failure(request("/failure?message=secret"))).status, 400);
  assert.equal((await f.controller.logout(request("/logout", "POST", "x", { Authorization: `Bearer ${token(10)}` }))).status, 413);
  assert.equal(f.store.calls.includes("create"), false); assert.equal(f.discovers(), 0);
});

test("callback rejects duplicates, unknown fields, browser mismatch and bad signed identity without leaking provider errors", async () => {
  const f = setup(), h = await handoff(f), a = await authorize(f, h);
  for (const suffix of [`&state=${a.providerState}`, "&returnUrl=https://evil.test", "&error=secret"]) {
    const r = await f.controller.callback(request(a.callback + suffix, "GET", undefined, { Cookie: a.cookie })); assert.equal(r.headers.get("location"), failureUrl); assert.doesNotMatch(await r.text(), /secret/);
  }
  assert.equal((await f.controller.callback(request(a.callback))).headers.get("location"), failureUrl);
  const other = await handoff(f); assert.equal((await f.controller.callback(request(a.callback, "GET", undefined, { Cookie: `${other.cookie}; ${handoffCookieName}=${h.handoff}` }))).headers.get("location"), failureUrl);
  const bad = setup({ providerOptions: { badSignature: true } }), badH = await handoff(bad), badA = await authorize(bad, badH);
  assert.equal((await bad.controller.callback(request(badA.callback, "GET", undefined, { Cookie: badA.cookie }))).headers.get("location"), failureUrl);
  assert.equal(bad.store.calls.includes("complete"), false);
});

test("cancellation uses verifier and store failures never report successful revocation", async () => {
  const f = setup(), h = await handoff(f);
  assert.equal((await f.controller.cancel(jsonRequest("/cancel", { handoff: h.handoff, codeVerifier: token(9) }))).status, 401);
  assert.equal((await f.controller.cancel(jsonRequest("/cancel", { handoff: h.handoff, codeVerifier: verifier }))).status, 204);
  assert.equal((await f.controller.authorizeGet(new Request(h.authorizationUrl))).status, 400);
  f.store.cancel = async () => { throw Error("fixture database secret"); };
  const r = await f.controller.cancel(jsonRequest("/cancel", { handoff: h.handoff, codeVerifier: verifier })); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /fixture database secret/);
  f.store.logout = async () => { throw Error("fixture database secret"); };
  assert.equal((await f.controller.logout(request("/logout", "POST", undefined, { Authorization: `Bearer ${token(9)}` }))).status, 503);
});

test("body deadline and independent concurrency limits release after failure", { timeout: 6000 }, async () => {
  const f = setup();
  const stream = new ReadableStream({ start() {}, cancel() {} });
  const stalled = new Request(`${config.origin}/api/auth/native/handoffs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" });
  const r = await f.controller.handoffs(stalled); assert.equal(r.status, 503); assert.equal(f.store.calls.includes("create"), false);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const blockedStore = fakeStore(); blockedStore.readSession = async () => { await pending; return null; };
  const blocked = setup({ store: blockedStore }); const attempts = Array.from({ length: 16 }, () => blocked.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${token(9)}` })));
  const busy = await blocked.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${token(9)}` })); assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "60");
  release(); await Promise.all(attempts); assert.equal((await blocked.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${token(9)}` }))).status, 401);
});

test("cancellation during provider completion cannot produce an app return code", async () => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { finish = resolve; });
  const f = setup({ complete: async (...args) => { started(); await paused; return provider.completeAuthorization(...args); } });
  const h = await handoff(f), a = await authorize(f, h);
  const callback = f.controller.callback(request(a.callback, "GET", undefined, { Cookie: a.cookie }));
  await entered;
  assert.equal((await f.controller.cancel(jsonRequest("/cancel", { handoff: h.handoff, codeVerifier: verifier }))).status, 204);
  finish(); const response = await callback;
  assert.equal(response.headers.get("location"), failureUrl);
  assert.equal(f.store.sessions.size, 0);
});

test("provider redirects are constrained to exact PayPal hosts, paths and native callback", async () => {
  for (const location of [
    `https://evil.example.test/signin/authorize?redirect_uri=${encodeURIComponent(config.callback)}`,
    `https://www.sandbox.paypal.com/not-authorize?redirect_uri=${encodeURIComponent(config.callback)}`,
    `https://www.sandbox.paypal.com/signin/authorize?redirect_uri=${encodeURIComponent(config.origin + '/api/auth/paypal/callback')}`,
  ]) {
    const f = setup({ begin: async () => ({ location, transaction: { state: token(20), nonce: token(21), verifier: token(22) } }) });
    const h = await handoff(f);
    const r = await f.controller.authorizePost(request("/authorize", "POST", h.form, { Origin: config.origin, Cookie: h.cookie, "Content-Type": "application/x-www-form-urlencoded" }));
    assert.equal(r.status, 503); assert.equal(r.headers.get("location"), null); assert.equal(f.store.calls.includes("claim"), false);
  }
});

test("authoritative absent credentials are terminal without granting session access", async () => {
  const f = setup();
  assert.equal((await f.controller.session(request("/session", "GET", undefined, { Authorization: `Bearer ${token(29)}` }))).status, 401);
  for (let i = 0; i < 2; i++) {
    const logout = await f.controller.logout(request("/logout", "POST", undefined, { Authorization: `Bearer ${token(29)}` }));
    assert.equal(logout.status, 204); assert.equal(await logout.text(), ""); checks(logout);
    const cancel = await f.controller.cancel(jsonRequest("/cancel", { handoff: token(28), codeVerifier: verifier }));
    assert.equal(cancel.status, 204); checks(cancel);
  }
  assert.equal(f.discovers(), 0);
});
