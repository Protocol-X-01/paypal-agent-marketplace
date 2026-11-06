import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { createPostgresStore } = load("src/lib/customer-auth/store.ts");

// The guarded runner must opt in. Never use a configured or existing database.
test("isolated PostgreSQL enforces one-use transactions, capacity, expiry and revocable sessions", { skip: process.env.PAYPAL_AUTH_ISOLATED_PG_TEST !== "1", timeout: 30_000 }, async () => {
  const work = mkdtempSync("/tmp/paypal-auth-postgres-");
  const data = `${work}/data`;
  const socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  let server;
  let pool;
  let store;
  let smallStore;
  try {
    // Stream only synthetic initdb progress so a stalled isolated fixture has a visible checkpoint.
    const init = spawnSync(`${bin}/initdb`, ["-D", data, "--auth=trust", "--no-sync", "--username=auth_fixture"], { env: safeEnv, stdio: "inherit", timeout: 10_000 });
    assert.equal(init.status, 0, `Synthetic database initialization failed: ${init.error?.code ?? init.status ?? "unknown"}`);
    // Limit optional test-cluster workers; transactional and concurrent queries remain enabled.
    server = spawn(`${bin}/postgres`, ["-D", data, "-k", socket, "-p", "5432", "-c", "listen_addresses=", "-c", "max_connections=8", "-c", "shared_buffers=12MB", "-c", "max_worker_processes=0", "-c", "max_parallel_workers=0", "-c", "max_wal_senders=0", "-c", "autovacuum=off", "-c", "track_activities=off", "-c", "fsync=off", "-c", "full_page_writes=off"], { env: safeEnv, stdio: "ignore" });
    const settings = { host: socket, port: 5432, user: "auth_fixture", database: "postgres", connectionTimeoutMillis: 1000 };
    pool = new Pool({ ...settings, max: 1 });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      if (server.exitCode !== null) throw new Error("Synthetic database exited during startup");
      try { await pool.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");
    store = createPostgresStore(settings);
    assert.equal(await store.ready(), false, "Missing schema must fail closed");
    await pool.query(readFileSync(new URL("../docs/customer-auth-schema.sql", import.meta.url), "utf8"));
    assert.equal(await store.ready(), true);

    const key = (n) => n.toString(16).padStart(64, "0");
    const context = "f".repeat(64);
    const otherContext = "e".repeat(64);
    const txn = { state: "synthetic-state", nonce: "synthetic-nonce", verifier: "synthetic-verifier" };
    const identity = { accountType: "personal", dataScope: `v1_${"A".repeat(43)}` };
    await store.createTransaction(key(10000), context, txn, null, null);
    const consumed = await Promise.all([store.consumeTransaction(key(10000), context), store.consumeTransaction(key(10000), context)]);
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.deepEqual(consumed.find(Boolean), txn);
    await store.createSession(key(10001), context, identity, key(10000), null);
    assert.deepEqual(await store.readSession(key(10001), context), identity);
    assert.equal(await store.readSession(key(10001), otherContext), null);
    await assert.rejects(store.createTransaction(key(10002), otherContext, txn, key(10001), null));
    await store.createTransaction(key(10003), context, txn, key(10001), null);
    assert.deepEqual(await store.consumeTransaction(key(10003), context), txn);
    await store.createSession(key(10004), context, identity, key(10003), key(10001));
    assert.equal(await store.readSession(key(10001), context), null, "Rotation invalidates the previous session");
    assert.deepEqual(await store.readSession(key(10004), context), identity);
    await pool.query("UPDATE paypal_markets_auth.sessions SET expires_at = now() - interval '1 second' WHERE handle_hash=$1", [key(10004)]);
    assert.equal(await store.readSession(key(10004), context), null);

    await store.createTransaction(key(10005), context, txn, null, null);
    await pool.query("UPDATE paypal_markets_auth.login_transactions SET expires_at = now() - interval '1 second' WHERE handle_hash = $1", [key(10005)]);
    assert.equal(await store.consumeTransaction(key(10005), context), null);
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [key(10005)])).rows[0],
      { status: "completed", state: null, nonce: null, verifier: null });
    await store.createTransaction(key(10006), context, txn, null, null);
    assert.equal(await store.consumeTransaction(key(10006), otherContext), null);
    assert.equal(await store.consumeTransaction(key(10006), context), null, "A cross-context claim consumes rather than exposes a transaction");

    async function signedIn(txKey, sessionKey) {
      await store.createTransaction(txKey, context, txn, null, null);
      assert.deepEqual(await store.consumeTransaction(txKey, context), txn);
      await store.createSession(sessionKey, context, identity, txKey, null);
    }
    // Logout commits while A is processing and B is the latest browser transaction cookie.
    await signedIn(key(10100), key(10101));
    await store.createTransaction(key(10102), context, txn, key(10101), null);
    await store.createTransaction(key(10103), context, txn, key(10101), null);
    assert.deepEqual(await store.consumeTransaction(key(10102), context), txn);
    await store.logout(key(10101), key(10103));
    await assert.rejects(store.createSession(key(10104), context, identity, key(10102), key(10101)));
    await assert.rejects(store.createTransaction(key(10105), context, txn, key(10101), null));
    assert.equal(await store.readSession(key(10101), context), null);

    // Callback commits first; logout still resolves the stale session alias and revokes its successor.
    await signedIn(key(10200), key(10201));
    await store.createTransaction(key(10202), context, txn, key(10201), null);
    await store.createTransaction(key(10203), context, txn, key(10201), null);
    assert.deepEqual(await store.consumeTransaction(key(10202), context), txn);
    await store.createSession(key(10204), context, identity, key(10202), key(10201));
    await store.logout(key(10201), key(10203));
    assert.equal(await store.readSession(key(10204), context), null, "A delayed successor cookie is already revoked");
    assert.equal(await store.consumeTransaction(key(10203), context), null);

    // A delayed logout may carry a rotated alias after that old cookie's normal expiry.
    await signedIn(key(10210), key(10211));
    await store.createTransaction(key(10212), context, txn, key(10211), null);
    assert.deepEqual(await store.consumeTransaction(key(10212), context), txn);
    await store.createSession(key(10213), context, identity, key(10212), key(10211));
    await pool.query("UPDATE paypal_markets_auth.sessions SET expires_at=now()-interval '36 minutes' WHERE handle_hash=$1", [key(10211)]);
    await store.createTransaction(key(10214), context, txn, null, null); // Runs bounded cleanup.
    await store.logout(key(10211), null);
    assert.equal(await store.readSession(key(10213), context), null, "An old alias remains until its family expires");

    // Exercise actual concurrent database operations as well as both committed orders.
    await signedIn(key(10300), key(10301));
    await store.createTransaction(key(10302), context, txn, key(10301), null);
    assert.deepEqual(await store.consumeTransaction(key(10302), context), txn);
    const racing = await Promise.allSettled([
      store.createSession(key(10303), context, identity, key(10302), key(10301)),
      store.logout(key(10301), key(10302)),
    ]);
    assert.equal(racing[1].status, "fulfilled");
    assert.equal(await store.readSession(key(10303), context), null);

    // An expired child row held during cleanup must not deadlock with logout's
    // family-first locking. Queue both operations before releasing that row.
    await signedIn(key(10400), key(10401));
    await store.createTransaction(key(10402), context, txn, key(10401), null);
    await pool.query("UPDATE paypal_markets_auth.login_transactions SET expires_at=now()-interval '1 second' WHERE handle_hash=$1", [key(10402)]);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT handle_hash FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1 FOR UPDATE", [key(10402)]);
      const starting = store.createTransaction(key(10403), context, txn, key(10401), null);
      const settledStart = starting.then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason }));
      async function waitForBlocked(count) {
        for (let attempt = 0; attempt < 40; attempt++) {
          // The lock-holding connection can inspect pg_locks itself; avoiding
          // a second observer connection keeps the bounded fixture smaller.
          const blocked = await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted");
          if (blocked.rows[0].count >= count) return;
          await delay(25);
        }
        throw Error(`Expected ${count} blocked fixture operations`);
      }
      await waitForBlocked(1);
      const signingOut = store.logout(key(10401), key(10402));
      const settledLogout = signingOut.then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason }));
      await waitForBlocked(2);
      await blocker.query("COMMIT");
      const [started, loggedOut] = await Promise.all([settledStart, settledLogout]);
      assert.equal(loggedOut.status, "fulfilled", "Logout must not be aborted by cleanup lock ordering");
      if (started.status === "rejected") assert.notEqual(started.reason.code, "40P01", "Start must not be aborted by a deadlock");
      assert.equal(await store.readSession(key(10401), context), null);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }

    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='paypal_markets_auth' AND table_name='sessions' ORDER BY ordinal_position")).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ["handle_hash", "context_hash", "family_hash", "family_generation", "revoked", "account_type", "data_scope", "expires_at"]);

    // Smaller fixed limits exercise every retained-record quota without a load test.
    await store.close(); store = null;
    await pool.end(); pool = new Pool({ ...settings, max: 1 });
    await pool.query("TRUNCATE paypal_markets_auth.session_families CASCADE");
    smallStore = createPostgresStore(settings, { families: 2, transactions: 4, sessions: 3 });
    for (const n of [10500, 10501]) {
      await smallStore.createTransaction(key(n), context, txn, null, null);
      await smallStore.logout(null, key(n));
    }
    await assert.rejects(smallStore.createTransaction(key(10502), context, txn, null, null), /capacity/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM paypal_markets_auth.session_families")).rows[0].count, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM paypal_markets_auth.login_transactions WHERE status='completed'")).rows[0].count, 2);
    await smallStore.close(); smallStore = null;

    await pool.query("TRUNCATE paypal_markets_auth.session_families CASCADE");
    smallStore = createPostgresStore(settings, { families: 4, transactions: 2, sessions: 3 });
    await smallStore.createTransaction(key(10600), context, txn, null, null);
    await smallStore.logout(null, key(10600));
    const capacityRace = await Promise.allSettled([
      smallStore.createTransaction(key(10601), context, txn, null, null),
      smallStore.createTransaction(key(10602), context, txn, null, null),
    ]);
    assert.equal(capacityRace.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM paypal_markets_auth.login_transactions")).rows[0].count, 2);
    await smallStore.close(); smallStore = null;

    await pool.query("TRUNCATE paypal_markets_auth.session_families CASCADE");
    smallStore = createPostgresStore(settings, { families: 4, transactions: 8, sessions: 2 });
    await smallStore.createTransaction(key(10700), context, txn, null, null);
    await smallStore.consumeTransaction(key(10700), context);
    await smallStore.createSession(key(10701), context, identity, key(10700), null);
    await smallStore.createTransaction(key(10702), context, txn, key(10701), null);
    await smallStore.consumeTransaction(key(10702), context);
    await smallStore.createSession(key(10703), context, identity, key(10702), key(10701));
    await smallStore.createTransaction(key(10704), context, txn, key(10703), null);
    await smallStore.consumeTransaction(key(10704), context);
    await assert.rejects(smallStore.createSession(key(10705), context, identity, key(10704), key(10703)), /capacity/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM paypal_markets_auth.sessions")).rows[0].count, 2);
    assert.deepEqual(await smallStore.readSession(key(10703), context), identity, "Quota rejection must not revoke the current session");
  } finally {
    if (smallStore) await smallStore.close();
    if (store) await store.close();
    if (pool) await pool.end();
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
      if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise((resolve) => server.once("exit", resolve)); }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
