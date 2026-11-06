import assert from "node:assert/strict";
import test from "node:test";
import { load, config, fixtureProvider } from "./customer-auth-fixtures.mjs";

const authConfig = load("src/lib/customer-auth/config.ts");
const provider = load("src/lib/customer-auth/provider.ts", { "./config": authConfig });

function env(overrides = {}) {
  return {
    PAYPAL_LOGIN_ENABLED: "true", PAYPAL_ENV: config.environment,
    PAYPAL_CLIENT_ID: config.clientId, PAYPAL_CLIENT_SECRET: config.clientSecret,
    AUTH_PUBLIC_ORIGIN: config.origin, AUTH_SESSION_DATABASE_URL: config.databaseUrl,
    AUTH_SUBJECT_HMAC_KEY: config.subjectHmacKey, ...overrides,
  };
}

test("configuration is disabled unless explicit secure values are present", () => {
  assert.equal(authConfig.readAuthConfig({}), null);
  assert.equal(authConfig.readAuthConfig(env({ PAYPAL_LOGIN_ENABLED: "false" })), null);
  assert.equal(authConfig.readAuthConfig(env({ PAYPAL_ENV: "surprise" })), null);
  assert.equal(authConfig.readAuthConfig(env({ AUTH_PUBLIC_ORIGIN: "http://app.example.test" })), null);
  assert.equal(authConfig.readAuthConfig(env({ AUTH_PUBLIC_ORIGIN: "https://app.example.test/path" })), null);
  assert.equal(authConfig.readAuthConfig(env({ AUTH_SESSION_DATABASE_URL: `${config.databaseUrl}?sslmode=disable` })), null);
  assert.equal(authConfig.readAuthConfig(env({ AUTH_SUBJECT_HMAC_KEY: "short" })), null);
  assert.equal(authConfig.readAuthConfig(env({ PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES: "yes" })), null);
  assert.equal(authConfig.readAuthConfig(env())?.origin, config.origin);
});

async function flow(options = {}) {
  const fixture = fixtureProvider(options);
  const client = await provider.discoverProvider(config, fixture.transport);
  const start = await provider.beginAuthorization(client, config);
  const state = fixture.acceptAuthorization(start.location);
  const callback = new URL(`${config.origin}/api/auth/paypal/callback?code=fixture-code&state=${state}`);
  return { fixture, client, start, callback };
}

test("valid signed code flow binds PKCE, state, nonce and subject and returns only pseudonymous identity", async () => {
  const { fixture, client, start, callback } = await flow();
  const identity = await provider.completeAuthorization(client, callback, start.transaction, config);
  assert.equal(identity.accountType, "business");
  assert.match(identity.dataScope, /^v1_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(identity).sort(), ["accountType", "dataScope"]);
  assert.ok(!JSON.stringify(identity).includes("synthetic-subject"));
  assert.ok(fixture.requests.some((request) => request.url.endsWith("/v1/oauth2/certs")));
  assert.ok(fixture.requests.some((request) => request.url.includes("/userinfo")));
  const again = await provider.completeAuthorization(client, callback, start.transaction, config);
  assert.equal(again.dataScope, identity.dataScope);
  const changedKey = { ...config, subjectHmacKey: Buffer.alloc(32, 8).toString("base64url") };
  const changed = await provider.completeAuthorization(client, callback, start.transaction, changedKey);
  assert.notEqual(changed.dataScope, identity.dataScope);
});

test("provider account-type values are conservative", async () => {
  assert.equal(provider.normalizeAccountType("PERSONAL"), "personal");
  assert.equal(provider.normalizeAccountType("PREMIER"), "unknown");
  assert.equal(provider.normalizeAccountType("BUSINESS"), "business");
  for (const value of [null, undefined, "business", "FUTURE", 0]) assert.equal(provider.normalizeAccountType(value), "unknown");
  const { client, start, callback } = await flow({ accountType: null });
  assert.equal((await provider.completeAuthorization(client, callback, start.transaction, config)).accountType, "unknown");
});

test("data scopes are stable but separated by subject, issuer, environment, client and key", () => {
  const issuer = "https://www.sandbox.paypal.com";
  const scope = provider.deriveDataScope(config, issuer, "subject-a");
  assert.equal(provider.deriveDataScope(config, issuer, "subject-a"), scope);
  assert.notEqual(provider.deriveDataScope(config, issuer, "subject-b"), scope);
  assert.notEqual(provider.deriveDataScope(config, "https://www.paypal.com", "subject-a"), scope);
  assert.notEqual(provider.deriveDataScope({ ...config, environment: "live" }, issuer, "subject-a"), scope);
  assert.notEqual(provider.deriveDataScope({ ...config, clientId: "another-client" }, issuer, "subject-a"), scope);
  assert.notEqual(provider.deriveDataScope({ ...config, subjectHmacKey: Buffer.alloc(32, 9).toString("base64url") }, issuer, "subject-a"), scope);
});

