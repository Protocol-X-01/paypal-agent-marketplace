import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { load } from './customer-auth-fixtures.mjs';

const p = load('src/lib/customer-auth/native-protocol.ts');
const handle = (byte) => Buffer.alloc(32, byte).toString('base64url');
const state = handle(1), verifier = handle(2), code = handle(3), handoff = handle(4);
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
const request = { state, codeChallenge: challenge, codeChallengeMethod: 'S256', platform: 'android' };
const exchange = { handoff, code, state, codeVerifier: verifier };
const policy = { origin: 'https://app.example.test', android: 'https://app.example.test/auth/native/android', ios: 'https://app.example.test/auth/native/ios' };
const invalid = (run) => assert.throws(run, p.NativeProtocolError);

test('32-byte handles reject alternate encodings and compare decoded material', () => {
  const value = p.newNativeHandle();
  assert.equal(p.isCanonicalNativeHandle(value), true);
  assert.equal(p.hashNativeHandle(value), createHash('sha256').update(value, 'ascii').digest('hex'));
  assert.equal(p.nativeS256Challenge(verifier), challenge);
  assert.equal(p.equalNativeHandles(state, state), true);
  assert.equal(p.equalNativeHandles(state, verifier), false);
  // Low unused pad bits differ but permissive base64url decoding yields identical bytes.
  const canonical = handle(0), alternate = canonical.slice(0, -1) + 'B';
  assert.deepEqual(Buffer.from(canonical, 'base64url'), Buffer.from(alternate, 'base64url'));
  for (const bad of [alternate, `${value}=`, ` ${value}`, value.slice(1), 'a'.repeat(44), value.replace(/./, '+'), null, {}, 1]) {
    assert.equal(p.isCanonicalNativeHandle(bad), false);
    assert.equal(p.equalNativeHandles(value, bad), false);
    invalid(() => p.hashNativeHandle(bad));
    invalid(() => p.nativeS256Challenge(bad));
  }
});

test('strict raw JSON accepts expected shapes and rejects duplicate decoded keys', () => {
  assert.deepEqual(p.parseNativeHandoffBody(JSON.stringify(request)), request);
  assert.deepEqual(p.parseNativeHandoffBody(`\n ${JSON.stringify(request)}\t`), request);
  assert.deepEqual(p.parseNativeExchangeBody(JSON.stringify(exchange)), exchange);
  assert.deepEqual(p.parseNativeCancelBody(JSON.stringify({ handoff, codeVerifier: verifier })), { handoff, codeVerifier: verifier });
  const duplicate = JSON.stringify(request).replace('"state":', `"state":"${state}","st\\u0061te":`);
  for (const raw of [duplicate, JSON.stringify({ ...request, returnUrl: 'https://evil.test' }), JSON.stringify({ ...request, platform: 'web' }), JSON.stringify({ ...request, codeChallengeMethod: 'plain' }), JSON.stringify({ ...request, state: null }), JSON.stringify({ ...request, state: {} }), JSON.stringify({ ...request, codeChallenge: verifier + '=' }), JSON.stringify(request).slice(0, -1) + ',}', `${JSON.stringify(request)}{}`, '[]', '\u00a0' + JSON.stringify(request), JSON.stringify({ ...request, platform: 'a'.repeat(2048) })]) invalid(() => p.parseNativeHandoffBody(raw));
  invalid(() => p.parseNativeExchangeBody(JSON.stringify({ ...exchange, code: undefined })));
  invalid(() => p.parseNativeCancelBody(JSON.stringify({ handoff, codeVerifier: verifier, sessionToken: state })));
  invalid(() => p.parseNativeCancelBody(`{"handoff":"${handoff}","codeVerifier":"${verifier}","codeVerifier":"${state}"}`));
});

test('flat JSON parser rejects malformed escapes, nested values and unsafe keys', () => {
  for (const raw of ['{"handoff":"\\x20"}', '{"handoff":true}', '{"handoff":42}', '{"handoff":["x"]}', '{"__proto__":"x"}', '{"constructor":"x"}', '{"handoff":"unterminated}', '{}', '{"handoff" "x"}', '{"handoff":"x" "codeVerifier":"x"}', '{"handoff":"\n"}', ' '.repeat(2049)]) invalid(() => p.parseNativeCancelBody(raw));
  // JSON escaping of a key is allowed only once; decoded values must remain canonical.
  assert.deepEqual(p.parseNativeCancelBody(`{"hand\\u006fff":"${handoff}","codeVerifier":"${verifier}"}`), { handoff, codeVerifier: verifier });
});

test('browser form parser rejects duplicate, encoded, unknown and ambiguous fields', () => {
  assert.deepEqual(p.parseNativeAuthorizeForm(`formToken=${state}&handoff=${handoff}`), { handoff, formToken: state });
  for (const value of [`handoff=${handoff}&formToken=${state}&handoff=${handoff}`, `hand%6fff=${handoff}&formToken=${state}`, `handoff=${handoff}&formToken=%41${state.slice(1)}`, `handoff=${handoff}&formToken=${state}&`, `handoff=${handoff}&formToken=${state}#x`, `handoff=${handoff}&formToken=${state}&returnUrl=x`, `handoff=${handoff}+&formToken=${state}`, `handoff=${handoff}&formToken=${state}=`, null]) invalid(() => p.parseNativeAuthorizeForm(value));
});

