import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(file, aliases = {}) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const componentModule = { exports: {} };
  const require = (name) => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw new Error(`Unexpected customer-session test dependency: ${name}`); };
  new Function("exports", "require", "module", compiled)(componentModule.exports, require, componentModule);
  return componentModule.exports;
}
const storage = await load("../src/lib/customer-session-storage.ts");
const events = await load("../src/lib/customer-session-events.ts", { "./customer-session-storage": storage });
const client = await load("../src/lib/customer-session-client.ts", { "./customer-session-storage": storage });
const navigation = await load("../src/lib/account-experience.ts");
const scopeA = `v1_${"A".repeat(43)}`;
const scopeB = `v1_${"B".repeat(43)}`;
const guest = { authenticated: false, loginAvailable: true };
const account = (scope = scopeA, accountType = "personal") => ({ authenticated: true, loginAvailable: true, accountType, dataScope: scope });
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function browserStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  let touches = 0;
  return { values, touches: () => touches, getItem(key) { touches++; return values.get(key) ?? null; }, setItem(key, value) { touches++; values.set(key, value); }, removeItem(key) { touches++; values.delete(key); } };
}
function requests() {
  const calls = [];
  const controller = client.createCustomerSessionController({ fetcher: (url, init) => new Promise((resolve, reject) => calls.push({ url, init, resolve, reject })) });
  return { calls, controller };
}

test("the exact session contract accepts only verified shape/type/scope combinations", () => {
  assert.deepEqual(client.parseCustomerSession(guest), guest);
  for (const type of ["personal", "business", "unknown"]) assert.deepEqual(client.parseCustomerSession(account(scopeA, type)), account(scopeA, type));
  for (const bad of [null, {}, { ...guest, authenticated: "false" }, { ...guest, dataScope: scopeA }, { ...account(), accountType: "admin" }, { ...account(), dataScope: `v1_${"x".repeat(42)}` }, { ...account(), dataScope: "guest" }, { ...account(), accessToken: "not-accepted" }]) assert.throws(() => client.parseCustomerSession(bad));
});

test("verified known account types choose only an initial presentation; unknown asks locally", () => {
  assert.equal(navigation.initialAccountExperience(null), null);
  assert.equal(navigation.initialAccountExperience(guest), "personal");
  assert.equal(navigation.initialAccountExperience(account(scopeA, "personal")), "personal");
  assert.equal(navigation.initialAccountExperience(account(scopeA, "business")), "business");
  assert.equal(navigation.initialAccountExperience(account(scopeA, "unknown")), null);
});

test("guest legacy values, identities A/B and each preference/list/plan stay separate", () => {
  const legacy = { "paypal-markets-manual-holdings-v1": "malformed legacy entry" };
  const raw = browserStore(legacy);
  const guestLease = storage.createScopeLease("guest", "guest");
  const aLease = storage.createScopeLease(scopeA, "a");
  const bLease = storage.createScopeLease(scopeB, "b");
  const a = storage.createScopedStorage(() => raw, aLease);
  const b = storage.createScopedStorage(() => raw, bLease);
  const g = storage.createScopedStorage(() => raw, guestLease);
  for (const key of ["paypal-markets-manual-holdings-v1", "paypal-markets-display-currency-v1", "paypal-markets-shopping-lists-v1", "paypal-business-monitoring-plan-v1"]) {
    assert.equal(a.getItem(key), null);
    assert.equal(b.getItem(key), null);
    a.setItem(key, `A:${key}`);
    b.setItem(key, `B:${key}`);
    assert.equal(a.getItem(key), `A:${key}`);
    assert.equal(b.getItem(key), `B:${key}`);
  }
  assert.equal(g.getItem("paypal-markets-manual-holdings-v1"), legacy["paypal-markets-manual-holdings-v1"]);
  a.removeItem("paypal-markets-manual-holdings-v1");
  assert.equal(b.getItem("paypal-markets-manual-holdings-v1"), "B:paypal-markets-manual-holdings-v1");
  assert.equal(g.getItem("paypal-markets-manual-holdings-v1"), legacy["paypal-markets-manual-holdings-v1"]);
});