for (const [issue, expectedCode] of Object.entries({
  badSignature: "OAUTH_INVALID_RESPONSE", badNonce: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  badAudience: "OAUTH_JWT_CLAIM_COMPARISON_FAILED", badIssuer: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  expired: "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", missingIdToken: "OAUTH_INVALID_RESPONSE",
  badSubject: "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
})) {
  test(`rejects synthetic ${issue} without producing an application identity`, async () => {
    const { fixture, client, start, callback } = await flow({ [issue]: true });
    await assert.rejects(provider.completeAuthorization(client, callback, start.transaction, config), { code: expectedCode });
    assert.ok(fixture.requests.some((request) => request.url.endsWith("/v1/oauth2/token")));
    if (issue === "badSignature" || issue === "badSubject") assert.ok(fixture.requests.some((request) => request.url.endsWith("/v1/oauth2/certs")));
    assert.equal(fixture.requests.some((request) => request.url.includes("/userinfo")), issue === "badSubject");
  });
}

test("rejects incorrect callback state and verifier", async () => {
  const { client, start, callback } = await flow();
  callback.searchParams.set("state", "wrong-state");
  await assert.rejects(provider.completeAuthorization(client, callback, start.transaction, config));
  const other = await flow();
  await assert.rejects(provider.completeAuthorization(other.client, other.callback, { ...other.start.transaction, verifier: "wrong-verifier" }, config));
});

test("untrusted, cross-environment or incomplete discovery metadata fails closed", async () => {
  for (const changed of [
    { issuer: "https://www.paypal.com" },
    { token_endpoint: "https://api.paypal.com/v1/oauth2/token" },
    { jwks_uri: "https://api.sandbox.paypal.com/other" },
    { code_challenge_methods_supported: ["plain"] },
    { id_token_signing_alg_values_supported: ["HS256"] },
  ]) {
    const fixture = fixtureProvider({ metadata: changed });
    await assert.rejects(provider.discoverProvider(config, fixture.transport));
    assert.equal(fixture.requests.length, 1, "No token or userinfo request follows invalid discovery");
  }
});

test("oversized declared and streamed identity responses are canceled", async () => {
  let declaredCanceled = false;
  const declaredBody = new ReadableStream({ cancel() { declaredCanceled = true; } });
  await assert.rejects(provider.discoverProvider(config, async () => new Response(declaredBody, {
    headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) },
  })));
  assert.equal(declaredCanceled, true);

  let streamCanceled = false;
  const oversizedBody = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { streamCanceled = true; },
  });
  await assert.rejects(provider.discoverProvider(config, async () => new Response(oversizedBody, {
    headers: { "content-type": "application/json" },
  })));
  assert.equal(streamCanceled, true);
});


test("native callback uses the same signed identity checks without crossing web callback boundaries", async () => {
  const fixture = fixtureProvider({ callbackPath: "/api/auth/native/paypal/callback" });
  const client = await provider.discoverProvider(config, fixture.transport);
  const start = await provider.beginAuthorization(client, config, "native");
  assert.equal(new URL(start.location).searchParams.get("redirect_uri"), `${config.origin}/api/auth/native/paypal/callback`);
  const state = fixture.acceptAuthorization(start.location);
  const callback = new URL(`${config.origin}/api/auth/native/paypal/callback?code=fixture-code&state=${state}`);
  const before = fixture.requests.length;
  await assert.rejects(provider.completeAuthorization(client, callback, start.transaction, config), /Unexpected identity callback/);
  assert.equal(fixture.requests.length, before);
  const identity = await provider.completeAuthorization(client, callback, start.transaction, config, "native");
  assert.equal(identity.accountType, "business");
  assert.match(identity.dataScope, /^v1_[A-Za-z0-9_-]{43}$/);
  for (const wrong of [`https://other.example.test${callback.pathname}${callback.search}`, `${config.origin}/api/auth/paypal/callback${callback.search}`, `${callback.href}#fragment`]) {
    const count = fixture.requests.length;
    await assert.rejects(provider.completeAuthorization(client, new URL(wrong), start.transaction, config, "native"), /Unexpected identity callback/);
    assert.equal(fixture.requests.length, count);
  }
  await assert.rejects(provider.beginAuthorization(client, config, "https://evil.example.test"), /Unsupported identity surface/);
});