test('trusted link policy rejects origin normalization, arbitrary origins and unsafe paths', () => {
  assert.deepEqual(p.validateNativeLinkPolicy(policy), policy);
  assert.equal(Object.isFrozen(p.validateNativeLinkPolicy(policy)), true);
  for (const target of ['http://app.example.test/auth/native/android', 'https://evil.example.test/auth/native/android', 'https://a..example.test/auth/native/android', 'https://-a.example.test/auth/native/android', 'https://a-.example.test/auth/native/android', 'https://app.example.test:443/auth/native/android', 'https://APP.example.test/auth/native/android', 'https://user@app.example.test/auth/native/android', 'https://app.example.test/auth/../native/android', 'https://app.example.test/auth/%6eative/android', 'https://app.example.test/auth//native/android', 'https://app.example.test/auth/native/android#', 'https://app.example.test/auth/native/android?x=y', 'https://app.example.test/', `https://app.example.test/${'a'.repeat(450)}`]) invalid(() => p.validateNativeLinkPolicy({ ...policy, android: target }));
  for (const origin of ['https://app.example.test/', 'https://localhost', 'https://127.0.0.1', 'https://app.example.test:443', 'https://app.example.test.', 'https://app.example.test\n']) invalid(() => p.validateNativeLinkPolicy({ ...policy, origin }));
  for (const host of ['a..example.test', '-a.example.test', 'a-.example.test', `${'a'.repeat(64)}.example.test`, Array(5).fill('a'.repeat(60)).join('.')]) {
    const origin = `https://${host}`;
    invalid(() => p.validateNativeLinkPolicy({ origin, android: `${origin}/auth/native/android`, ios: `${origin}/auth/native/ios` }));
  }
  invalid(() => p.validateNativeLinkPolicy({ ...policy, arbitraryReturn: 'x' }));
});

test('return link matches exact configured target and state with no duplicate or unknown parameters', () => {
  const link = p.buildNativeReturnUrl(policy, 'android', code, state);
  assert.equal(link, `${policy.android}?code=${code}&state=${state}`);
  assert.deepEqual(p.parseNativeReturnUrl(link, policy, 'android', state), { code, state });
  assert.deepEqual(p.parseNativeReturnUrl(`${policy.android}?state=${state}&code=${code}`, policy, 'android', state), { code, state });
  for (const bad of [link + '#fragment', link + '&state=' + state, link + '&error=access_denied', link.replace('code=', 'co%64e='), link.replace('https:', 'paypalmarkets:'), link.replace('/android?', '/android/other?'), link.replace('app.example.test', 'app.example.test.evil.test'), link.replace('app.example.test', 'app.example.test@evil.test'), link.replace('?code=', '/?code='), link.replace('code=', 'code=%41'), link + '&', link + '\n']) invalid(() => p.parseNativeReturnUrl(bad, policy, 'android', state));
  invalid(() => p.parseNativeReturnUrl(link, policy, 'ios', state));
  invalid(() => p.parseNativeReturnUrl(link, policy, 'android', handle(9)));
  invalid(() => p.buildNativeReturnUrl(policy, 'web', code, state));
});

test('expiry constructors enforce absolute integer millisecond and remaining-lifetime bounds', () => {
  const now = 1_800_000_000_000;
  assert.equal(p.nativeHandoffExpiry(now), now + 300_000);
  assert.equal(p.nativeSessionExpiry(now), now + 1_800_000);
  assert.equal(p.nativeCodeExpiry(now, now + 300_000), now + 60_000);
  assert.equal(p.nativeCodeExpiry(now, now + 1), now + 1);
  for (const time of [-1, NaN, Infinity, 1.5, '1', Number.MAX_SAFE_INTEGER, 8_640_000_000_000_000]) {
    invalid(() => p.nativeHandoffExpiry(time)); invalid(() => p.nativeSessionExpiry(time));
  }
  for (const end of [now, now - 1, now + 300_001, Infinity, 1.5]) invalid(() => p.nativeCodeExpiry(now, end));
});

test('exchange prerequisites reject consumed/cancelled records, wrong owner binding and expired codes', () => {
  const now = 1_800_000_000_000, context = 'a'.repeat(64);
  const record = { status: 'ready', handoffExpiresAt: now + 250_000, codeExpiresAt: now + 50_000, contextHash: context, familyGeneration: 2, handoffHash: p.hashNativeHandle(handoff), codeHash: p.hashNativeHandle(code), state, codeChallenge: challenge };
  const check = (r = record, i = exchange, t = now, c = context, g = 2) => p.assertNativeExchangeReady(r, i, t, c, g);
  assert.doesNotThrow(() => check());
  for (const status of ['pending', 'authorizing', 'consumed', 'cancelled', 'superseded']) invalid(() => check({ ...record, status }));
  for (const field of ['handoff', 'code', 'state', 'codeVerifier']) invalid(() => check(record, { ...exchange, [field]: handle(9) }));
  invalid(() => check(record, exchange, record.codeExpiresAt));
  invalid(() => check({ ...record, codeExpiresAt: now + 60_001 }));
  invalid(() => check({ ...record, handoffExpiresAt: now + 300_001 }));
  invalid(() => check({ ...record, handoffExpiresAt: now + 1 }));
  invalid(() => check(record, exchange, now, 'b'.repeat(64)));
  invalid(() => check(record, exchange, now, context, 3));
  invalid(() => check(record, exchange, now, context, -1));
  invalid(() => check(record, exchange, now, context, NaN));
  invalid(() => check({ ...record, contextHash: 'A'.repeat(64) }));
  // Pure validation does not mutate a record or promise atomic replay prevention.
  assert.equal(record.status, 'ready');
});