test("revoked asynchronous reads/writes/removals cannot touch storage or another scope", () => {
  const raw = browserStore();
  const lease = storage.createScopeLease(scopeA, "a");
  const a = storage.createScopedStorage(() => raw, lease);
  a.setItem("holdings", "A draft");
  const pending = () => a.setItem("holdings", "late A response");
  storage.revokeScopeLease(lease);
  const count = raw.touches();
  for (const access of [pending, () => a.getItem("holdings"), () => a.removeItem("holdings")]) assert.throws(access, /suspended/);
  assert.equal(raw.touches(), count);
  assert.equal(raw.values.get(`holdings::${scopeA}`), "A draft");
  assert.equal(raw.values.has(`holdings::${scopeB}`), false);
});

test("a late A session response cannot reactivate A after B was verified", async () => {
  const { controller, calls } = requests();
  try {
    const first = controller.check();
    const second = controller.check();
    assert.equal(calls[0].init.signal.aborted, true);
    calls[1].resolve(reply(account(scopeB, "business")));
    await second;
    const b = controller.getSnapshot();
    assert.equal(b.session.dataScope, scopeB);
    calls[0].resolve(reply(account(scopeA)));
    await first;
    assert.equal(controller.getSnapshot(), b);
    assert.equal(b.lease.active, true);
  } finally { controller.dispose(); }
});

test("unknown and 503 session outcomes revoke private access rather than pretending guest", async () => {
  let response = reply(account());
  const controller = client.createCustomerSessionController({ fetcher: async () => response });
  try {
    await controller.check();
    const lease = controller.getSnapshot().lease;
    response = reply({ error: "unavailable" }, 503);
    const checking = controller.check();
    assert.equal(lease.active, false);
    assert.equal(controller.getSnapshot().status, "checking");
    await checking;
    assert.equal(controller.getSnapshot().status, "uncertain");
    assert.equal(controller.getSnapshot().session, null);
    assert.equal(controller.getSnapshot().lease, null);
  } finally { controller.dispose(); }
});

test("background checks retain the same verified lease and drafts, but revoke it on identity change/failure", async () => {
  let response = reply(account());
  const controller = client.createCustomerSessionController({ fetcher: async () => response });
  try {
    await controller.check();
    const first = controller.getSnapshot();
    response = reply(account());
    await controller.check({ background: true });
    assert.equal(controller.getSnapshot().lease, first.lease);
    assert.equal(controller.getSnapshot().epoch, first.epoch);
    response = reply(account(scopeB));
    await controller.check({ background: true });
    assert.equal(first.lease.active, false);
    const second = controller.getSnapshot().lease;
    assert.equal(second.scope, scopeB);
    response = reply({ error: "store unavailable" }, 503);
    await controller.check({ background: true });
    assert.equal(second.active, false);
    assert.equal(controller.getSnapshot().status, "uncertain");
  } finally { controller.dispose(); }
});

test("sign-out hides private data before POST, requires 204 plus fresh session, and never sets Origin itself", async () => {
  const { controller, calls } = requests();
  try {
    const initial = controller.check(); calls[0].resolve(reply(account())); await initial;
    const lease = controller.getSnapshot().lease;
    const signout = controller.logout();
    assert.equal(lease.active, false);
    assert.equal(controller.getSnapshot().status, "signing-out");
    assert.equal(calls[1].url, "/api/auth/logout");
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[1].init.credentials, "same-origin");
    assert.equal(calls[1].init.headers, undefined);
    calls[1].resolve(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
    await tick();
    assert.equal(calls[2].url, "/api/auth/session");
    assert.equal(controller.getSnapshot().status, "checking");
    calls[2].resolve(reply(guest)); await signout;
    assert.equal(controller.getSnapshot().session.authenticated, false);
    assert.equal(controller.getSnapshot().lease.scope, "guest");
  } finally { controller.dispose(); }
});

