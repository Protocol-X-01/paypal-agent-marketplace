import assert from 'node:assert/strict';
import test from 'node:test';
import { load, config } from './customer-auth-fixtures.mjs';
const web = load('src/lib/customer-auth/config.ts');
const protocol = load('src/lib/customer-auth/native-protocol.ts');
const native = load('src/lib/customer-auth/native-config.ts', { './config': web, './native-protocol': protocol });
const valid = {
  PAYPAL_LOGIN_ENABLED: 'true', PAYPAL_ENV: config.environment,
  PAYPAL_CLIENT_ID: config.clientId, PAYPAL_CLIENT_SECRET: config.clientSecret,
  AUTH_PUBLIC_ORIGIN: config.origin, AUTH_SESSION_DATABASE_URL: config.databaseUrl,
  AUTH_SUBJECT_HMAC_KEY: config.subjectHmacKey,
  PAYPAL_NATIVE_LOGIN_ENABLED: 'true', PAYPAL_NATIVE_LINKS_VERIFIED: 'true', PAYPAL_NATIVE_EDGE_CONTROLS_VERIFIED: 'true',
  AUTH_NATIVE_ANDROID_RETURN_URL: `${config.origin}/native/android/return`,
  AUTH_NATIVE_IOS_RETURN_URL: `${config.origin}/native/ios/return`,
};
test('native config is off unless complete web configuration and all explicit gates are present', () => {
  assert.equal(native.readNativeAuthConfig({}), null);
  for (const key of Object.keys(valid)) {
    const env = { ...valid }; delete env[key]; assert.equal(native.readNativeAuthConfig(env), null, key);
  }
  for (const key of ['PAYPAL_NATIVE_LOGIN_ENABLED','PAYPAL_NATIVE_LINKS_VERIFIED','PAYPAL_NATIVE_EDGE_CONTROLS_VERIFIED']) {
    for (const value of ['TRUE','1','false']) assert.equal(native.readNativeAuthConfig({ ...valid, [key]: value }), null);
  }
  const result = native.readNativeAuthConfig(valid);
  assert.equal(result.callback, `${config.origin}/api/auth/native/paypal/callback`);
  assert.equal(result.links.android, valid.AUTH_NATIVE_ANDROID_RETURN_URL);
});
test('native context binds provider configuration and exact fixed return policy', () => {
  const base = native.readNativeAuthConfig(valid);
  assert.equal(native.readNativeAuthConfig({ ...valid }).contextHash, base.contextHash);
  for (const change of [
    { AUTH_NATIVE_ANDROID_RETURN_URL: `${config.origin}/different/android` },
    { AUTH_NATIVE_IOS_RETURN_URL: `${config.origin}/different/ios` },
    { PAYPAL_CLIENT_SECRET: 'another-fixture-secret' },
    { PAYPAL_CLIENT_ID: 'another-fixture-client' },
    { PAYPAL_ENV: 'live' },
    { AUTH_SUBJECT_HMAC_KEY: Buffer.alloc(32, 9).toString('base64url') },
    { PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES: 'true' },
  ]) assert.notEqual(native.readNativeAuthConfig({ ...valid, ...change }).contextHash, base.contextHash);
  for (const url of ['https://foreign.example.test/native/return', `${config.origin}/native/return?next=evil`, `${config.origin}/native/return#`, 'paypalmarkets://return']) {
    assert.equal(native.readNativeAuthConfig({ ...valid, AUTH_NATIVE_ANDROID_RETURN_URL: url }), null);
  }
});

test('web-only admission flags never gate native configuration or alter authentication contexts',()=>{
 const baseline=native.readNativeAuthConfig(valid);const webContext=web.authContextFingerprint(web.readAuthConfig(valid));
 for(const value of [undefined,'false','true']){
  const env={...valid,PAYPAL_WEB_EDGE_CONTROLS_VERIFIED:value,PAYPAL_WEB_CALLBACK_REDACTION_VERIFIED:value};
  assert.equal(native.readNativeAuthConfig(env).contextHash,baseline.contextHash);
  assert.equal(web.authContextFingerprint(web.readAuthConfig(env)),webContext);
 }
});
