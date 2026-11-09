// Independent, in-memory boundary tests: no browser storage or provider calls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const [lockCode, storageCode] = await Promise.all([
  compile("../src/lib/collection-lock.ts"),
  compile("../src/lib/customer-session-storage.ts"),
]);

function load(code, browserWindow) {
  const cjsModule = { exports: {} };
  new Function("exports", "module", "window", code)(cjsModule.exports, cjsModule, browserWindow);
  return cjsModule.exports;
}
const scoped = load(storageCode);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A shared fictional lock service for two separately constructed windows.
 * A paused grant models a lock that has been reserved before its callback runs.
 * A busy ifAvailable request is declined, rather than queued. */
function lockService() {
  let held = false;
  let pause;
  const requests = [];
  return {
    requests,
    pauseNextGrant() {
      pause = { entered: deferred(), release: deferred() };
      return pause;
    },
    request(name, options, callback) {
      requests.push({ name, options });
      if (held) return Promise.resolve().then(() => callback(null));
      held = true;
      const delayed = pause;
      pause = undefined;
      return (async () => {
        if (delayed) { delayed.entered.resolve(); await delayed.release.promise; }
        return callback({ name, mode: "exclusive" });
      })().finally(() => { held = false; });
    },
  };
}

function windowWith(locks) {
  return { isSecureContext: true, navigator: { locks } };
}

function fictionalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const operations = [];
  return {
    values,
    operations,
    getItem(key) { operations.push(["read", key]); return values.get(key) ?? null; },
    setItem(key, value) { operations.push(["write", key]); values.set(key, value); },
    removeItem(key) { operations.push(["remove", key]); values.delete(key); },
  };
}

// The lock helper intentionally does not perform a baseline comparison itself.
// This tiny consumer exercises the real scoped-storage wrapper inside its lock.
function compareAndWrite(helper, store, expected, next) {
  return helper.tryCollectionLock(() => {
    if (store.getItem(helper.SHOPPING_LISTS_STORAGE_KEY) !== expected) return "changed";
    store.setItem(helper.SHOPPING_LISTS_STORAGE_KEY, next);
    return store.getItem(helper.SHOPPING_LISTS_STORAGE_KEY) === next ? "saved" : "unverified";
  });
}

test("two cooperating contexts decline a busy lock and do not overwrite a newer baseline", async () => {
  const locks = lockService();
  const first = load(lockCode, windowWith(locks));
  const second = load(lockCode, windowWith(locks));
  const key = first.SHOPPING_LISTS_STORAGE_KEY;
  const original = JSON.stringify({ version: 1, collections: [] });
  const savedA = JSON.stringify({ version: 1, collections: [{ id: "one", name: "Example A", items: [] }] });
  const savedB = JSON.stringify({ version: 1, collections: [{ id: "two", name: "Example B", items: [] }] });
  const storage = fictionalStorage({ [key]: original });
  const a = scoped.createScopedStorage(() => storage, scoped.createScopeLease("guest", "first-window"));
  const b = scoped.createScopedStorage(() => storage, scoped.createScopeLease("guest", "second-window"));
  const gate = locks.pauseNextGrant();

  const pending = compareAndWrite(first, a, original, savedA);
  await gate.entered.promise;
  const busy = await compareAndWrite(second, b, original, savedB);
  assert.deepEqual(busy, { kind: "busy" });
  assert.deepEqual(storage.operations, [], "A declined callback must not access storage");

  gate.release.resolve();
  assert.deepEqual(await pending, { kind: "acquired", value: "saved" });
  assert.deepEqual(await compareAndWrite(second, b, original, savedB), { kind: "acquired", value: "changed" });
  assert.equal(storage.values.get(key), savedA);
  assert.equal(storage.operations.filter(([kind]) => kind === "write").length, 1);
  assert.ok(locks.requests.every(({ name, options }) => name === first.COLLECTION_LOCK_NAME && options.mode === "exclusive" && options.ifAvailable === true));
});

test("a changed raw baseline is preserved even when the lock is available", async () => {
  const helper = load(lockCode, windowWith(lockService()));
  const key = helper.SHOPPING_LISTS_STORAGE_KEY;
  const storage = fictionalStorage({ [key]: "fictional newer bytes" });
  const lease = scoped.createScopeLease("guest", "one-window");
  const store = scoped.createScopedStorage(() => storage, lease);
  const result = await compareAndWrite(helper, store, "fictional earlier bytes", "fictional overwrite");
  assert.deepEqual(result, { kind: "acquired", value: "changed" });
  assert.equal(storage.values.get(key), "fictional newer bytes");
  assert.deepEqual(storage.operations, [["read", key]]);
});

test("an asynchronous callback keeps the shared lock until its work settles", async () => {
  const locks = lockService();
  const first = load(lockCode, windowWith(locks));
  const second = load(lockCode, windowWith(locks));
  const gate = deferred(), entered = deferred();
  const pending = first.tryCollectionLock(async () => { entered.resolve(); await gate.promise; return "finished"; });
  await entered.promise;
  let ran = false;
  assert.deepEqual(await second.tryCollectionLock(() => { ran = true; }), { kind: "busy" });
  assert.equal(ran, false);
  gate.resolve();
  assert.deepEqual(await pending, { kind: "acquired", value: "finished" });
  assert.deepEqual(await second.tryCollectionLock(() => "next"), { kind: "acquired", value: "next" });
});

