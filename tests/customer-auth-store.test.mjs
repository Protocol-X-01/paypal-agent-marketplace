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
test("isolated PostgreSQL enforces one-use transactions, capacity, expiry and revocable sessions", { skip: process.env.PAYPAL_AUTH_ISOLATED_PG_TEST !== "1", timeout: 45_000 }, async () => {
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
  let parallelStore;
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
    const consumed = await Promise.all([store.consumeTransaction(key(10000), context, txn.state), store.consumeTransaction(key(10000), context, txn.state)]);
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.deepEqual(consumed.find(Boolean), txn);
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [key(10000)])).rows[0],
      { status: "processing", state: "", nonce: "", verifier: "" }, "A committed claim must not retain the provider transaction secrets");
    await store.createSession(key(10001), context, identity, key(10000), null);
    assert.deepEqual(await store.readSession(key(10001), context), identity);
    assert.equal(await store.readSession(key(10001), otherContext), null);
    await assert.rejects(store.createTransaction(key(10002), otherContext, txn, key(10001), null));
    await store.createTransaction(key(10003), context, txn, key(10001), null);
    assert.deepEqual(await store.consumeTransaction(key(10003), context, txn.state), txn);
    await store.createSession(key(10004), context, identity, key(10003), key(10001));
    assert.equal(await store.readSession(key(10001), context), null, "Rotation invalidates the previous session");
    assert.deepEqual(await store.readSession(key(10004), context), identity);
    await pool.query("UPDATE paypal_markets_auth.sessions SET expires_at = now() - interval '1 second' WHERE handle_hash=$1", [key(10004)]);
    assert.equal(await store.readSession(key(10004), context), null);

    await store.createTransaction(key(10005), context, txn, null, null);
    await pool.query("UPDATE paypal_markets_auth.login_transactions SET expires_at = now() - interval '1 second' WHERE handle_hash = $1", [key(10005)]);
    assert.equal(await store.consumeTransaction(key(10005), context, "wrong-state"), null);
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [key(10005)])).rows[0],
      { status: "completed", state: null, nonce: null, verifier: null });
    await store.createTransaction(key(10006), context, txn, null, null);
    assert.equal(await store.consumeTransaction(key(10006), otherContext, "wrong-state"), null);
    assert.equal(await store.consumeTransaction(key(10006), context, txn.state), null, "A cross-context claim consumes rather than exposes a transaction");
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [key(10006)])).rows[0],
      { status: "completed", state: null, nonce: null, verifier: null });

    await store.createTransaction(key(10007), context, txn, null, null);
    assert.equal(await store.consumeTransaction(key(10007), context, "wrong-state"), null);
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [key(10007)])).rows[0],
      { status: "pending", ...txn }, "A wrong state in the same live context must preserve the pending attempt");
    assert.deepEqual(await store.consumeTransaction(key(10007), context, txn.state), txn);

    // Independent pools race against the same real database row.
    parallelStore = createPostgresStore(settings);
    await store.createTransaction(key(10008), context, txn, null, null);
    const mixed = await Promise.all([
      store.consumeTransaction(key(10008), context, "wrong-state"),
      parallelStore.consumeTransaction(key(10008), context, txn.state),
      store.consumeTransaction(key(10008), context, txn.state),
      parallelStore.consumeTransaction(key(10008), context, "another-wrong-state"),
    ]);
    assert.equal(mixed[0], null); assert.equal(mixed[3], null);
    assert.equal([mixed[1], mixed[2]].filter(Boolean).length, 1);
    assert.deepEqual([mixed[1], mixed[2]].find(Boolean), txn);
    await store.createTransaction(key(10009), context, txn, null, null);
    const duplicateCorrect = await Promise.all([
      store.consumeTransaction(key(10009), context, txn.state),
      parallelStore.consumeTransaction(key(10009), context, txn.state),
    ]);
    assert.equal(duplicateCorrect.filter(Boolean).length, 1);
    assert.deepEqual(duplicateCorrect.find(Boolean), txn);
    await parallelStore.close(); parallelStore = null;

    // A claim that waits on a row lock must recheck expiry after the wait.
    async function expiresWhileClaimWaits(txKey, initialState, committedState, submittedState) {
      await store.createTransaction(txKey, context, { ...txn, state: initialState }, null, null);
      const blocker = await pool.connect();
      let claim;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`UPDATE paypal_markets_auth.login_transactions
          SET state=$2, expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE handle_hash=$1`, [txKey, committedState]);
        claim = store.consumeTransaction(txKey, context, submittedState).then(value => ({ value }), error => ({ error }));
        let blocked = false;
        for (let i = 0; i < 50 && !blocked; i++) {
          blocked = (await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted")).rows[0].count > 0;
          if (!blocked) await delay(15);
        }
        assert.equal(blocked, true, "The fixture claim must actually wait for the row lock");
        assert.equal((await blocker.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [txKey])).rows[0].live, true);
        await blocker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision + 0.1)
          FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1`, [txKey]);
        assert.equal((await blocker.query("SELECT expires_at<=clock_timestamp() AS expired FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [txKey])).rows[0].expired, true);
        await blocker.query("COMMIT");
        const result = await claim;
        assert.equal(result.error, undefined, "A blocked fixture claim must complete normally");
        assert.equal(result.value, null, "A claim released after expiry must not produce a login transaction");
        assert.deepEqual((await blocker.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [txKey])).rows[0],
          { status: "completed", state: null, nonce: null, verifier: null });
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (claim) await claim;
      }
    }
    await expiresWhileClaimWaits(key(10010), txn.state, txn.state, txn.state);
    await expiresWhileClaimWaits(key(10011), "old-state", txn.state, "old-state");

    // A claim can expire after its UPDATE predicate was evaluated but before
    // the statement returns. The winning callback must recheck after the wait.
    const delayedClaim = key(10900);
    await store.createTransaction(delayedClaim, context, txn, null, null);
    await pool.query("UPDATE paypal_markets_auth.login_transactions SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE handle_hash=$1", [delayedClaim]);
    await pool.query(`CREATE FUNCTION paypal_markets_auth.fixture_delay_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='processing' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fixture_delay_claim BEFORE UPDATE ON paypal_markets_auth.login_transactions
      FOR EACH ROW EXECUTE FUNCTION paypal_markets_auth.fixture_delay_claim()`);
    try {
      assert.equal(await store.consumeTransaction(delayedClaim, context, txn.state), null, "A claim must not return secrets after expiring during its update");
      assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [delayedClaim])).rows[0],
        { status: "completed", state: null, nonce: null, verifier: null });
    } finally {
      await pool.query("DROP TRIGGER fixture_delay_claim ON paypal_markets_auth.login_transactions");
      await pool.query("DROP FUNCTION paypal_markets_auth.fixture_delay_claim()");
    }

    // A failed write must roll back the claim, leaving the original attempt
    // usable; only a committed claim is allowed to hand secrets to the caller.
    const failedClaim = key(10901);
    await store.createTransaction(failedClaim, context, txn, null, null);
    await pool.query(`CREATE FUNCTION paypal_markets_auth.fixture_reject_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='processing' THEN RAISE EXCEPTION 'fictional claim failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fixture_reject_claim BEFORE UPDATE ON paypal_markets_auth.login_transactions
      FOR EACH ROW EXECUTE FUNCTION paypal_markets_auth.fixture_reject_claim()`);
    try {
      await assert.rejects(store.consumeTransaction(failedClaim, context, txn.state), /fictional claim failure/);
      assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [failedClaim])).rows[0],
        { status: "pending", ...txn });
    } finally {
      await pool.query("DROP TRIGGER fixture_reject_claim ON paypal_markets_auth.login_transactions");
      await pool.query("DROP FUNCTION paypal_markets_auth.fixture_reject_claim()");
    }
    assert.deepEqual(await store.consumeTransaction(failedClaim, context, txn.state), txn);
    assert.deepEqual((await pool.query("SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [failedClaim])).rows[0],
      { status: "processing", state: "", nonce: "", verifier: "" });

    async function signedIn(txKey, sessionKey) {
      await store.createTransaction(txKey, context, txn, null, null);
      assert.deepEqual(await store.consumeTransaction(txKey, context, txn.state), txn);
      await store.createSession(sessionKey, context, identity, txKey, null);
    }

    async function waitForSyntheticLock(blocker, lockType, isSettled) {
      for (let attempt = 0; attempt < 60 && !isSettled(); attempt++) {
        const result = await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND locktype=$1", [lockType]);
        if (result.rows[0].count > 0) return;
        await delay(15);
      }
      throw new Error(`The synthetic operation did not wait for a ${lockType} lock`);
    }

    // Cleanup can select an expired family from its statement snapshot while
    // another transaction is holding and extending that same family row.
    {
      const family = key(10020), prior = key(10021), next = key(10022);
      await signedIn(family, prior);
      const expiry = (await pool.query(`UPDATE paypal_markets_auth.session_families
        SET expires_at=clock_timestamp()+interval '900 milliseconds' WHERE family_hash=$1
        RETURNING expires_at::text AS expiry`, [family])).rows[0].expiry;
      const blocker = await pool.connect();
      let operation;
      let settled = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query(`UPDATE paypal_markets_auth.session_families
          SET expires_at=clock_timestamp()+interval '35 minutes' WHERE family_hash=$1`, [family]);
        // The committed version, which the cleanup will see, must be expired
        // before the cleanup statement starts. The extension remains uncommitted.
        await blocker.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))::double precision + 0.05)", [expiry]);
        operation = store.createTransaction(next, context, txn, null, null).then(
          () => { settled = true; return { ok: true }; },
          (error) => { settled = true; return { ok: false, error }; },
        );
        await waitForSyntheticLock(blocker, "transactionid", () => settled);
        assert.equal(settled, false, "Cleanup must still be waiting for the extended family row");
        await blocker.query("COMMIT");
        const result = await operation;
        assert.equal(result.ok, true, "An unrelated start succeeds after the extension commits");
        assert.deepEqual(await store.readSession(prior, context), identity, "Cleanup must preserve a session whose family was extended");
        assert.equal((await blocker.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_auth.session_families WHERE family_hash=$1", [family])).rows[0]?.live, true);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
    }

    // A supplied prior cookie cannot fall back to an unrelated new family if
    // logout revokes its family while this start is waiting for admission.
    {
      const prior = key(10030), next = key(10031);
      await store.createTransaction(prior, context, txn, null, null);
      await pool.query(`UPDATE paypal_markets_auth.login_transactions
        SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE handle_hash=$1`, [prior]);
      const blocker = await pool.connect();
      let operation;
      let settled = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(1347437612, 1096111176)");
        operation = store.createTransaction(next, context, txn, null, prior).then(
          () => { settled = true; return { ok: true }; },
          (error) => { settled = true; return { ok: false, error }; },
        );
        await waitForSyntheticLock(blocker, "advisory", () => settled);
        assert.equal((await blocker.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [prior])).rows[0]?.live, true,
          "The earlier transaction must still be live when the new start is blocked");
        await store.logout(null, prior);
        const revoked = (await blocker.query(`SELECT f.generation,t.status FROM paypal_markets_auth.session_families f
          JOIN paypal_markets_auth.login_transactions t USING (family_hash) WHERE t.handle_hash=$1`, [prior])).rows[0];
        assert.deepEqual(revoked, { generation: 1, status: "completed" }, "Logout must revoke the prior family while admission remains blocked");
        await blocker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision + 0.05)
          FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1`, [prior]);
        assert.equal((await blocker.query("SELECT expires_at<=clock_timestamp() AS expired FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [prior])).rows[0]?.expired, true);
        assert.equal(settled, false, "The new start must still be blocked, not timed out");
        await blocker.query("COMMIT");
        const result = await operation;
        assert.equal(result.ok, false, "A revoked and expired prior cookie must not start a new login");
        if (!result.ok) assert.doesNotMatch(String(result.error?.message ?? result.error), /timeout|canceling statement/i);
        assert.equal((await blocker.query("SELECT count(*)::int AS count FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [next])).rows[0].count, 0);
        assert.equal((await blocker.query("SELECT count(*)::int AS count FROM paypal_markets_auth.session_families WHERE family_hash=$1", [next])).rows[0].count, 0,
          "The start must not silently create an unrelated family");
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
    }

    // Waiting alone is not a denial: an unchanged, still-live prior cookie
    // can start a successor in its original family after the lock is released.
    {
      const prior = key(10040), next = key(10041);
      await store.createTransaction(prior, context, txn, null, null);
      const blocker = await pool.connect();
      let operation;
      let settled = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(1347437612, 1096111176)");
        operation = store.createTransaction(next, context, txn, null, prior).then(
          () => { settled = true; return { ok: true }; },
          (error) => { settled = true; return { ok: false, error }; },
        );
        await waitForSyntheticLock(blocker, "advisory", () => settled);
        assert.equal((await blocker.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [prior])).rows[0]?.live, true);
        await blocker.query("COMMIT");
        const result = await operation;
        assert.equal(result.ok, true, "A still-live prior cookie should start after an ordinary lock wait");
        assert.deepEqual((await blocker.query("SELECT family_hash,status FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [next])).rows[0],
          { family_hash: prior, status: "pending" });
        assert.equal((await blocker.query("SELECT count(*)::int AS count FROM paypal_markets_auth.session_families WHERE family_hash=$1", [next])).rows[0].count, 0);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
    }

    // The transaction clock is fixed at BEGIN. Every authorization used to
    // issue a successor must still be live after waiting on a lock, including
    // a lock that only holds a row without updating it.
    async function expiresWhileIssuanceWaits({ base, lock, expires, startOnly = false }) {
      const family = key(base);
      const prior = key(base + 1);
      const pending = key(base + 2);
      const successor = key(base + 3);
      const unrelatedFamily = key(base + 4);
      await signedIn(family, prior);
      if (!startOnly) {
        await store.createTransaction(pending, context, txn, prior, null);
        assert.deepEqual(await store.consumeTransaction(pending, context, txn.state), txn);
      }
      if (lock === "unique") await store.createTransaction(unrelatedFamily, context, txn, null, null);

      const expiring = {
        family: { table: "session_families", column: "family_hash", hash: family },
        transaction: { table: "login_transactions", column: "handle_hash", hash: pending },
        session: { table: "sessions", column: "handle_hash", hash: prior },
      }[expires];
      assert.ok(expiring);
      await pool.query(`UPDATE paypal_markets_auth.${expiring.table}
        SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE ${expiring.column}=$1`, [expiring.hash]);

      const blocker = await pool.connect();
      let operation;
      let settled = false;
      try {
        await blocker.query("BEGIN");
        if (lock === "advisory") {
          await blocker.query("SELECT pg_advisory_xact_lock(1347437612, 1096111176)");
        } else if (lock === "family") {
          await blocker.query("SELECT family_hash FROM paypal_markets_auth.session_families WHERE family_hash=$1 FOR UPDATE", [family]);
        } else if (lock === "transaction") {
          await blocker.query("SELECT handle_hash FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1 FOR UPDATE", [pending]);
        } else if (lock === "session") {
          await blocker.query("SELECT handle_hash FROM paypal_markets_auth.sessions WHERE handle_hash=$1 FOR UPDATE", [prior]);
        } else if (lock === "unique") {
          // An uncommitted duplicate in an unrelated family can block the
          // successor INSERT without also blocking the target family's lock.
          await blocker.query(`INSERT INTO paypal_markets_auth.sessions
            (handle_hash,context_hash,family_hash,family_generation,revoked,account_type,data_scope,expires_at)
            VALUES($1,$2,$3,0,false,$4,$5,clock_timestamp()+interval '30 minutes')`,
          [successor, context, unrelatedFamily, identity.accountType, identity.dataScope]);
        } else {
          throw new Error("Unknown synthetic lock");
        }

        const started = startOnly
          ? store.createTransaction(successor, context, txn, prior, null)
          : store.createSession(successor, context, identity, pending, prior);
        operation = started.then(
          () => { settled = true; return { ok: true }; },
          (error) => { settled = true; return { ok: false, error }; },
        );
        const lockType = lock === "advisory" ? "advisory" : "transactionid";
        let blocked = false;
        for (let attempt = 0; attempt < 60 && !blocked && !settled; attempt++) {
          blocked = (await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND locktype=$1", [lockType])).rows[0].count > 0;
          if (!blocked) await delay(15);
        }
        assert.equal(blocked, true, `${lock}/${expires}: the fixture must observe a blocked operation`);
        const expiryQuery = `FROM paypal_markets_auth.${expiring.table} WHERE ${expiring.column}=$1`;
        assert.equal((await blocker.query(`SELECT expires_at>clock_timestamp() AS live ${expiryQuery}`, [expiring.hash])).rows[0]?.live, true,
          `${lock}/${expires}: the authority must be live while the operation is blocked`);
        await blocker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision + 0.05) ${expiryQuery}`, [expiring.hash]);
        assert.equal((await blocker.query(`SELECT expires_at<=clock_timestamp() AS expired ${expiryQuery}`, [expiring.hash])).rows[0]?.expired, true,
          `${lock}/${expires}: the authority must expire before the lock is released`);
        assert.equal(settled, false, `${lock}/${expires}: the operation must still be waiting, not timing out`);
        // Roll back the synthetic conflicting INSERT so an unchecked successor
        // would otherwise be able to commit; a committed duplicate would mask it.
        await blocker.query(lock === "unique" ? "ROLLBACK" : "COMMIT");
        const result = await operation;
        assert.equal(result.ok, false, `${lock}/${expires}: expired authority must not issue a successor`);
        if (!result.ok) assert.doesNotMatch(String(result.error?.message ?? result.error), /timeout|canceling statement/i,
          `${lock}/${expires}: rejection must not be a database timeout`);
        const table = startOnly ? "login_transactions" : "sessions";
        assert.equal((await blocker.query(`SELECT count(*)::int AS count FROM paypal_markets_auth.${table} WHERE handle_hash=$1`, [successor])).rows[0].count, 0,
          `${lock}/${expires}: no successor may persist`);
        const previous = (await blocker.query("SELECT revoked FROM paypal_markets_auth.sessions WHERE handle_hash=$1", [prior])).rows[0];
        assert.equal(previous?.revoked, false, `${lock}/${expires}: failure must not revoke the prior session`);
        if (expires === "transaction") {
          assert.deepEqual(await store.readSession(prior, context), identity, `${lock}/${expires}: a still-live prior session remains usable`);
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
    }
    for (const [index, lock, expires] of [
      [0, "advisory", "transaction"],
      [1, "family", "family"],
      [2, "family", "transaction"],
      [3, "transaction", "family"],
      [4, "transaction", "transaction"],
      [5, "session", "session"],
      [6, "session", "transaction"],
      [7, "unique", "transaction"],
    ]) {
      await expiresWhileIssuanceWaits({ base: 11000 + index * 10, lock, expires });
    }
    await expiresWhileIssuanceWaits({ base: 11100, lock: "family", expires: "session", startOnly: true });

    // An authority can also expire after the insert while a later statement
    // waits. The final guard must roll back both issuance and revocation.
    {
      const family = key(10050), prior = key(10051), nextTx = key(10052), successor = key(10053);
      await signedIn(family, prior);
      await store.createTransaction(nextTx, context, txn, prior, null);
      assert.deepEqual(await store.consumeTransaction(nextTx, context, txn.state), txn);
      await pool.query(`CREATE FUNCTION paypal_markets_auth.fixture_block_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.handle_hash='${nextTx}' AND NEW.status='completed' THEN
          PERFORM pg_advisory_xact_lock(2026,1107); END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER fixture_block_completion BEFORE UPDATE ON paypal_markets_auth.login_transactions
        FOR EACH ROW EXECUTE FUNCTION paypal_markets_auth.fixture_block_completion()`);
      await pool.query("UPDATE paypal_markets_auth.sessions SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE handle_hash=$1", [prior]);
      const blocker = await pool.connect();
      let operation;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(2026,1107)");
        operation = store.createSession(successor, context, identity, nextTx, prior).then(() => ({ accepted: true }), () => ({ accepted: false }));
        let waiting = false;
        for (let i = 0; i < 50 && !waiting; i++) {
          waiting = (await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count > 0;
          if (!waiting) await delay(15);
        }
        assert.equal(waiting, true, "The final transaction update must actually wait");
        assert.equal((await blocker.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_auth.sessions WHERE handle_hash=$1", [prior])).rows[0].live, true);
        await blocker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision + 0.1)
          FROM paypal_markets_auth.sessions WHERE handle_hash=$1`, [prior]);
        await blocker.query("COMMIT");
        assert.deepEqual(await operation, { accepted: false }, "Expired previous session must roll back late issuance");
        assert.equal((await blocker.query("SELECT count(*)::int AS count FROM paypal_markets_auth.sessions WHERE handle_hash=$1", [successor])).rows[0].count, 0);
        assert.equal((await blocker.query("SELECT revoked FROM paypal_markets_auth.sessions WHERE handle_hash=$1", [prior])).rows[0].revoked, false);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
      await pool.query("DROP TRIGGER fixture_block_completion ON paypal_markets_auth.login_transactions");
      await pool.query("DROP FUNCTION paypal_markets_auth.fixture_block_completion()");
    }

    // Logout commits while A is processing and B is the latest browser transaction cookie.
    await signedIn(key(10100), key(10101));
    await store.createTransaction(key(10102), context, txn, key(10101), null);
    await store.createTransaction(key(10103), context, txn, key(10101), null);
    assert.deepEqual(await store.consumeTransaction(key(10102), context, txn.state), txn);
    await store.logout(key(10101), key(10103));
    await assert.rejects(store.createSession(key(10104), context, identity, key(10102), key(10101)));
    await assert.rejects(store.createTransaction(key(10105), context, txn, key(10101), null));
    assert.equal(await store.readSession(key(10101), context), null);

    // Callback commits first; logout still resolves the stale session alias and revokes its successor.
    await signedIn(key(10200), key(10201));
    await store.createTransaction(key(10202), context, txn, key(10201), null);
    await store.createTransaction(key(10203), context, txn, key(10201), null);
    assert.deepEqual(await store.consumeTransaction(key(10202), context, txn.state), txn);
    await store.createSession(key(10204), context, identity, key(10202), key(10201));
    await store.logout(key(10201), key(10203));
    assert.equal(await store.readSession(key(10204), context), null, "A delayed successor cookie is already revoked");
    assert.equal(await store.consumeTransaction(key(10203), context, txn.state), null);

    // A delayed logout may carry a rotated alias after that old cookie's normal expiry.
    await signedIn(key(10210), key(10211));
    await store.createTransaction(key(10212), context, txn, key(10211), null);
    assert.deepEqual(await store.consumeTransaction(key(10212), context, txn.state), txn);
    await store.createSession(key(10213), context, identity, key(10212), key(10211));
    await pool.query("UPDATE paypal_markets_auth.sessions SET expires_at=now()-interval '36 minutes' WHERE handle_hash=$1", [key(10211)]);
    await store.createTransaction(key(10214), context, txn, null, null); // Runs bounded cleanup.
    await store.logout(key(10211), null);
    assert.equal(await store.readSession(key(10213), context), null, "An old alias remains until its family expires");

    // Exercise actual concurrent database operations as well as both committed orders.
    await signedIn(key(10300), key(10301));
    await store.createTransaction(key(10302), context, txn, key(10301), null);
    assert.deepEqual(await store.consumeTransaction(key(10302), context, txn.state), txn);
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
    await smallStore.consumeTransaction(key(10700), context, txn.state);
    await smallStore.createSession(key(10701), context, identity, key(10700), null);
    await smallStore.createTransaction(key(10702), context, txn, key(10701), null);
    await smallStore.consumeTransaction(key(10702), context, txn.state);
    await smallStore.createSession(key(10703), context, identity, key(10702), key(10701));
    await smallStore.createTransaction(key(10704), context, txn, key(10703), null);
    await smallStore.consumeTransaction(key(10704), context, txn.state);
    await assert.rejects(smallStore.createSession(key(10705), context, identity, key(10704), key(10703)), /capacity/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM paypal_markets_auth.sessions")).rows[0].count, 2);
    assert.deepEqual(await smallStore.readSession(key(10703), context), identity, "Quota rejection must not revoke the current session");
  } finally {
    if (parallelStore) await parallelStore.close();
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
