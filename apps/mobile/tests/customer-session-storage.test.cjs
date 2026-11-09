// Pure synthetic adapter tests; no Expo APIs, native storage or device calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file, aliases = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', code)(loaded.exports, name => { if (Object.hasOwn(aliases, name)) return aliases[name]; throw Error('Unexpected runtime dependency'); }, loaded);
  return loaded.exports;
}
const scope = load('customer-storage-scope.ts');
const links = load('customer-session-links.ts', { './customer-storage-scope': scope });
const p = load('customer-session-storage.ts', { './customer-session-links': links });
const token = n => Buffer.alloc(32, n).toString('base64url');
const config = { origin: 'https://app.example.test', androidReturnUrl: 'https://app.example.test/native/android', iosReturnUrl: 'https://app.example.test/native/ios' };
const stamp = 1793980800000;
const identity = { authenticated: true, accountType: 'personal', dataScope: `v1_${token(5)}`, expiresAt: stamp + 1700000 };
const pending = { state: token(1), codeVerifier: token(2) };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const values = new Map([['paypal-markets.mobile.manual-holdings.secure.v1', 'guest portfolio unchanged'], ['paypal-markets.venmo-contacts.v1', 'guest contacts unchanged']]);
  const writes = []; const reads = [];
  const adapter = { kind: 'native-secure-device-only', async getItem(key) { reads.push(key); return values.get(key) ?? null; }, async setItem(key, value) { writes.push({ key, value }); values.set(key, value); } };
  const store = p.createCustomerSessionStorage(adapter, config, { now: () => stamp, ...options });
  return { adapter, store, values, writes, reads };
}
async function snap(store) { const r = await store.read(); assert.equal(r.status, 'ready'); return r.snapshot; }
async function pendingSnap(f) { const r = await f.store.savePending(await snap(f.store), pending); assert.equal(r.status, 'ready'); return r.snapshot; }

test('single secure key preserves guest data and initial pending timestamp when attaching handoff', async () => {
  const f = fixture(); const first = await pendingSnap(f);
  assert.equal(first.value.pending.createdAt, stamp); assert.equal(first.value.pending.expiresAt, stamp + 300000);
  const attached = await f.store.savePending(first, { ...pending, handoff: token(3) }); assert.equal(attached.status, 'ready');
  assert.equal(attached.snapshot.value.pending.createdAt, stamp);
  assert.equal((await f.store.savePending(attached.snapshot, { ...pending, handoff: token(4) })).status, 'invalid');
  assert.equal((await f.store.savePending(attached.snapshot, { ...pending, state: token(8) })).status, 'invalid');
  assert.equal(new Set([...f.writes.map(x => x.key), ...f.reads]).size, 1);
  assert.equal(f.values.get('paypal-markets.mobile.manual-holdings.secure.v1'), 'guest portfolio unchanged');
  assert.equal(f.values.get('paypal-markets.venmo-contacts.v1'), 'guest contacts unchanged');
  assert.ok(f.writes.every(x => x.value.length < 1900));
});

test('only server-validated identity saves; pending survives first write and readback', async () => {
  const f = fixture(), first = await pendingSnap(f);
  assert.equal((await f.store.saveVerifiedSession(first, token(8), { ...identity, authenticated: undefined })).status, 'invalid');
  assert.equal((await f.store.saveVerifiedSession(first, token(8), { ...identity, sessionToken: token(8) })).status, 'invalid');
  assert.equal((await f.store.saveVerifiedSession(first, token(8), { ...identity, expiresAt: stamp + 1800001 })).status, 'invalid');
  assert.equal((await f.store.saveVerifiedSession(first, token(8), { ...identity, expiresAt: stamp })).status, 'invalid');
  const saved = await f.store.saveVerifiedSession(first, token(8), identity); assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.snapshot.value.pending, first.value.pending); assert.equal(saved.snapshot.value.session.verifiedAt, stamp);
  assert.ok(JSON.parse(f.writes.at(-1).value).pending);
  const restarted = p.createCustomerSessionStorage(f.adapter, config, { now: () => stamp });
  assert.equal((await restarted.finishVerifiedSignIn(await snap(restarted))).status, 'unconfirmed', 'Persisted candidate must be revalidated after restart');
  const done = await f.store.finishVerifiedSignIn(saved.snapshot); assert.equal(done.status, 'ready'); assert.equal(done.snapshot.value.pending, null);
});