test("a cooperating reset prevents a stale save from restoring removed collections", async () => {
  const locks = lockService();
  const resetter = load(lockCode, windowWith(locks));
  const saver = load(lockCode, windowWith(locks));
  const key = resetter.SHOPPING_LISTS_STORAGE_KEY;
  const original = JSON.stringify({ version: 1, collections: [{ id: "one", name: "Example", items: [] }] });
  const storage = fictionalStorage({ [key]: original });
  const a = scoped.createScopedStorage(() => storage, scoped.createScopeLease("guest", "reset-window"));
  const b = scoped.createScopedStorage(() => storage, scoped.createScopeLease("guest", "save-window"));
  const gate = locks.pauseNextGrant();
  const reset = resetter.tryCollectionLock(() => {
    if (a.getItem(key) !== original) return "changed";
    a.removeItem(key);
    return "removed";
  });
  await gate.entered.promise;
  assert.deepEqual(await compareAndWrite(saver, b, original, "fictional stale update"), { kind: "busy" });
  gate.release.resolve();
  assert.deepEqual(await reset, { kind: "acquired", value: "removed" });
  assert.deepEqual(await compareAndWrite(saver, b, original, "fictional stale update"), { kind: "acquired", value: "changed" });
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.operations.filter(([kind]) => kind === "write").length, 0);
});

test("a revoked scope cannot read or write when a reserved lock callback starts", async () => {
  const locks = lockService();
  const helper = load(lockCode, windowWith(locks));
  const key = helper.SHOPPING_LISTS_STORAGE_KEY;
  const storage = fictionalStorage({ [key]: "fictional original" });
  const lease = scoped.createScopeLease("guest", "retiring-window");
  const store = scoped.createScopedStorage(() => storage, lease);
  const gate = locks.pauseNextGrant();
  const pending = compareAndWrite(helper, store, "fictional original", "fictional replacement");
  await gate.entered.promise;
  scoped.revokeScopeLease(lease);
  gate.release.resolve();
  assert.deepEqual(await pending, { kind: "unavailable" });
  assert.deepEqual(storage.operations, []);
  assert.equal(storage.values.get(key), "fictional original");
});

test("a scope revoked while an async lock holder waits cannot write afterward", async () => {
  const helper = load(lockCode, windowWith(lockService()));
  const key = helper.SHOPPING_LISTS_STORAGE_KEY;
  const storage = fictionalStorage({ [key]: "fictional original" });
  const lease = scoped.createScopeLease("guest", "retiring-window");
  const store = scoped.createScopedStorage(() => storage, lease);
  const gate = deferred(), entered = deferred();
  const pending = helper.tryCollectionLock(async () => {
    assert.equal(store.getItem(key), "fictional original");
    entered.resolve();
    await gate.promise;
    store.setItem(key, "fictional replacement");
  });
  await entered.promise;
  scoped.revokeScopeLease(lease);
  gate.resolve();
  assert.deepEqual(await pending, { kind: "unavailable" });
  assert.deepEqual(storage.operations, [["read", key]]);
  assert.equal(storage.values.get(key), "fictional original");
});

test("a scope revoked by a storage read cannot issue a subsequent write", async () => {
  const helper = load(lockCode, windowWith(lockService()));
  const key = helper.SHOPPING_LISTS_STORAGE_KEY;
  const storage = fictionalStorage({ [key]: "fictional original" });
  const lease = scoped.createScopeLease("guest", "retiring-window");
  const read = storage.getItem;
  storage.getItem = (name) => { const value = read(name); scoped.revokeScopeLease(lease); return value; };
  const store = scoped.createScopedStorage(() => storage, lease);
  assert.deepEqual(await compareAndWrite(helper, store, "fictional original", "fictional replacement"), { kind: "unavailable" });
  assert.deepEqual(storage.operations, [["read", key]]);
  assert.equal(storage.values.get(key), "fictional original");
});

test("unsupported browser conditions never run the write callback", async () => {
  const throwingWindow = { isSecureContext: true, navigator: {} };
  Object.defineProperty(throwingWindow.navigator, "locks", { get() { throw Error("unavailable"); } });
  for (const candidate of [undefined, { isSecureContext: false }, { isSecureContext: true, navigator: {} }, throwingWindow]) {
    const helper = load(lockCode, candidate);
    let ran = false;
    assert.equal(helper.collectionLocksAvailable(), false);
    assert.deepEqual(await helper.tryCollectionLock(() => { ran = true; }), { kind: "unsupported" });
    assert.equal(ran, false);
  }
});

test("a rejected lock request or throwing callback fails closed and releases the lock", async () => {
  const rejected = load(lockCode, windowWith({ request: () => Promise.reject(Error("fictional failure")) }));
  let ran = false;
  assert.equal(rejected.collectionLocksAvailable(), true);
  assert.deepEqual(await rejected.tryCollectionLock(() => { ran = true; }), { kind: "unavailable" });
  assert.equal(ran, false);

  const helper = load(lockCode, windowWith(lockService()));
  assert.deepEqual(await helper.tryCollectionLock(() => { throw Error("fictional storage error"); }), { kind: "unavailable" });
  assert.deepEqual(await helper.tryCollectionLock(() => "recovered"), { kind: "acquired", value: "recovered" });
});