test("an uncertain sign-out keeps guest and user data hidden until an explicit successful retry", async () => {
  let phase = "auth";
  const controller = client.createCustomerSessionController({ fetcher: async (url) => url.endsWith("logout") ? phase === "failed" ? reply({ error: "uncertain" }, 503) : new Response(null, { status: 204 }) : reply(phase === "guest" ? guest : account()) });
  try {
    await controller.check(); phase = "failed"; await controller.logout();
    assert.equal(controller.getSnapshot().status, "uncertain");
    assert.equal(controller.getSnapshot().logoutUncertain, true);
    assert.equal(controller.getSnapshot().lease, null);
    phase = "guest"; await controller.logout();
    assert.equal(controller.getSnapshot().lease.scope, "guest");
  } finally { controller.dispose(); }
});

test("automatic checks and cross-tab holds cannot supersede a pending or uncertain logout", async () => {
  const { controller, calls } = requests();
  try {
    const initial = controller.check(); calls[0].resolve(reply(account())); await initial;
    const pending = controller.logout();
    await controller.check({ automatic: true }); controller.hold();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.signal.aborted, false);
    assert.equal(controller.getSnapshot().status, "signing-out");
    calls[1].resolve(reply({ error: "uncertain" }, 503)); await pending;
    controller.hold(); await controller.check({ automatic: true });
    assert.equal(calls.length, 2);
    assert.equal(controller.getSnapshot().status, "uncertain");
    assert.equal(controller.getSnapshot().logoutUncertain, true);
  } finally { controller.dispose(); }
});

test("missing no-store, oversized, malformed and stalled session replies fail closed", async () => {
  for (const response of [reply(guest, 200, { "cache-control": "max-age=10" }), reply({ ...guest, extra: "unexpected" }), reply(guest, 200, { "content-length": "9000" }), new Response("x".repeat(9000), { headers: { "cache-control": "no-store", "content-type": "application/json" } })]) {
    const controller = client.createCustomerSessionController({ fetcher: async () => response });
    await controller.check();
    assert.equal(controller.getSnapshot().status, "uncertain");
    controller.dispose();
  }
  let canceled = false;
  const controller = client.createCustomerSessionController({ fetcher: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "cache-control": "no-store", "content-type": "application/json" } }) });
  const pending = controller.check();
  await tick(); controller.hold(); await pending;
  assert.equal(canceled, true);
  assert.equal(controller.getSnapshot().status, "uncertain");
  assert.equal(controller.getSnapshot().lease, null);
  controller.dispose();
});

test("storage events and transient notices cannot cross guest/A/B or a revoked lease", () => {
  const raw = browserStore();
  const target = new EventTarget();
  const window = { localStorage: raw, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) };
  const aLease = storage.createScopeLease(scopeA, "a");
  const bLease = storage.createScopeLease(scopeB, "b");
  const a = events.createScopedEvents(() => window, aLease);
  const b = events.createScopedEvents(() => window, bLease);
  const g = events.createScopedEvents(() => window, storage.createScopeLease("guest", "g"));
  const seen = { a: [], b: [], guest: [] };
  const listeners = [];
  for (const [name, api] of [["a", a], ["b", b], ["guest", g]]) {
    const listener = (event) => seen[name].push([event.key, event.newValue]);
    api.addEventListener("storage", listener); listeners.push([api, listener]);
  }
  function send(key) { const event = new Event("storage"); Object.assign(event, { key, newValue: "fictional", oldValue: null, storageArea: raw, url: "http://local.test" }); target.dispatchEvent(event); }
  send(`holdings::${scopeA}`);
  assert.deepEqual(seen, { a: [["holdings", "fictional"]], b: [], guest: [] });
  send("holdings");
  assert.equal(seen.guest.length, 1);
  send(`reset::${scopeB}`);
  assert.deepEqual(seen.b, [["reset", "fictional"]]);
  let aReset = 0; let bReset = 0;
  a.addEventListener("paypal-markets-data-reset", () => aReset++);
  b.addEventListener("paypal-markets-data-reset", () => bReset++);
  a.dispatchEvent(new Event("paypal-markets-data-reset"));
  assert.equal(aReset, 1); assert.equal(bReset, 0);
  storage.revokeScopeLease(aLease);
  a.dispatchEvent(new Event("paypal-markets-data-reset")); send(`holdings::${scopeA}`);
  assert.equal(aReset, 1); assert.equal(seen.a.length, 1);
  for (const [api, listener] of listeners) api.removeEventListener("storage", listener);
});