test('failed write and failed readback preserve cancellation material and never claim success', async () => {
  const f = fixture(), base = await pendingSnap(f), old = f.values.get(f.writes[0].key);
  const originalWrite = f.adapter.setItem;
  f.adapter.setItem = async () => { throw Error(`secret ${token(8)}`); };
  const failed = await f.store.saveVerifiedSession(base, token(8), identity); assert.deepEqual(failed, { status: 'unavailable' }); assert.equal(f.values.get(f.writes[0].key), old);
  f.adapter.setItem = originalWrite; const recovered = await snap(f.store);
  let written = false; const originalRead = f.adapter.getItem;
  f.adapter.setItem = async (...args) => { await originalWrite(...args); written = true; };
  f.adapter.getItem = async key => { if (written) throw Error(`secret ${token(8)}`); return originalRead(key); };
  assert.equal((await f.store.saveVerifiedSession(recovered, token(8), identity)).status, 'unavailable');
  const actual = JSON.parse(f.values.get(f.writes[0].key)); assert.ok(actual.pending); assert.equal(actual.session.sessionToken, token(8));
  assert.equal((await f.store.finishVerifiedSignIn(recovered)).status, 'unconfirmed');
});

test('corruption, duplicates and changed configuration fail closed without overwriting', async () => {
  const f = fixture(); await pendingSnap(f); const key = f.writes[0].key, raw = f.values.get(key);
  for (const bad of ['broken', raw.replace('{', '{"version":1,'), raw.replace('"version":1', '"version":2'), 'x'.repeat(1901)]) {
    f.values.set(key, bad); const r = await f.store.read(); assert.equal(r.status, 'corrupt'); assert.equal(f.values.get(key), bad);
  }
  f.values.set(key, raw);
  const foreign = p.createCustomerSessionStorage(f.adapter, { ...config, androidReturnUrl: config.androidReturnUrl + '-new' }, { now: () => stamp });
  assert.deepEqual(await foreign.read(), { status: 'configuration-mismatch' }); assert.equal(f.values.get(key), raw);
  assert.equal((await f.store.savePending({ value: JSON.parse(raw) }, pending)).status, 'invalid');
});

test('revocation-only retries preserve secrets until confirmed without restoring active sessions', async () => {
  const f = fixture(); let r = await f.store.savePending(await snap(f.store), { ...pending, handoff: token(3) });
  r = await f.store.saveVerifiedSession(r.snapshot, token(8), identity); assert.equal(r.status, 'ready');
  r = await f.store.queueSessionRevocation(r.snapshot); assert.equal(r.status, 'ready'); assert.equal(r.snapshot.value.session, null);
  r = await f.store.queueHandoffCancellation(r.snapshot); assert.equal(r.status, 'ready'); assert.equal(r.snapshot.value.revocations.length, 2); assert.ok(r.snapshot.value.pending);
  const cancellation = r.snapshot.value.revocations.find(x => x.kind === 'handoff'); assert.equal(cancellation.attemptExpiresAt, stamp + 300000); assert.equal('expiresAt' in cancellation, false);
  assert.equal((await f.store.saveVerifiedSession(r.snapshot, token(8), identity)).status, 'invalid');
  assert.equal((await f.store.confirmSessionRevoked(r.snapshot, token(9))).status, 'invalid');
  r = await f.store.confirmSessionRevoked(r.snapshot, token(8)); assert.equal(r.status, 'ready'); assert.equal(r.snapshot.value.revocations.length, 1);
  r = await f.store.confirmHandoffCancelled(r.snapshot, token(3)); assert.equal(r.status, 'ready'); assert.equal(r.snapshot.value.revocations.length, 0); assert.equal(r.snapshot.value.pending, null);
});

test('queued mutations and external baseline changes cannot overwrite a newer snapshot', async () => {
  const f = fixture(); const base = await snap(f.store);
  const results = await Promise.all([f.store.savePending(base, pending), f.store.savePending(base, { ...pending, state: token(9) })]);
  assert.deepEqual(results.map(x => x.status), ['ready', 'stale']); assert.equal(f.writes.length, 1);
  const latest = results[0].snapshot, key = f.writes[0].key;
  const changed = JSON.parse(f.values.get(key)); changed.pending.state = token(7); f.values.set(key, JSON.stringify(changed));
  assert.equal((await f.store.savePending(latest, { ...pending, handoff: token(3) })).status, 'conflict');
  assert.equal(JSON.parse(f.values.get(key)).pending.state, token(7));
});

