import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { load, config, fixtureProvider, fakeStore } from "./customer-auth-fixtures.mjs";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server");
const configModule = load("src/lib/customer-auth/config.ts");
const providerModule = load("src/lib/customer-auth/provider.ts", { "./config": configModule });
const storeModule = load("src/lib/customer-auth/store.ts");
const { createAuthController } = load("src/lib/customer-auth/controller.ts", {
  "./config": configModule, "./provider": providerModule, "./store": storeModule,
});
const SESSION = "__Host-paypal-markets-session";
const TRANSACTION = "__Host-paypal-markets-login";

function request(path, { method = "GET", origin, cookies = {} } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  if (cookie) headers.set("Cookie", cookie);
  return new NextRequest(`${config.origin}${path}`, { method, headers });
}

async function harness(options = {}) {
  const fixture = fixtureProvider(options);
  const store = fakeStore();
  const client = await providerModule.discoverProvider(config, fixture.transport);
  let providerAvailable = true;
  let activeConfig = config;
  const controller = createAuthController({
    config: () => activeConfig,
    store: () => store,
    provider: async () => { if (!providerAvailable) throw new Error("synthetic provider unavailable"); return client; },
  });
  return { controller, store, fixture, setProviderAvailable(value) { providerAvailable = value; }, setConfig(value) { activeConfig = value; } };
}

async function signIn(h, previousSession) {
  const start = await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin, cookies: previousSession ? { [SESSION]: previousSession } : {} }));
  assert.equal(start.status, 303);
  assert.equal(start.headers.get("cache-control"), "no-store");
  const transaction = start.cookies.get(TRANSACTION);
  assert.equal(transaction?.secure, true);
  assert.equal(transaction?.httpOnly, true);
  assert.equal(transaction?.sameSite, "lax");
  assert.equal(transaction?.path, "/");
  const state = h.fixture.acceptAuthorization(start.headers.get("location"));
  const callbackCookies = { [TRANSACTION]: transaction.value, ...(previousSession ? { [SESSION]: previousSession } : {}) };
  const callback = await h.controller.callback(request(`/api/auth/paypal/callback?code=fixture-code&state=${state}`, { cookies: callbackCookies }));
  return { start, callback, transaction, state };
}

test("disabled configuration reports no login availability without touching a provider", async () => {
  const controller = createAuthController({ config: () => null, store() { throw Error("must not run"); }, provider() { throw Error("must not run"); } });
  const result = await controller.session(request("/api/auth/session"));
  assert.deepEqual(await result.json(), { authenticated: false, loginAvailable: false });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin }))).status, 503);
});

test("same-origin enforcement blocks login and logout before provider or store operations", async () => {
  const h = await harness();
  const initial = h.fixture.requests.length;
  for (const origin of [undefined, "https://other.example.test", "null"]) {
    const start = await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin }));
    const logout = await h.controller.logout(request("/api/auth/logout", { method: "POST", origin }));
    assert.equal(start.status, 403);
    assert.equal(logout.status, 403);
    assert.equal(start.headers.get("cache-control"), "no-store");
  }
  assert.equal(h.fixture.requests.length, initial);
  assert.equal(h.store.transactions.size, 0);
});

test("a successful synthetic login creates a protected revocable session without returning provider data", async () => {
  const h = await harness();
  assert.deepEqual(await (await h.controller.session(request("/api/auth/session"))).json(), { authenticated: false, loginAvailable: true });
  const { callback, transaction, state } = await signIn(h);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), `${config.origin}/dashboard#account`);
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal(callback.cookies.get(TRANSACTION), undefined, "A delayed callback must not erase a newer transaction cookie");
  const session = callback.cookies.get(SESSION);
  assert.equal(session?.secure, true);
  assert.equal(session?.httpOnly, true);
  assert.equal(session?.sameSite, "lax");
  assert.equal(session?.path, "/");
  assert.equal(session?.maxAge, 1800);
  const status = await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: session.value } }));
  const body = await status.json();
  assert.deepEqual(Object.keys(body).sort(), ["accountType", "authenticated", "dataScope", "loginAvailable"]);
  assert.equal(body.authenticated, true);
  assert.equal(body.accountType, "business");
  assert.match(body.dataScope, /^v1_[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-subject|synthetic-access-token|fixture-secret/);
  assert.doesNotMatch(JSON.stringify([...h.store.sessions]), /synthetic-subject|synthetic-access-token|fixture-secret/);
  const replay = await h.controller.callback(request(`/api/auth/paypal/callback?code=fixture-code&state=${state}`, { cookies: { [TRANSACTION]: transaction.value } }));
  assert.equal(replay.headers.get("location"), `${config.origin}/dashboard?auth=failed#account`);
  assert.equal(replay.cookies.get(SESSION), undefined);
  const logout = await h.controller.logout(request("/api/auth/logout", { method: "POST", origin: config.origin, cookies: { [SESSION]: session.value } }));
  assert.equal(logout.status, 204);
  assert.equal(logout.cookies.get(SESSION)?.maxAge, 0);
  const after = await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: session.value } }));
  assert.deepEqual(await after.json(), { authenticated: false, loginAvailable: true });
});

test("unavailable dependencies never turn an unverified cookie into a signed-out assertion", async () => {
  const h = await harness();
  h.store.available = false;
  const blank = await h.controller.session(request("/api/auth/session"));
  assert.deepEqual(await blank.json(), { authenticated: false, loginAvailable: false });
  const possibleCookie = Buffer.alloc(32, 4).toString("base64url");
  const unknown = await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: possibleCookie } }));
  assert.equal(unknown.status, 503);
  assert.equal((await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin }))).status, 503);
  assert.equal((await h.controller.logout(request("/api/auth/logout", { method: "POST", origin: config.origin, cookies: { [SESSION]: possibleCookie } }))).status, 503);
});