function nodes(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(text).join("");
  return typeof value === "object" ? text(value.props?.children) : String(value);
}

test("Account uses a genuine fixed native POST form, preserves guest preview and offers explicit cookie recovery", async () => {
  let starts = 0; let signouts = 0;
  let current = { status: "ready", session: guest };
  const element = (type, props) => ({ type, props: props ?? {} });
  const panel = await load("../src/app/components/customer-session-panel.tsx", {
    react: { useState: (initial) => [initial, () => {}], useEffect() {} },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "./customer-session": { useCustomerSession: () => ({ state: current, beginSignIn() { starts++; }, logout() { signouts++; } }), PrivateSessionNotice: "PrivateSessionNotice" },
    "./customer-session-panel.module.css": { __esModule: true, default: {} },
  });
  let tree = panel.AccountSessionPanel({ experience: "personal", onChoose() {} });
  const form = nodes(tree).find((node) => node.type === "form");
  assert.equal(form.props.action, "/api/auth/paypal/start");
  assert.equal(form.props.method, "post");
  assert.equal(nodes(form).some((node) => node.type === "input"), false);
  form.props.onSubmit();
  assert.equal(starts, 1);
  nodes(tree).find((node) => node.type === "button" && text(node) === "Reset app sign-in").props.onClick();
  assert.equal(signouts, 1);
  current = { status: "ready", session: { ...guest, loginAvailable: false } };
  tree = panel.AccountSessionPanel({ experience: "personal", onChoose() {} });
  assert.equal(nodes(tree).some((node) => node.type === "form"), false);
  assert.match(text(tree), /guest preview remains available/);
  current = { status: "uncertain", logoutUncertain: true };
  tree = panel.AccountSessionPanel({ experience: null, onChoose() {} });
  assert.equal(nodes(tree).some((node) => node.type === "PrivateSessionNotice"), true);
  assert.equal(nodes(tree).some((node) => node.type === "form"), false);
  assert.doesNotMatch(text(tree), /GUEST PREVIEW/);
});

test("unknown-account presentation controls neither expose scope identifiers nor claim permissions", async () => {
  let choice = null;
  const element = (type, props) => ({ type, props: props ?? {} });
  const panel = await load("../src/app/components/customer-session-panel.tsx", {
    react: { useState: (initial) => [initial, () => {}], useEffect() {} },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: Symbol("Fragment") },
    "./customer-session": { useCustomerSession: () => ({ state: { status: "ready", session: account(scopeA, "unknown") }, beginSignIn() {}, logout() {} }), PrivateSessionNotice: "PrivateSessionNotice" },
    "./customer-session-panel.module.css": { __esModule: true, default: {} },
  });
  const tree = panel.AccountSessionPanel({ experience: null, onChoose: (next) => { choice = next; } });
  assert.match(text(tree), /Choose a local presentation/);
  assert.match(text(tree), /do not grant payment, wallet or reporting permissions/);
  assert.doesNotMatch(text(tree), new RegExp(scopeA));
  nodes(tree).find((node) => node.type === "button" && text(node) === "Business presentation").props.onClick();
  assert.equal(choice, "business");
});
