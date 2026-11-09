import assert from "node:assert/strict";
import test from "node:test";
import { load, config as webConfig } from "./customer-auth-fixtures.mjs";

// This file tests controller sequencing with fictional, in-memory dependencies.
// It does not connect to a database or a provider.
const protocol = load("src/lib/customer-auth/native-protocol.ts");
class NativeStoreError extends Error {
  constructor(code) { super("fictional store error"); this.code = code; }
}
const unexpected = () => { throw new Error("Unexpected fictional provider call"); };
const { createNativeAuthController } = load("src/lib/customer-auth/native-controller.ts", {
  "./request-budget": { consumeAuthRequestBudget: async () => ({ allowed: true, retryAfter: 60 }) },
  "./provider": { beginAuthorization: unexpected, completeAuthorization: unexpected },
  "./provider-callback": {},
  "./native-store": { NativeStoreError },
  "./native-protocol": protocol,
});

const token = n => Buffer.alloc(32, n).toString("base64url");
const config = {
  ...webConfig,
  callback: `${webConfig.origin}/api/auth/native/paypal/callback`,
  contextHash: "f".repeat(64),
  links: { origin: webConfig.origin, android: `${webConfig.origin}/native/android`, ios: `${webConfig.origin}/native/ios` },
};
const handoff = token(7);
const providerTransaction = { state: token(10), nonce: token(11), verifier: token(12) };
const authorizationLocation = `https://www.sandbox.paypal.com/connect?${new URLSearchParams({ redirect_uri: config.callback })}`;

function fixture({ onClaim, onAbort } = {}) {
  const row = {
    handoffHash: protocol.hashNativeHandle(handoff), context: config.contextHash,
    status: "pending", browser: null, claimHash: null, provider: null,
    challenge: "fictional-cancellation-proof", family: "fictional-family",
  };
  const claims = [], aborts = [];
  function commit([handoffHash, context, browser, provider, claimHash]) {
    if (row.handoffHash !== handoffHash || row.context !== context || row.status !== "pending") {
      throw new NativeStoreError("unavailable");
    }
    Object.assign(row, { status: "claimed", browser, provider: { ...provider }, claimHash });
  }
  function abort([handoffHash, context, browser, claimHash]) {
    if (row.status === "claimed" && row.handoffHash === handoffHash && row.context === context &&
        row.browser === browser && row.claimHash === claimHash) {
      Object.assign(row, { status: "cancelled", provider: null, claimHash: null });
    }
  }
  const store = {
    row, claims, aborts,
    async ready() { return true; },
    async canStartHandoff(h, context) { return row.handoffHash === h && row.context === context && row.status === "pending"; },
    async claimHandoff(...args) { claims.push(args); return onClaim ? onClaim(args, commit) : commit(args); },
    async abortClaim(...args) { aborts.push(args); return onAbort ? onAbort(args, abort) : abort(args); },
  };
  const controller = createNativeAuthController({
    config: () => config,
    store: () => store,
    budget: async () => ({ allowed: true, retryAfter: 60 }),
    provider: async () => ({}),
    begin: async () => ({ location: authorizationLocation, transaction: { ...providerTransaction } }),
  });

  async function page() {
    const response = await controller.authorizeGet(new Request(`${config.origin}/api/auth/native/authorize?handoff=${handoff}`));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const body = await response.text();
    const formToken = body.match(/name="formToken" value="([A-Za-z0-9_-]+)"/)?.[1];
    assert.ok(formToken);
    const browserHandle = cookie.slice(cookie.indexOf("=") + 1).split(".")[0];
    return { cookie, form: `handoff=${handoff}&formToken=${formToken}`, browserHash: protocol.hashNativeHandle(browserHandle) };
  }
  function postRequest(p) {
    return new Request(`${config.origin}/api/auth/native/authorize`, {
      method: "POST", body: p.form,
      headers: { Origin: config.origin, Cookie: p.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    });
  }
  return { controller, store, page, postRequest };
}

function assertClaimBinding(args, browserHash) {
  assert.equal(args.length, 5);
  assert.equal(args[0], protocol.hashNativeHandle(handoff));
  assert.equal(args[1], config.contextHash);
  assert.equal(args[2], browserHash);
  assert.deepEqual(args[3], providerTransaction);
  assert.match(args[4], /^[0-9a-f]{64}$/);
}
function assertAbortBinding(args, claim) {
  assert.deepEqual(args, [claim[0], claim[1], claim[2], claim[4]]);
}
async function assertFailure(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const body = await response.text();
  assert.equal(JSON.parse(body).error.code, code);
  assert.doesNotMatch(body, /fictional|provider|acknowledgement/i);
  for (const value of Object.values(providerTransaction)) assert.equal(body.includes(value), false);
}

test("successful native authorization keeps its claim and does not run cleanup", async () => {
  const f = fixture(), p = await f.page();
  const response = await f.controller.authorizePost(f.postRequest(p));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), authorizationLocation);
  assert.match(response.headers.get("set-cookie") ?? "", /^__Host-paypal-markets-native-handoff=/);
  assert.equal(f.store.claims.length, 1);
  assertClaimBinding(f.store.claims[0], p.browserHash);
  assert.equal(f.store.aborts.length, 0);
  assert.equal(f.store.row.status, "claimed");
  assert.deepEqual(f.store.row.provider, providerTransaction);
});

