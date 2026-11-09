import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { createNativePostgresStore } = load("src/lib/customer-auth/native-store.ts");

// The guarded runner must opt in. Never use a configured or existing database.
test("native PostgreSQL enforces challenge-bound one-use handoffs and revocable session families", { skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1", timeout: 45_000 }, async () => {
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
  let secondStore;
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
    store = createNativePostgresStore(settings);
    assert.equal(await store.ready(), false, "Missing schema must fail closed");
    await pool.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));
    assert.equal(await store.ready(), true);

    const key = n => n.toString(16).padStart(64, "0");
    const token = n => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), foreign = key(9998), verifier = token(1), state = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const owner = { accountType: "business", dataScope: `v1_${token(6)}` };
    let sequence = 100;
    const fresh = () => ({ handoff: key(sequence++), browser: key(sequence++), claim: key(sequence++), reservation: key(sequence++), code: key(sequence++), session: key(sequence++) });
    async function start(prior = null, target = store) {
      const f = fresh(); await target.createHandoff(f.handoff, context, { state, challenge, platform: "android" }, prior); return f;
    }
    async function prepare(f, target = store) {
      await target.claimHandoff(f.handoff, context, f.browser, provider, f.claim);
      assert.deepEqual(await target.reserveProvider(f.handoff, context, f.browser, provider.state, f.reservation), { transaction: provider, appState: state, platform: "android" });
      await target.completeProvider(f.handoff, context, f.reservation, f.code, owner); return f;
    }
    const exchange = (f, target = store, overrides = {}) => target.exchange(f.handoff, context, { state, verifier, codeHash: f.code, sessionHash: f.session, ...overrides });
    const signedIn = async (prior = null) => { const f = await start(prior); await prepare(f); await exchange(f); return f; };
    const identityOf = async h => { const r = await store.readSession(h, context); return r && { accountType: r.accountType, dataScope: r.dataScope }; };

    // Every case observes a real PostgreSQL lock wait while the authority is
    // still live, then releases only after it expires. No real provider or
    // configured database participates in this opt-in isolated fixture.
    async function expiresDuringWait({ table, column, target, lock, action, expected, verify, conflict, keyColumn = "handle_hash" }) {
      await pool.query(`UPDATE paypal_markets_native_auth.${table} SET ${column}=clock_timestamp()+interval '1500 milliseconds' WHERE ${keyColumn}=$1`, [target]);
      const blocker = await pool.connect();
      let operation, settled = false;
      try {
        await blocker.query("BEGIN");
        await lock(blocker);
        operation = action().then(value => { settled = true; return { ok: true, value }; }, error => { settled = true; return { ok: false, error }; });
        let blocked = false;
        for (let attempt = 0; attempt < 60 && !blocked && !settled; attempt++) {
          blocked = (await blocker.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND locktype=$1", [conflict ? "transactionid" : "advisory"])).rows[0].count > 0;
          if (!blocked) await delay(15);
        }
        assert.equal(blocked, true, `${expected}: fixture must observe the intended lock wait`);
        const from = `FROM paypal_markets_native_auth.${table} WHERE ${keyColumn}=$1`;
        assert.equal((await blocker.query(`SELECT ${column}>clock_timestamp() AS live ${from}`, [target])).rows[0]?.live, true, "authority must be live while blocked");
        await blocker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${column}-clock_timestamp())))::double precision + 0.05) ${from}`, [target]);
        assert.equal((await blocker.query(`SELECT ${column}<=clock_timestamp() AS expired ${from}`, [target])).rows[0]?.expired, true, "authority must expire before release");
        assert.equal(settled, false, "operation must remain blocked rather than timing out");
        await blocker.query(conflict === "unique" ? "ROLLBACK" : "COMMIT");
        const result = await operation;
        if (expected === "unavailable") {
          assert.equal(result.ok, false, "expired authority must reject");
          if (!result.ok) {
            assert.equal(result.error?.code, "unavailable");
            assert.doesNotMatch(String(result.error?.message ?? result.error), /timeout|canceling statement/i);
          }
        } else {
          assert.equal(result.ok, true);
          if (result.ok) assert.equal(result.value, expected === "false" ? false : null);
        }
        await verify(blocker);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (operation) await operation;
      }
    }
    const advisoryLock = c => c.query("SELECT pg_advisory_xact_lock(1347437612, 1312904278)");
    const rowLock = (table, hash, keyColumn = "handle_hash") => c => c.query(`SELECT 1 FROM paypal_markets_native_auth.${table} WHERE ${keyColumn}=$1 FOR UPDATE`, [hash]);
    const noIssuedSession = async (c, attempt, previous = null) => {
      const saved = (await c.query(`SELECT h.status,h.issued,f.generation,
        (SELECT count(*)::int FROM paypal_markets_native_auth.sessions WHERE handle_hash=$2) AS session_count
        FROM paypal_markets_native_auth.handoffs h JOIN paypal_markets_native_auth.families f USING(family_hash) WHERE h.handle_hash=$1`,
      [attempt.handoff, attempt.session])).rows[0];
      assert.equal(saved?.status, "ready"); assert.equal(saved?.issued, false); assert.equal(saved?.session_count, 0);
      assert.equal(saved?.generation, previous ? 1 : 0, "failed exchange must not rotate the family");
      if (previous) assert.equal((await c.query("SELECT revoked FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [previous])).rows[0]?.revoked, false);
    };

    const advisoryExpiry = await start(); await prepare(advisoryExpiry);
    await expiresDuringWait({ table: "handoffs", column: "code_expires_at", target: advisoryExpiry.handoff, lock: advisoryLock,
      action: () => exchange(advisoryExpiry), expected: "unavailable", verify: c => noIssuedSession(c, advisoryExpiry) });

    const rowExpiry = await start(); await prepare(rowExpiry);
    await expiresDuringWait({ table: "handoffs", column: "code_expires_at", target: rowExpiry.handoff, lock: rowLock("handoffs", rowExpiry.handoff), conflict: "row",
      action: () => exchange(rowExpiry), expected: "unavailable", verify: c => noIssuedSession(c, rowExpiry) });

    const familyExpiry = await start(); await prepare(familyExpiry);
    await expiresDuringWait({ table: "families", column: "expires_at", target: familyExpiry.handoff, keyColumn: "family_hash",
      lock: rowLock("families", familyExpiry.handoff, "family_hash"), conflict: "row", action: () => exchange(familyExpiry),
      expected: "unavailable", verify: c => noIssuedSession(c, familyExpiry) });

    const priorForConflict = await signedIn(); const uniqueExpiry = await start(priorForConflict.session); await prepare(uniqueExpiry);
    const unrelated = await start();
    await expiresDuringWait({ table: "handoffs", column: "code_expires_at", target: uniqueExpiry.handoff, conflict: "unique",
      lock: c => c.query(`INSERT INTO paypal_markets_native_auth.sessions(handle_hash,context_hash,family_hash,family_generation,revoked,account_type,data_scope,expires_at)
        VALUES($1,$2,$3,0,false,$4,$5,clock_timestamp()+interval '30 minutes')`, [uniqueExpiry.session, context, unrelated.handoff, owner.accountType, owner.dataScope]),
      action: () => exchange(uniqueExpiry), expected: "unavailable", verify: c => noIssuedSession(c, uniqueExpiry, priorForConflict.session) });

    const priorForExchange = await signedIn(); const previousExpiry = await start(priorForExchange.session); await prepare(previousExpiry);
    await expiresDuringWait({ table: "sessions", column: "expires_at", target: priorForExchange.session,
      lock: rowLock("sessions", priorForExchange.session), conflict: "row", action: () => exchange(previousExpiry),
      expected: "unavailable", verify: c => noIssuedSession(c, previousExpiry, priorForExchange.session) });

    // Pause after the store revoked its prior alias but before the final family
    // update. The trigger observes this transaction's uncommitted revocation;
    // the final advancing-clock guard must roll the entire exchange back.
    const priorForFinalCheck = await signedIn(); const finalExpiry = await start(priorForFinalCheck.session); await prepare(finalExpiry);
    await pool.query(`CREATE FUNCTION paypal_markets_native_auth.test_expiry_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='exchanged' THEN
          IF NEW.initial_session_hash IS NULL OR NOT EXISTS (SELECT 1 FROM paypal_markets_native_auth.sessions s
            WHERE s.handle_hash=NEW.initial_session_hash AND s.revoked) THEN
            RAISE EXCEPTION 'fixture did not observe prior revocation';
          END IF;
          PERFORM pg_advisory_xact_lock(1347437612, 1163416652);
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER test_expiry_gate BEFORE UPDATE OF status ON paypal_markets_native_auth.handoffs
      FOR EACH ROW EXECUTE FUNCTION paypal_markets_native_auth.test_expiry_gate()`);
    try {
      await expiresDuringWait({ table: "sessions", column: "expires_at", target: priorForFinalCheck.session,
        lock: c => c.query("SELECT pg_advisory_xact_lock(1347437612, 1163416652)"),
        action: () => exchange(finalExpiry), expected: "unavailable",
        verify: c => noIssuedSession(c, finalExpiry, priorForFinalCheck.session) });
    } finally {
      await pool.query("DROP TRIGGER test_expiry_gate ON paypal_markets_native_auth.handoffs");
      await pool.query("DROP FUNCTION paypal_markets_native_auth.test_expiry_gate()");
    }

    const sessionExpiry = await signedIn();
    await expiresDuringWait({ table: "sessions", column: "expires_at", target: sessionExpiry.session, lock: advisoryLock,
      action: () => store.readSession(sessionExpiry.session, context), expected: "null", verify: async () => {} });

    const startExpiry = await start();
    await expiresDuringWait({ table: "handoffs", column: "expires_at", target: startExpiry.handoff, lock: advisoryLock,
      action: () => store.canStartHandoff(startExpiry.handoff, context), expected: "false", verify: async () => {} });

    const claimExpiry = await start();
    await expiresDuringWait({ table: "handoffs", column: "expires_at", target: claimExpiry.handoff, lock: rowLock("handoffs", claimExpiry.handoff), conflict: "row",
      action: () => store.claimHandoff(claimExpiry.handoff, context, claimExpiry.browser, provider, claimExpiry.claim), expected: "unavailable",
      verify: async c => assert.equal((await c.query("SELECT status FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [claimExpiry.handoff])).rows[0]?.status, "pending") });

    const reserveExpiry = await start(); await store.claimHandoff(reserveExpiry.handoff, context, reserveExpiry.browser, provider, reserveExpiry.claim);
    await expiresDuringWait({ table: "handoffs", column: "expires_at", target: reserveExpiry.handoff, lock: rowLock("handoffs", reserveExpiry.handoff), conflict: "row",
      action: () => store.reserveProvider(reserveExpiry.handoff, context, reserveExpiry.browser, provider.state, reserveExpiry.reservation), expected: "null",
      verify: async c => assert.equal((await c.query("SELECT status FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [reserveExpiry.handoff])).rows[0]?.status, "claimed") });

    const priorForClaim = await signedIn(); const claimPriorExpiry = await start(priorForClaim.session);
    await expiresDuringWait({ table: "sessions", column: "expires_at", target: priorForClaim.session, lock: rowLock("sessions", priorForClaim.session), conflict: "row",
      action: () => store.claimHandoff(claimPriorExpiry.handoff, context, claimPriorExpiry.browser, provider, claimPriorExpiry.claim), expected: "unavailable",
      verify: async c => assert.equal((await c.query("SELECT status FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [claimPriorExpiry.handoff])).rows[0]?.status, "pending") });

    const priorForReserve = await signedIn(); const reservePriorExpiry = await start(priorForReserve.session);
    await store.claimHandoff(reservePriorExpiry.handoff, context, reservePriorExpiry.browser, provider, reservePriorExpiry.claim);
    await expiresDuringWait({ table: "sessions", column: "expires_at", target: priorForReserve.session, lock: rowLock("sessions", priorForReserve.session), conflict: "row",
      action: () => store.reserveProvider(reservePriorExpiry.handoff, context, reservePriorExpiry.browser, provider.state, reservePriorExpiry.reservation), expected: "null",
      verify: async c => assert.equal((await c.query("SELECT status FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [reservePriorExpiry.handoff])).rows[0]?.status, "claimed") });

    const completeExpiry = await start(); await store.claimHandoff(completeExpiry.handoff, context, completeExpiry.browser, provider, completeExpiry.claim);
    assert.ok(await store.reserveProvider(completeExpiry.handoff, context, completeExpiry.browser, provider.state, completeExpiry.reservation));
    const unrelatedHandoff = await start();
    await expiresDuringWait({ table: "handoffs", column: "expires_at", target: completeExpiry.handoff, conflict: "unique",
      lock: c => c.query("UPDATE paypal_markets_native_auth.handoffs SET code_hash=$1 WHERE handle_hash=$2", [completeExpiry.code, unrelatedHandoff.handoff]),
      action: () => store.completeProvider(completeExpiry.handoff, context, completeExpiry.reservation, completeExpiry.code, owner), expected: "unavailable",
      verify: async c => {
        const saved = (await c.query("SELECT status,code_hash FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [completeExpiry.handoff])).rows[0];
        assert.equal(saved?.status, "processing"); assert.equal(saved?.code_hash, null);
      } });

    const priorForStart = await signedIn(); const existingHandoff = await start(priorForStart.session); const newHandoff = fresh();
    await expiresDuringWait({ table: "sessions", column: "expires_at", target: priorForStart.session, lock: rowLock("sessions", priorForStart.session), conflict: "row",
      action: () => store.createHandoff(newHandoff.handoff, context, { state, challenge, platform: "android" }, priorForStart.session), expected: "unavailable",
      verify: async c => {
        assert.equal((await c.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [newHandoff.handoff])).rows[0].n, 0);
        assert.equal((await c.query("SELECT status FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [existingHandoff.handoff])).rows[0]?.status, "pending");
      } });

    const f = await start();
    assert.equal(await store.canStartHandoff(f.handoff, context), true);
    assert.equal(await store.canStartHandoff(f.handoff, foreign), false);
    await assert.rejects(store.createHandoff(key(900), context, { state, challenge, platform: "other" }, null));
    await assert.rejects(store.claimHandoff(f.handoff, foreign, f.browser, provider, f.claim));
    const claims = await Promise.allSettled([store.claimHandoff(f.handoff, context, f.browser, provider, f.claim), store.claimHandoff(f.handoff, context, key(999), provider, key(998))]);
    assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await store.canStartHandoff(f.handoff, context), false);
    // Determine which concurrent browser won without leaking provider material to the loser.
    const browser = claims[0].status === "fulfilled" ? f.browser : key(999);
    assert.equal(await store.reserveProvider(f.handoff, context, browser, token(7), f.reservation), null);
    assert.equal(await store.reserveProvider(f.handoff, context, key(997), provider.state, f.reservation), null);
    const reservations = await Promise.all([store.reserveProvider(f.handoff, context, browser, provider.state, f.reservation), store.reserveProvider(f.handoff, context, browser, provider.state, key(996))]);
    assert.equal(reservations.filter(Boolean).length, 1);
    const reservation = reservations[0] ? f.reservation : key(996);
    await store.completeProvider(f.handoff, context, reservation, f.code, owner);
    await assert.rejects(store.completeProvider(f.handoff, context, reservation, key(995), owner));
    await assert.rejects(exchange(f, store, { verifier: token(8) }));
    await assert.rejects(exchange(f, store, { state: token(9) }));
    await assert.rejects(exchange(f, store, { codeHash: key(994) }));
    secondStore = createNativePostgresStore(settings);
    const exchanges = await Promise.allSettled([exchange(f), exchange(f, secondStore, { sessionHash: key(993) })]);
    assert.equal(exchanges.filter(r => r.status === "fulfilled").length, 1);
    const issuedSession = exchanges[0].status === "fulfilled" ? f.session : key(993);
    assert.deepEqual(await identityOf(issuedSession), owner);
    assert.equal(await store.readSession(issuedSession, foreign), null);
    const successful = exchanges.find(r => r.status === "fulfilled").value;
    assert.ok(Date.parse(successful.expiresAt) - Date.now() <= 1800000);
    assert.ok(Date.parse(successful.expiresAt) - Date.now() > 1790000);
    await assert.rejects(exchange(f));
    assert.equal(await store.cancel(f.handoff, context, token(9)), false);
    assert.equal(await store.cancel(f.handoff, context, verifier), true, "Lost response can revoke issued family");
    assert.equal(await identityOf(issuedSession), null);
    assert.equal(await store.cancel(f.handoff, context, verifier), true);
    assert.equal(await store.logout(issuedSession, context), true);

    const expired = await start(); await prepare(expired);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET code_expires_at=now()-interval '1 second' WHERE handle_hash=$1", [expired.handoff]);
    await assert.rejects(exchange(expired));
    const expiredHandoff = await start();
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET expires_at=now()-interval '1 second' WHERE handle_hash=$1", [expiredHandoff.handoff]);
    await assert.rejects(store.claimHandoff(expiredHandoff.handoff, context, expiredHandoff.browser, provider, expiredHandoff.claim));

    // Cancellation while provider request is in flight must prevent finalization.
    const cancelled = await start(); await store.claimHandoff(cancelled.handoff, context, cancelled.browser, provider, cancelled.claim);
    await store.reserveProvider(cancelled.handoff, context, cancelled.browser, provider.state, cancelled.reservation);
    assert.equal(await store.cancel(cancelled.handoff, context, verifier), true);
    await assert.rejects(store.completeProvider(cancelled.handoff, context, cancelled.reservation, cancelled.code, owner));

    // Failed reauthentication keeps current session; newer attempt supersedes older callback.
    const original = await signedIn();
    const abandoned = await start(original.session); await prepare(abandoned);
    assert.equal(await store.cancel(abandoned.handoff, context, verifier), true);
    assert.deepEqual(await identityOf(original.session), owner);
    const old = await start(original.session); await prepare(old);
    const replacement = await start(original.session); await prepare(replacement);
    await assert.rejects(exchange(old));
    await exchange(replacement);
    assert.equal(await identityOf(original.session), null);
    assert.deepEqual(await identityOf(replacement.session), owner);
    const third = await signedIn(replacement.session);
    // Expired normal session aliases and original cancellation proof survive descendants.
    await pool.query("UPDATE paypal_markets_native_auth.sessions SET expires_at=now()-interval '1 second' WHERE handle_hash=$1", [original.session]);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET expires_at=now()-interval '1 second' WHERE handle_hash=$1", [original.handoff]);
    await start(); // Bounded cleanup must retain proof while family remains active.
    assert.equal(await store.cancel(original.handoff, context, verifier), true);
    assert.equal(await identityOf(third.session), null);

    const logoutOriginal = await signedIn();
    const logoutReplacement = await signedIn(logoutOriginal.session);
    await pool.query("UPDATE paypal_markets_native_auth.sessions SET expires_at=now()-interval '1 second' WHERE handle_hash=$1", [logoutOriginal.session]);
    await start();
    assert.equal((await pool.query("SELECT count(*) AS n FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [logoutOriginal.session])).rows[0].n, "1", "Cleanup must retain an expired alias while its descendant is live");
    assert.equal(await store.cancel(logoutOriginal.handoff, foreign, verifier), false);
    assert.equal(await store.logout(logoutOriginal.session, foreign), false);
    assert.deepEqual(await identityOf(logoutReplacement.session), owner);
    assert.equal(await store.logout(logoutOriginal.session, context), true);
    assert.equal(await identityOf(logoutReplacement.session), null);
    assert.equal(await store.logout(key(9000), context), true);
    assert.equal(await store.cancel(key(9001), context, verifier), true);

    const expiredFamily = await signedIn();
    await pool.query("UPDATE paypal_markets_native_auth.families SET expires_at=now()-interval '1 second' WHERE family_hash=$1", [expiredFamily.handoff]);
    assert.equal(await store.logout(expiredFamily.session, foreign), false);
    assert.equal(await store.cancel(expiredFamily.handoff, context, token(9)), false);
    assert.equal(await store.logout(expiredFamily.session, context), true, "Known expired family is terminal without waiting for cleanup");
    assert.equal(await store.cancel(expiredFamily.handoff, context, verifier), true);
    await start();
    assert.equal((await pool.query("SELECT count(*) AS n FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [expiredFamily.session])).rows[0].n, "0");
    assert.equal((await pool.query("SELECT count(*) AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [expiredFamily.handoff])).rows[0].n, "0");
    assert.equal(await store.logout(expiredFamily.session, context), true, "Removed expired alias remains terminal");
    assert.equal(await store.cancel(expiredFamily.handoff, context, verifier), true, "Removed cancel proof remains terminal");

    // Both committed orders and actual concurrent cancel/exchange have one outcome: revoked.
    const race = await start(); await prepare(race);
    const raced = await Promise.allSettled([exchange(race, secondStore), store.cancel(race.handoff, context, verifier)]);
    assert.equal(raced[1].status, "fulfilled"); assert.equal(raced[1].value, true);
    assert.equal(await identityOf(race.session), null);
    const logoutRaceBase = await signedIn(); const logoutRace = await start(logoutRaceBase.session); await prepare(logoutRace);
    const logoutRaced = await Promise.allSettled([exchange(logoutRace, secondStore), store.logout(logoutRaceBase.session, context)]);
    assert.equal(logoutRaced[1].status, "fulfilled"); assert.equal(await identityOf(logoutRace.session), null);

    // Database identity columns cannot accidentally persist provider access tokens/profiles.
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='paypal_markets_native_auth' AND table_name='sessions' ORDER BY ordinal_position")).rows.map(r => r.column_name);
    assert.deepEqual(columns, ["handle_hash", "context_hash", "family_hash", "family_generation", "revoked", "account_type", "data_scope", "expires_at"]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM paypal_markets_native_auth.handoffs WHERE status NOT IN ('claimed') AND provider_verifier IS NOT NULL")).rows[0].n, 0);
    await secondStore.close(); secondStore = null;
    await store.close(); store = null;
    const reset = () => pool.query("TRUNCATE paypal_markets_native_auth.handoffs,paypal_markets_native_auth.sessions,paypal_markets_native_auth.families");
    await reset();
    smallStore = createNativePostgresStore(settings, { families: 2, handoffs: 4, sessions: 3 });
    const a = await start(null, smallStore), b = await start(null, smallStore);
    await smallStore.cancel(a.handoff, context, verifier); await smallStore.cancel(b.handoff, context, verifier);
    await assert.rejects(start(null, smallStore), /capacity/);
    await smallStore.close(); smallStore = null; await reset();
    smallStore = createNativePostgresStore(settings, { families: 4, handoffs: 2, sessions: 3 });
    await start(null, smallStore);
    const capped = await Promise.allSettled([start(null, smallStore), start(null, smallStore)]);
    assert.equal(capped.filter(r => r.status === "fulfilled").length, 1);
    await smallStore.close(); smallStore = null; await reset();
    smallStore = createNativePostgresStore(settings, { families: 4, handoffs: 8, sessions: 1 });
    const limited = await start(null, smallStore); await prepare(limited, smallStore); await exchange(limited, smallStore);
    const rotation = await start(limited.session, smallStore); await prepare(rotation, smallStore);
    await assert.rejects(exchange(rotation, smallStore), /capacity/);
    assert.ok(await smallStore.readSession(limited.session, context), "Capacity error preserves prior session");
    // Expired families are eligible for bounded cleanup, including retained aliases.
    await pool.query("UPDATE paypal_markets_native_auth.families SET expires_at=now()-interval '1 second'");
    const afterCleanup = await start(null, smallStore); await prepare(afterCleanup, smallStore); await exchange(afterCleanup, smallStore);
    assert.ok(await smallStore.readSession(afterCleanup.session, context));
  } finally {
    if (secondStore) await secondStore.close();
    if (smallStore) await smallStore.close();
    if (store) await store.close();
    if (pool) await pool.end();
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise(resolve => server.once("exit", resolve)), delay(3000)]);
      if (server.exitCode === null) { server.kill("SIGKILL"); await new Promise(resolve => server.once("exit", resolve)); }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
