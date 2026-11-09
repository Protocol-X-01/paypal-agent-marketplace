import assert from "node:assert/strict";
import test from "node:test";
import { load, config as webConfig, fixtureProvider } from "./customer-auth-fixtures.mjs";

const protocol = load("src/lib/customer-auth/native-protocol.ts");
const storeModule = load("src/lib/customer-auth/native-store.ts");
const authConfig = load("src/lib/customer-auth/config.ts");
const provider = load("src/lib/customer-auth/provider.ts", { "./config": authConfig });
const providerCallback = load("src/lib/customer-auth/provider-callback.ts");
const { createNativeAuthController } = load("src/lib/customer-auth/native-controller.ts", { "./request-budget": { consumeAuthRequestBudget: async () => ({ allowed: true, retryAfter: 60 }) }, "./provider": provider, "./provider-callback": providerCallback, "./native-store": storeModule, "./native-protocol": protocol });
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
    async claimHandoff(h, context, browser, transaction, claim) { calls.push("claim"); const r = handoffs.get(h); if (r?.context !== context || r.status !== "pending") unavailable(); Object.assign(r, { status: "claimed", browser, transaction, claim }); },
    async abortClaim(h, context, browser, claim) { calls.push("abortClaim"); const r = handoffs.get(h); if (r?.context === context && r.status === "claimed" && r.browser === browser && r.claim === claim) Object.assign(r, { status: "cancelled", browser: null, transaction: null, claim: null }); },
    async reserveProvider(h, context, browser, expected, reservation) {
      calls.push("reserve"); const r = handoffs.get(h);
      if (r?.context !== context || r.status !== "claimed" || r.browser !== browser || r.transaction.state !== expected) return null;
      const transaction = r.transaction;
      Object.assign(r, { status: "processing", reservation, transaction: null, claim: null }); return { transaction, appState: r.state, platform: r.platform };
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
    const r = await c[method](request("/unused")); assert.equal(r.status, method === "callback" ? 303 : 503); checks(r); assert.equal(r.headers.get("set-cookie"), null);
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

for (const [name, scope, requiresIssuer] of [
  ["without scope", null, true],
  ["with the documented scope list", "address openid profile email", true],
  ["with a scope and no advertised issuer", "openid", false],
  ["with a scope at the size limit", "a".repeat(1024), true],
]) {
  test(`signed native callback accepts the expected issuer ${name} without reflecting informational parameters`, async () => {
    const issuer = "https://www.sandbox.paypal.com";
    let forwarded;
    const f = setup({
      providerOptions: { metadata: { authorization_response_iss_parameter_supported: requiresIssuer } },
      complete: async (...args) => { forwarded = new URL(args[1]); return provider.completeAuthorization(...args); },
    });
    const h = await handoff(f), a = await authorize(f, h);
    const callback = new URL(`${config.origin}/api/auth/native${a.callback}`);
    if (requiresIssuer) callback.searchParams.set("iss", issuer);
    if (scope !== null) callback.searchParams.set("scope", scope);
    const r = await f.controller.callback(new Request(callback, { headers: { Cookie: a.cookie } }));
    assert.equal(r.status, 303); checks(r);
    const destination = new URL(r.headers.get("location"));
    assert.deepEqual([...destination.searchParams.keys()], ["code", "state"]);
    assert.ok(protocol.parseNativeReturnUrl(destination.href, config.links, "android", state).code);
    assert.deepEqual(forwarded.searchParams.getAll("iss"), requiresIssuer ? [issuer] : []);
    assert.equal(forwarded.searchParams.has("scope"), false);
    assert.ok(f.store.calls.includes("complete"));
    assert.ok(f.fixture.requests.some(item => item.url.endsWith("/v1/oauth2/certs")));
    assert.ok(f.fixture.requests.some(item => item.url.includes("/userinfo")));
  });
}

test("malformed informational scope and issuer parameters fail before reservation or token exchange", async () => {
  const f = setup(), h = await handoff(f), a = await authorize(f, h);
  const issuer = encodeURIComponent("https://www.sandbox.paypal.com");
  const invalid = [
    "&scope=", "&scope=openid%00email", "&scope=openid%09email", "&scope=openid++email",
    "&scope=openid%22email", "&scope=openid%5Cemail", "&scope=%C3%A9",
    `&scope=${"a".repeat(1025)}`, "&scope=openid&scope=email", "&sc%6Fpe=openid&scope=email",
    "&scope=openid&error=access_denied", `&scope=${"a".repeat(4096)}`,
    "&iss=", "&iss=https%3A%2F%2Fexample.test%0A", `&iss=${"a".repeat(2049)}`,
    `&iss=${issuer}&iss=${issuer}`, `&state=${a.providerState}`, "&code=second-code",
    "&error=", "&error_description=fictional-detail", "&error_uri=https%3A%2F%2Fexample.test",
  ];
  const requestsBefore = f.fixture.requests.length;
  for (const suffix of invalid) {
    const r = await f.controller.callback(request(a.callback + suffix, "GET", undefined, { Cookie: a.cookie }));
    assert.equal(r.status, 303, suffix); assert.equal(r.headers.get("location"), failureUrl, suffix);
    assert.equal(r.headers.get("set-cookie"), null, suffix);
    assert.equal(await r.text(), "", suffix);
  }
  const errorWithScope = new URL(`${config.origin}/api/auth/native/paypal/callback`);
  errorWithScope.searchParams.set("state", a.providerState);
  errorWithScope.searchParams.set("error", "access_denied");
  errorWithScope.searchParams.set("scope", "openid");
  const rejectedError = await f.controller.callback(new Request(errorWithScope, { headers: { Cookie: a.cookie } }));
  assert.equal(rejectedError.headers.get("location"), failureUrl);
  assert.equal(f.store.calls.includes("reserve"), false);
  assert.equal(f.fixture.requests.length, requestsBefore);
  const accepted = await f.controller.callback(request(a.callback, "GET", undefined, { Cookie: a.cookie }));
  assert.ok(protocol.parseNativeReturnUrl(accepted.headers.get("location"), config.links, "android", state).code);
});

test("native issuer and signed identity checks cannot be bypassed by informational scope", async () => {
  for (const scenario of ["wrong_issuer", "missing_required_issuer", "wrong_state", "bad_signature", "bad_nonce", "bad_subject"]) {
    const f = setup({ providerOptions: {
      metadata: { authorization_response_iss_parameter_supported: true },
      badSignature: scenario === "bad_signature",
      badNonce: scenario === "bad_nonce",
      badSubject: scenario === "bad_subject",
    } });
    const h = await handoff(f), a = await authorize(f, h);
    const callback = new URL(`${config.origin}/api/auth/native${a.callback}`);
    callback.searchParams.set("scope", "openid");
    callback.searchParams.set("returnUrl", "https://attacker.example.test/fictional");
    callback.searchParams.set("account_type", "personal");
    if (scenario !== "missing_required_issuer") callback.searchParams.set("iss", scenario === "wrong_issuer" ? "https://attacker.example.test" : "https://www.sandbox.paypal.com");
    if (scenario === "wrong_state") callback.searchParams.set("state", token(9));
    const r = await f.controller.callback(new Request(callback, { headers: { Cookie: a.cookie } }));
    assert.equal(r.status, 303, scenario); assert.equal(r.headers.get("location"), failureUrl, scenario);
    assert.equal(await r.text(), "", scenario); assert.equal(r.headers.get("set-cookie"), null, scenario);
    assert.equal(f.store.calls.includes("complete"), false, scenario);
    if (["wrong_issuer", "missing_required_issuer", "wrong_state"].includes(scenario)) assert.equal(f.fixture.requests.some(item => item.url.endsWith("/v1/oauth2/token")), false, scenario);
    else assert.ok(f.fixture.requests.some(item => item.url.endsWith("/v1/oauth2/token")), scenario);
    if (["bad_signature", "bad_subject"].includes(scenario)) assert.ok(f.fixture.requests.some(item => item.url.endsWith("/v1/oauth2/certs")), scenario);
  }
});

test("unrecognized native callback extensions cannot change the signed identity or app destination", async () => {
  let forwarded;
  const f = setup({
    providerOptions: { metadata: { authorization_response_iss_parameter_supported: true } },
    complete: async (...args) => { forwarded = new URL(args[1]); return provider.completeAuthorization(...args); },
  });
  const h = await handoff(f), a = await authorize(f, h);
  const callback = new URL(`${config.origin}/api/auth/native${a.callback}`);
  callback.searchParams.set("iss", "https://www.sandbox.paypal.com");
  callback.searchParams.set("scope", "openid");
  callback.searchParams.set("returnUrl", "https://attacker.example.test/fictional-marker");
  callback.searchParams.set("redirect_uri", "https://attacker.example.test/fictional-marker");
  callback.searchParams.set("code_verifier", "fictional-wrong-verifier");
  callback.searchParams.set("account_type", "personal");
  callback.searchParams.set("dataScope", "fictional-marker");
  callback.searchParams.set("State", token(9));
  callback.searchParams.append("extension", "fictional-marker");
  callback.searchParams.append("extension", "other-fictional-marker");
  callback.searchParams.set("__proto__", "fictional-marker");
  const r = await f.controller.callback(new Request(callback, { headers: { Cookie: a.cookie } }));
  assert.equal(r.status, 303); checks(r);
  const destination = new URL(r.headers.get("location"));
  assert.equal(`${destination.origin}${destination.pathname}`, config.links.android);
  assert.deepEqual([...destination.searchParams.keys()], ["code", "state"]);
  const returned = protocol.parseNativeReturnUrl(destination.href, config.links, "android", state);
  assert.deepEqual([...forwarded.searchParams.keys()].sort(), ["code", "iss", "state"]);
  assert.equal(forwarded.searchParams.get("iss"), "https://www.sandbox.paypal.com");
  assert.doesNotMatch(destination.href + await r.text(), /attacker|fictional-marker|personal/);
  const result = await f.controller.exchange(jsonRequest("/exchange", { handoff: h.handoff, code: returned.code, state, codeVerifier: verifier }));
  assert.equal(result.status, 200);
  const identity = await result.json();
  assert.equal(identity.accountType, "business");
  assert.match(identity.dataScope, /^v1_[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(identity), /attacker|fictional-marker|synthetic-subject|synthetic-access/);
  assert.ok(f.fixture.requests.some(item => item.url.endsWith("/v1/oauth2/certs")));
  assert.ok(f.fixture.requests.some(item => item.url.includes("/userinfo")));
});

test("unsupported authorization response fields and oversized unknowns fail before reservation", async () => {
  const f = setup(), h = await handoff(f), a = await authorize(f, h);
  const requestsBefore = f.fixture.requests.length;
  for (const name of ["response", "id_token", "access_token", "token", "token_type", "expires_in", "refresh_token"]) {
    for (const value of ["", "fictional"]) {
      const r = await f.controller.callback(request(`${a.callback}&${name}=${value}`, "GET", undefined, { Cookie: a.cookie }));
      assert.equal(r.headers.get("location"), failureUrl, name);
      assert.equal(await r.text(), "", name);
    }
  }
  for (const suffix of ["&%69d_token=fictional", `&unknown=${"a".repeat(4096)}`]) {
    const r = await f.controller.callback(request(a.callback + suffix, "GET", undefined, { Cookie: a.cookie }));
    assert.equal(r.headers.get("location"), failureUrl, suffix.slice(0, 20));
  }
  assert.equal(f.store.calls.includes("reserve"), false);
  assert.equal(f.fixture.requests.length, requestsBefore);
});

test("OAuth error details are discarded and duplicate recognized error fields fail closed", async () => {
  const f = setup(), h = await handoff(f), a = await authorize(f, h);
  const callback = new URL(`${config.origin}/api/auth/native/paypal/callback`);
  callback.searchParams.set("state", a.providerState);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "fictional-detail");
  callback.searchParams.set("error_uri", "https://attacker.example.test/fictional-detail");
  callback.searchParams.set("unrecognized", "fictional-detail");
  for (const name of ["error", "error_description", "error_uri"]) {
    const duplicate = new URL(callback); duplicate.searchParams.append(name, "fictional-duplicate");
    const r = await f.controller.callback(new Request(duplicate, { headers: { Cookie: a.cookie } }));
    assert.equal(r.headers.get("location"), failureUrl, name);
    assert.equal(f.store.calls.includes("reserve"), false, name);
  }
  const requestsBefore = f.fixture.requests.length;
  const r = await f.controller.callback(new Request(callback, { headers: { Cookie: a.cookie } }));
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), failureUrl);
  assert.equal(await r.text(), ""); assert.equal(r.headers.get("set-cookie"), null);
  assert.doesNotMatch(JSON.stringify([...r.headers]), /fictional-detail|attacker/);
  assert.equal(f.store.calls.includes("complete"), false);
  assert.equal(f.fixture.requests.length, requestsBefore);
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

test("callback rejects duplicates, conflicting errors, browser mismatch and bad signed identity without leaking provider errors", async () => {
  const f = setup(), h = await handoff(f), a = await authorize(f, h);
  for (const suffix of [`&state=${a.providerState}`, "&error=secret"]) {
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

test("global operation exhaustion preserves credentials and reserves recovery routes", async()=>{
 let outage=false;const operations=[];
 const h=setup({budget:async(_c,op)=>{operations.push(op);if(outage)throw Error('synthetic outage');return {allowed:op==='native.cancel'||op==='native.logout',retryAfter:23}}});
 for(const [name,path,method] of [['availability','/availability','GET'],['handoffs','/handoffs','POST'],['callback','/paypal/callback','GET'],['exchange','/exchange','POST'],['session','/session','GET']]){
  const r=await h.controller[name](request(path,method));assert.equal(r.status,name==='callback'?303:429);assert.equal(r.headers.get('retry-after'),'23');assert.equal(r.headers.get('set-cookie'),null);checks(r);
 }
 assert.equal(h.store.calls.length,0);
 const cancel=await h.controller.cancel(jsonRequest('/cancel',{handoff:token(12),codeVerifier:verifier}));assert.equal(cancel.status,204);
 outage=true;const r=await h.controller.session(request('/session','GET',undefined,{Authorization:'Bearer '+token(6)}));assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);
 const disabled=createNativeAuthController({config:()=>null,store(){throw Error()},provider(){throw Error()},budget(){throw Error('must not run')}});
 assert.deepEqual(await (await disabled.availability(request('/availability'))).json(),{loginAvailable:false});
 assert.ok(!operations.includes('native.cancel'));assert.ok(!operations.includes('native.logout'));
});

test('callback budget outage and busy wrapper never retain provider code in destination',async()=>{
 let release;const held=new Promise(r=>{release=r});let calls=0;
 const h=setup({budget:async()=>{calls++;await held;throw Error('outage')}});
 const req=()=>request('/paypal/callback?code=secret-code&state=secret-state');
 const pending=Array.from({length:8},()=>h.controller.callback(req()));
 const busy=await h.controller.callback(req());assert.equal(calls,8);assert.equal(busy.status,303);assert.equal(busy.headers.get('location'),failureUrl);assert.equal(busy.headers.get('set-cookie'),null);
 release();for(const r of await Promise.all(pending)){assert.equal(r.status,303);assert.equal(r.headers.get('location'),failureUrl);assert.equal(r.headers.get('set-cookie'),null);checks(r)}
 assert.equal(h.store.calls.length,0);
});

test('enabled availability requires cached provider readiness without disrupting existing session or recovery',async()=>{
 let providerDown=true,providerCalls=0,storeReady=true;
 const store=fakeStore();store.ready=async()=>storeReady;
 const h=setup({store,provider:async()=>{providerCalls++;if(providerDown)throw Error('synthetic discovery outage');return {};}});
 assert.deepEqual(await (await h.controller.availability(request('/availability'))).json(),{loginAvailable:false});
 providerDown=false;assert.deepEqual(await (await h.controller.availability(request('/availability'))).json(),{loginAvailable:true});assert.equal(providerCalls,2);
 storeReady=false;assert.deepEqual(await (await h.controller.availability(request('/availability'))).json(),{loginAvailable:false});assert.equal(providerCalls,2);
 storeReady=true;providerDown=true;
 const sessionToken=token(33);store.sessions.set(protocol.hashNativeHandle(sessionToken),{accountType:'personal',dataScope:'v1_'+token(34),expiresAt:new Date(Date.now()+60000).toISOString()});
 const session=await h.controller.session(request('/session','GET',undefined,{Authorization:'Bearer '+sessionToken}));assert.equal(session.status,200);assert.equal((await session.json()).authenticated,true);
 assert.equal((await h.controller.cancel(jsonRequest('/cancel',{handoff:token(35),codeVerifier:verifier}))).status,204);
 assert.equal((await h.controller.logout(request('/logout','POST',undefined,{Authorization:'Bearer '+sessionToken}))).status,204);
 assert.equal(providerCalls,2,'session/recovery must not discover');
 const fail=()=>{throw Error('must not run')};const disabled=createNativeAuthController({config:()=>null,store:fail,provider:fail,budget:fail});
 assert.deepEqual(await (await disabled.availability(request('/availability'))).json(),{loginAvailable:false});
 for(const mode of ['limited','database-outage']){
  const gated=setup({provider:fail,budget:async()=>{if(mode==='database-outage')throw Error('database unavailable');return{allowed:false,retryAfter:9}}});
  const r=await gated.controller.availability(request('/availability'));assert.equal(r.status,mode==='limited'?429:503);assert.equal(gated.store.calls.length,0);
 }
});

test('disabled/incomplete native callback uses fixed relative redirect despite spoofed host',async()=>{
 let calls=0;const fail=()=>{calls++;throw Error('must not run')};
 const c=createNativeAuthController({config:()=>null,budget:fail,store:fail,provider:fail});
 const r=await c.callback(new Request('https://spoofed.example/api/auth/native/paypal/callback?code=secret-code&state=secret-state',{headers:{Host:'another-attacker.example'}}));
 assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/api/auth/native/failure');assert.equal(r.headers.get('set-cookie'),null);checks(r);assert.equal(await r.text(),'');assert.equal(calls,0);
 assert.deepEqual(await (await c.availability(request('/availability'))).json(),{loginAvailable:false});
 assert.equal((await c.session(request('/session'))).status,503);assert.equal((await c.failure(request('/failure'))).status,503);
});