test('invalidation during issued write reports stale and never rolls back newer data', async () => {
  const f = fixture(); const base = await snap(f.store); const entered = deferred(), release = deferred(); const actualWrite = f.adapter.setItem;
  f.adapter.setItem = async (...args) => { entered.resolve(); await release.promise; await actualWrite(...args); };
  const writing = f.store.savePending(base, pending); await entered.promise; f.store.invalidate(); release.resolve();
  assert.equal((await writing).status, 'stale'); assert.equal(f.writes.length, 1);
  const current = await snap(f.store); assert.equal(current.value.pending.state, pending.state);
  assert.equal((await f.store.savePending(base, pending)).status, 'stale');
});

test('readback mismatch returns hold and malformed adapter errors do not leak tokens', async () => {
  const f = fixture(); const base = await snap(f.store), actual = f.adapter.setItem;
  f.adapter.setItem = async (key, raw) => { await actual(key, raw); f.values.set(key, 'corrupt after write'); };
  const result = await f.store.savePending(base, pending); assert.deepEqual(result, { status: 'conflict' });
  assert.deepEqual(await f.store.read(), { status: 'corrupt' }); assert.equal(f.writes.length, 1);
  assert.throws(() => p.createCustomerSessionStorage({ ...f.adapter, kind: 'web-localstorage' }, config), /unavailable/);
});

test('unbound restart recovery is fenced and bound cancellation needs queued proof', async () => {
  const f = fixture();
  let base = await snap(f.store);
  const saved = await f.store.saveVerifiedSession(base, token(8), identity);
  const first = await f.store.savePending(saved.snapshot, pending);
  // No browser may open until handoff attachment has completed readback.
  const restarted = p.createCustomerSessionStorage(f.adapter, config, { now: () => stamp + 400000 });
  base = await snap(restarted);
  const cleared = await restarted.discardUnboundPending(base);
  assert.equal(cleared.status, 'ready'); assert.equal(cleared.snapshot.value.pending, null);
  assert.deepEqual(cleared.snapshot.value.session, saved.snapshot.value.session);
  assert.equal((await f.store.discardUnboundPending(first.snapshot)).status, 'stale');
  const next = await restarted.savePending(cleared.snapshot, { state: token(9), codeVerifier: token(10) });
  assert.equal(next.status, 'ready');
  const bound = await restarted.savePending(next.snapshot, { state: token(9), codeVerifier: token(10), handoff: token(11) });
  assert.equal(bound.status, 'ready');
  assert.equal((await restarted.discardUnboundPending(bound.snapshot)).status, 'invalid');
  assert.equal((await restarted.confirmHandoffCancelled(bound.snapshot, token(11))).status, 'invalid');
  const queued = await restarted.queueHandoffCancellation(bound.snapshot);
  assert.equal(queued.status, 'ready');
  assert.equal((await restarted.confirmHandoffCancelled(queued.snapshot, token(11))).status, 'ready');
});

test('presence classifier accepts confirmed logout empty envelope, never corrupt or active material', async () => {
  assert.equal(p.classifyCustomerSessionStoragePresence(null), 'empty');
  const f = fixture();
  let base = await snap(f.store);
  base = (await f.store.saveVerifiedSession(base, token(9), identity)).snapshot;
  base = (await f.store.finishVerifiedSignIn(base)).snapshot;
  base = (await f.store.queueSessionRevocation(base)).snapshot;
  const key = p.CUSTOMER_SESSION_STORAGE_KEY;
  assert.equal(p.classifyCustomerSessionStoragePresence(f.values.get(key)), 'present');
  await f.store.confirmSessionRevoked(base, token(9));
  const empty = f.values.get(key);
  assert.equal(p.classifyCustomerSessionStoragePresence(empty), 'empty');
  const oldBinding = JSON.stringify({ ...JSON.parse(empty), binding: 'previous-config' });
  assert.equal(p.classifyCustomerSessionStoragePresence(oldBinding), 'empty');
  for (const raw of ['', '{}', 'null', ' '+empty, empty.replace('"version":1', '"version":1,"version":1'), JSON.stringify({ ...JSON.parse(empty), unexpected: true })]) assert.equal(p.classifyCustomerSessionStoragePresence(raw), 'present');
  await f.store.savePending(await snap(f.store), pending);
  assert.equal(p.classifyCustomerSessionStoragePresence(f.values.get(key)), 'present');
});