test("an unavailable claim before mutation keeps the handoff pending", async () => {
  const f = fixture({ onClaim: async () => { throw new NativeStoreError("unavailable"); } });
  const p = await f.page();
  await assertFailure(await f.controller.authorizePost(f.postRequest(p)), 409, "attempt_unavailable");
  assert.equal(f.store.claims.length, 1);
  assertClaimBinding(f.store.claims[0], p.browserHash);
  assert.equal(f.store.aborts.length, 1);
  assertAbortBinding(f.store.aborts[0], f.store.claims[0]);
  assert.equal(f.store.row.status, "pending");
  assert.equal(f.store.row.provider, null);
});

test("a fictional lost claim acknowledgement cancels and scrubs only that claim", async () => {
  const f = fixture({ onClaim: async (args, commit) => { commit(args); throw new Error("fictional acknowledgement loss"); } });
  const p = await f.page();
  await assertFailure(await f.controller.authorizePost(f.postRequest(p)), 503, "sign_in_unavailable");
  assert.equal(f.store.claims.length, 1);
  assertClaimBinding(f.store.claims[0], p.browserHash);
  assert.equal(f.store.aborts.length, 1);
  assertAbortBinding(f.store.aborts[0], f.store.claims[0]);
  assert.equal(f.store.row.status, "cancelled");
  assert.equal(f.store.row.provider, null);
  assert.equal(f.store.row.family, "fictional-family");
  assert.equal(f.store.row.challenge, "fictional-cancellation-proof");
});

test("cleanup failures preserve the original generic claim response", async () => {
  for (const [claimError, status, code] of [
    [new NativeStoreError("unavailable"), 409, "attempt_unavailable"],
    [new Error("fictional claim failure"), 503, "sign_in_unavailable"],
  ]) {
    const f = fixture({ onClaim: async () => { throw claimError; }, onAbort: async () => { throw new Error("fictional cleanup failure"); } });
    const p = await f.page();
    await assertFailure(await f.controller.authorizePost(f.postRequest(p)), status, code);
    assert.equal(f.store.aborts.length, 1);
    assertAbortBinding(f.store.aborts[0], f.store.claims[0]);
    assert.equal(f.store.row.status, "pending");
  }

  const lost = fixture({
    onClaim: async (args, commit) => { commit(args); throw new Error("fictional lost acknowledgement"); },
    onAbort: async () => { throw new Error("fictional cleanup timeout"); },
  });
  const p = await lost.page();
  await assertFailure(await lost.controller.authorizePost(lost.postRequest(p)), 503, "sign_in_unavailable");
  assert.equal(lost.store.aborts.length, 1);
  assertAbortBinding(lost.store.aborts[0], lost.store.claims[0]);
  assert.equal(lost.store.row.status, "claimed", "Failed cleanup must not be reported as completed");
  assert.deepEqual(lost.store.row.provider, providerTransaction);
});

test("a redirect construction failure after claim triggers best-effort cleanup", async () => {
  const f = fixture(), p = await f.page(), request = f.postRequest(p);
  const OriginalHeaders = globalThis.Headers;
  let response;
  try {
    globalThis.Headers = class extends OriginalHeaders {
      set(name, value) {
        if (String(name).toLowerCase() === "location") throw new Error("fictional response construction failure");
        return super.set(name, value);
      }
    };
    response = await f.controller.authorizePost(request);
  } finally {
    globalThis.Headers = OriginalHeaders;
  }
  await assertFailure(response, 503, "sign_in_unavailable");
  assert.equal(f.store.aborts.length, 1);
  assertAbortBinding(f.store.aborts[0], f.store.claims[0]);
  assert.equal(f.store.row.status, "cancelled");
  assert.equal(f.store.row.provider, null);
});

test("an indeterminate concurrent loser cannot cancel the winner with the same browser and provider values", { timeout: 5000 }, async () => {
  let entered, release;
  const winnerClaimed = new Promise(resolve => { entered = resolve; });
  const winnerMayReturn = new Promise(resolve => { release = resolve; });
  let invocation = 0;
  const f = fixture({ onClaim: async (args, commit) => {
    invocation += 1;
    if (invocation === 1) { commit(args); entered(); await winnerMayReturn; return; }
    throw new Error("fictional indeterminate loser");
  } });
  const p = await f.page();
  const winner = f.controller.authorizePost(f.postRequest(p));
  try {
    await winnerClaimed;
    await assertFailure(await f.controller.authorizePost(f.postRequest(p)), 503, "sign_in_unavailable");
    assert.equal(f.store.claims.length, 2);
    const [first, second] = f.store.claims;
    assertClaimBinding(first, p.browserHash);
    assertClaimBinding(second, p.browserHash);
    assert.notEqual(first[4], second[4], "Each POST must use its own claim tag");
    assert.equal(f.store.aborts.length, 1);
    assertAbortBinding(f.store.aborts[0], second);
    assert.equal(f.store.row.status, "claimed");
    assert.equal(f.store.row.claimHash, first[4]);
    assert.deepEqual(f.store.row.provider, providerTransaction);
  } finally {
    release();
  }
  const response = await winner;
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), authorizationLocation);
  assert.match(response.headers.get("set-cookie") ?? "", /^__Host-paypal-markets-native-handoff=/);
  assert.equal(f.store.row.status, "claimed");
});