test("provider outage stops new sign-ins without invalidating an existing app session", async () => {
  const h = await harness();
  const { callback } = await signIn(h);
  const handle = callback.cookies.get(SESSION).value;
  h.setProviderAvailable(false);
  const existing = await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: handle } }));
  assert.deepEqual({ ...(await existing.json()), dataScope: "redacted" }, { authenticated: true, loginAvailable: false, accountType: "business", dataScope: "redacted" });
  assert.equal((await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin }))).status, 503);
});

test("sign-in rotates an existing session and retains the stable application data scope", async () => {
  const h = await harness();
  const first = await signIn(h);
  const firstHandle = first.callback.cookies.get(SESSION).value;
  const before = await (await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: firstHandle } }))).json();
  const second = await signIn(h, firstHandle);
  const secondHandle = second.callback.cookies.get(SESSION).value;
  assert.notEqual(firstHandle, secondHandle);
  const old = await (await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: firstHandle } }))).json();
  const current = await (await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: secondHandle } }))).json();
  assert.equal(old.authenticated, false);
  assert.equal(current.authenticated, true);
  assert.equal(current.dataScope, before.dataScope);
});

test("changing the authentication context invalidates an earlier session", async () => {
  const h = await harness();
  const first = await signIn(h);
  const firstHandle = first.callback.cookies.get(SESSION).value;
  h.setConfig({ ...config, clientId: "another-client" });
  const after = await (await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: firstHandle } }))).json();
  assert.equal(after.authenticated, false);
  const start = await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin, cookies: { [SESSION]: firstHandle } }));
  assert.equal(start.status, 503, "An existing cookie cannot silently become a guest login under another context");
});

test("sign-out cancels an in-flight callback even if a newer transaction cookie is supplied", async () => {
  let pauseToken = async () => {};
  const h = await harness({ pauseToken: () => pauseToken() });
  const first = await signIn(h);
  const firstHandle = first.callback.cookies.get(SESSION).value;
  const start = () => h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin, cookies: { [SESSION]: firstHandle } }));
  const a = await start();
  const b = await start();
  const stateA = h.fixture.acceptAuthorization(a.headers.get("location"));
  let resume;
  let reached;
  const waiting = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  pauseToken = async () => { reached(); await waiting; };
  const pending = h.controller.callback(request(`/api/auth/paypal/callback?code=fixture-code&state=${stateA}`, { cookies: { [SESSION]: firstHandle, [TRANSACTION]: a.cookies.get(TRANSACTION).value } }));
  await started;
  const logout = await h.controller.logout(request("/api/auth/logout", { method: "POST", origin: config.origin, cookies: { [SESSION]: firstHandle, [TRANSACTION]: b.cookies.get(TRANSACTION).value } }));
  assert.equal(logout.status, 204);
  resume();
  const callback = await pending;
  assert.equal(callback.headers.get("location"), `${config.origin}/dashboard?auth=failed#account`);
  assert.equal(callback.cookies.get(SESSION), undefined);
  const late = await start();
  assert.equal(late.status, 503, "A late start carrying a revoked session cannot become a guest transaction");
});

test("sign-out with a rotated cookie invalidates its successor even if the callback response arrives later", async () => {
  const h = await harness();
  const first = await signIn(h);
  const old = first.callback.cookies.get(SESSION).value;
  const start = () => h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin, cookies: { [SESSION]: old } }));
  const a = await start();
  const b = await start();
  const stateA = h.fixture.acceptAuthorization(a.headers.get("location"));
  const completedButDelayed = await h.controller.callback(request(`/api/auth/paypal/callback?code=fixture-code&state=${stateA}`, { cookies: { [SESSION]: old, [TRANSACTION]: a.cookies.get(TRANSACTION).value } }));
  const successor = completedButDelayed.cookies.get(SESSION).value;
  assert.equal(completedButDelayed.cookies.get(TRANSACTION), undefined);
  const logout = await h.controller.logout(request("/api/auth/logout", { method: "POST", origin: config.origin, cookies: { [SESSION]: old, [TRANSACTION]: b.cookies.get(TRANSACTION).value } }));
  assert.equal(logout.status, 204);
  const deliveredAfterLogout = await h.controller.session(request("/api/auth/session", { cookies: { [SESSION]: successor } }));
  assert.equal((await deliveredAfterLogout.json()).authenticated, false);
});

test("start capacity is bounded separately from sign-out and releases after completion", async () => {
  const h = await harness();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  h.store.ready = async () => blocked;
  const pending = Array.from({ length: 8 }, () => h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin })));
  const excess = await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin }));
  assert.equal(excess.status, 503);
  assert.equal((await h.controller.logout(request("/api/auth/logout", { method: "POST", origin: config.origin }))).status, 204);
  release(false);
  assert.ok((await Promise.all(pending)).every((response) => response.status === 503));
  h.store.ready = async () => true;
  assert.equal((await h.controller.start(request("/api/auth/paypal/start", { method: "POST", origin: config.origin }))).status, 303);
});

test("invalid signed identity and an unbound callback never establish a session", async () => {
  const h = await harness({ badSignature: true });
  const result = await signIn(h);
  assert.equal(result.callback.headers.get("location"), `${config.origin}/dashboard?auth=failed#account`);
  assert.equal(result.callback.cookies.get(SESSION), undefined);
  assert.equal(h.store.sessions.size, 0);
  const before = h.fixture.requests.length;
  const unbound = await h.controller.callback(request("/api/auth/paypal/callback?code=fixture-code&state=unbound"));
  assert.equal(unbound.headers.get("location"), `${config.origin}/dashboard?auth=failed#account`);
  assert.equal(h.fixture.requests.length, before);
});
