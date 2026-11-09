// Pure synthetic tests: no Expo API, saved data, device or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/customer-storage-scope.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, () => { throw new Error('Unexpected runtime dependency'); }, loaded);
const p = loaded.exports;
const scopeA = `v1_${Buffer.alloc(32, 1).toString('base64url')}`;
const scopeB = `v1_${Buffer.alloc(32, 2).toString('base64url')}`;
const ownerA = { kind: 'owner', dataScope: scopeA }, ownerB = { kind: 'owner', dataScope: scopeB }, guest = { kind: 'guest' };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('canonical scopes reject alternate pad bits, versions and delimiters', () => {
  for (let n = 0; n <= 255; n++) assert.equal(p.isCanonicalCustomerDataScope(`v1_${Buffer.alloc(32, n).toString('base64url')}`), true);
  const zero = `v1_${Buffer.alloc(32).toString('base64url')}`;
  for (const bad of [zero.slice(0, -1) + 'B', scopeA + '=', ` ${scopeA}`, scopeA.replace('v1_', 'v2_'), scopeA.slice(1), scopeA + '.other', null, {}, 3]) assert.equal(p.isCanonicalCustomerDataScope(bad), false);
});
test('guest keys remain byte-identical; owner destinations are separate and SecureStore-safe', () => {
  const expected = { portfolioSecure: 'paypal-markets.mobile.manual-holdings.secure.v1', legacyPortfolio: 'paypal-markets.mobile.manual-holdings.v1', venmoContacts: 'paypal-markets.venmo-contacts.v1', channel3Collections: 'paypal-markets.mobile.channel3-collections.v1' };
  for (const [resource, key] of Object.entries(expected)) {
    assert.equal(p.privateStorageKey(resource, guest), key);
    assert.equal(p.privateStorageKey(resource, { kind: 'hold' }), null);
    if (resource === 'legacyPortfolio') { assert.equal(p.privateStorageKey(resource, ownerA), null); continue; }
    const owned = p.privateStorageKey(resource, ownerA);
    assert.equal(owned, `${key.slice(0, -3)}.owner.${scopeA}.v1`);
    assert.match(owned, /^[A-Za-z0-9._-]+$/);
    assert.notEqual(owned, key);
    assert.notEqual(owned, p.privateStorageKey(resource, ownerB));
  }
  for (const key of ['displayCurrency', '__proto__', 'constructor']) assert.throws(() => p.privateStorageKey(key, guest));
  assert.throws(() => p.privateStorageKey('portfolioSecure', { kind: 'owner', dataScope: 'invalid' }));
  assert.throws(() => p.privateStorageKey('portfolioSecure', { kind: 'guest', dataScope: scopeA }));
});
test('public preference/cache keys cannot be routed through private owner scoping', () => {
  assert.deepEqual(p.PUBLIC_STORAGE_KEYS, { displayCurrency: 'paypal-markets.mobile.display-currency.v1', shopStorefront: 'paypal-markets.mobile.shop-storefront.v1' });
  assert.equal(p.publicOverviewCacheKey('GBP'), 'paypal-markets.mobile.market-overview.v2.GBP');
  assert.equal(p.publicChartCacheKey('USD', 'bitcoin-cash', 7), 'paypal-markets.mobile.chart.USD.bitcoin-cash.7.v2');
  for (const v of ['USD.owner.fake', 'usd', scopeA, null]) assert.throws(() => p.publicOverviewCacheKey(v));
  for (const v of ['bitcoin.owner.fake', '../bitcoin', '', null]) assert.throws(() => p.publicChartCacheKey('GBP', v, 7));
  for (const v of ['7', 3, NaN, Infinity]) assert.throws(() => p.publicChartCacheKey('GBP', 'bitcoin', v));
  assert.throws(() => p.createCustomerStorageFence(ownerA).capture(p.PUBLIC_STORAGE_KEYS.displayCurrency));
});
test('hold, A-B-A, guest return and same-owner refresh revoke all earlier leases', () => {
  const f = p.createCustomerStorageFence();
  assert.equal(f.capture('portfolioSecure'), null);
  f.transition(guest); const g = f.capture('portfolioSecure');
  f.transition(ownerA); const a = f.capture('portfolioSecure');
  f.transition(ownerB); const b = f.capture('portfolioSecure');
  f.transition(ownerA); const a2 = f.capture('portfolioSecure');
  for (const old of [g, a, b]) assert.equal(f.isCurrent(old), false);
  f.transition(ownerA); assert.equal(f.isCurrent(a2), false);
  const current = f.capture('portfolioSecure'); assert.equal(f.isCurrent(current), true);
  f.invalidate(); assert.equal(f.isCurrent(current), false); assert.equal(f.capture('venmoContacts'), null);
  f.transition(guest); assert.equal(f.isCurrent(g), false);
});
test('leases capture frozen destinations and cannot be forged or borrowed from another fence', () => {
  const input = { ...ownerA }, f = p.createCustomerStorageFence(input);
  input.dataScope = scopeB;
  const lease = f.capture('venmoContacts'), key = lease.key;
  assert.equal(lease.scope.dataScope, scopeA);
  assert.equal(Object.isFrozen(lease), true); assert.equal(Object.isFrozen(lease.scope), true);
  assert.equal(f.isCurrent({ ...lease }), false);
  assert.equal(p.createCustomerStorageFence(ownerA).isCurrent(lease), false);
  f.transition(ownerB); assert.equal(lease.key, key); assert.equal(f.isCurrent(lease), false);
});
test('invalid identity transition fails closed rather than leaving previous owner writable', () => {
  const f = p.createCustomerStorageFence(ownerA), lease = f.capture('channel3Collections');
  assert.throws(() => f.transition({ kind: 'owner', dataScope: 'invalid' }));
  assert.equal(f.isCurrent(lease), false); assert.deepEqual(f.current(), { kind: 'hold' });
  assert.equal(f.capture('channel3Collections'), null);
});
test('queued work checks lease before issuing storage mutation', async () => {
  const f = p.createCustomerStorageFence(ownerA), lease = f.capture('portfolioSecure'), gate = deferred(), writes = [];
  const work = gate.promise.then(() => { if (!f.isCurrent(lease)) return false; writes.push(lease.key); return true; });
  f.transition(ownerB); gate.resolve(); assert.equal(await work, false); assert.deepEqual(writes, []);
});
test('delayed storage read cannot hydrate another identity', async () => {
  const f = p.createCustomerStorageFence(ownerA), lease = f.capture('channel3Collections'), read = deferred(), published = [];
  const work = (async () => { if (!f.isCurrent(lease)) return; const result = await read.promise; if (!f.isCurrent(lease)) return; published.push(result); })();
  f.transition(ownerB); read.resolve('owner A list'); await work; assert.deepEqual(published, []);
});
test('issued native write cannot be retracted, but stays at old destination and cannot publish', async () => {
  const f = p.createCustomerStorageFence(ownerA), lease = f.capture('portfolioSecure'), write = deferred(), issued = [], published = [];
  const work = (async () => { if (!f.isCurrent(lease)) return; issued.push(lease.key); await write.promise; if (!f.isCurrent(lease)) return; published.push('saved'); })();
  f.transition(ownerB); write.resolve(); await work;
  assert.deepEqual(issued, [p.privateStorageKey('portfolioSecure', ownerA)]);
  assert.deepEqual(published, []);
  assert.notEqual(issued[0], p.privateStorageKey('portfolioSecure', ownerB));
});
