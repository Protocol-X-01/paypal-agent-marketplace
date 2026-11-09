import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const { Pool } = createRequire(import.meta.url)("pg");
const { createNativePostgresStore } = load("src/lib/customer-auth/native-store.ts");

// Run only through the opt-in guarded runner. This creates a fresh cluster on a
// private Unix socket; it never uses a configured database or a real provider.
test("native claim abort is bound to its exact unissued claim and preserves sessions", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 45_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-native-abort-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  let server, serverError, pool, store, secondStore;
  try {
    const init = spawnSync(`${bin}/initdb`, [
      "-D", data, "--auth=trust", "--no-sync", "--username=auth_fixture",
    ], { env: safeEnv, stdio: "inherit", timeout: 10_000 });
    assert.equal(init.status, 0, `Synthetic database initialization failed: ${init.error?.code ?? init.status ?? "unknown"}`);
    server = spawn(`${bin}/postgres`, [
      "-D", data, "-k", socket, "-p", "5432",
      "-c", "listen_addresses=", "-c", "max_connections=8",
      "-c", "shared_buffers=12MB", "-c", "max_worker_processes=0",
      "-c", "max_parallel_workers=0", "-c", "max_wal_senders=0",
      "-c", "autovacuum=off", "-c", "track_activities=off",
      "-c", "fsync=off", "-c", "full_page_writes=off",
    ], { env: safeEnv, stdio: "ignore" });
    server.on("error", (error) => { serverError = error; });

    // All connection fields are synthetic and the host is the private socket.
    // A nonempty fixture password prevents pg from consulting PGPASSWORD; trust
    // authentication never uses it. The runner also supplies a cleared environment.
    const settings = {
      host: socket, port: 5432, user: "auth_fixture", password: "fixture-unused",
      database: "postgres", ssl: false, sslnegotiation: "postgres",
      application_name: "paypal-native-abort-fixture", client_encoding: "UTF8",
      options: "-c search_path=pg_catalog", connectionTimeoutMillis: 1_000,
    };
    pool = new Pool({ ...settings, max: 1 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Synthetic database exited during startup");
      try { await pool.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");
    await pool.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));
    store = createNativePostgresStore(settings);
    secondStore = createNativePostgresStore(settings);
    assert.equal(await store.ready(), true);
    assert.equal(await secondStore.ready(), true);

    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), foreign = key(9998);
    const verifier = token(1), wrongVerifier = token(9), state = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const identity = { accountType: "business", dataScope: `v1_${token(6)}` };
    const input = { state, challenge, platform: "android" };
    let sequence = 100;
    const fresh = () => ({
      handoff: key(sequence++), browser: key(sequence++), claim: key(sequence++),
      reservation: key(sequence++), code: key(sequence++), session: key(sequence++),
    });
    const handoffRow = async (h) => (await pool.query(
      "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [h],
    )).rows[0];
    const familyRow = async (h) => (await pool.query(
      "SELECT * FROM paypal_markets_native_auth.families WHERE family_hash=$1", [h],
    )).rows[0];
    const sessionRow = async (h) => (await pool.query(
      "SELECT * FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [h],
    )).rows[0];
    const identityOf = async (h) => {
      const value = await store.readSession(h, context);
      return value && { accountType: value.accountType, dataScope: value.dataScope };
    };
    async function start(prior = null) {
      const f = fresh();
      await store.createHandoff(f.handoff, context, input, prior);
      return f;
    }
    const claim = (f) => store.claimHandoff(f.handoff, context, f.browser, provider, f.claim);
    const reserve = (f, target = store, reservation = f.reservation) =>
      target.reserveProvider(f.handoff, context, f.browser, provider.state, reservation);
    const complete = (f, reservation = f.reservation) =>
      store.completeProvider(f.handoff, context, reservation, f.code, identity);
    const exchange = (f) => store.exchange(f.handoff, context, {
      state, verifier, codeHash: f.code, sessionHash: f.session,
    });
    const expectedReservation = { transaction: provider, appState: state, platform: "android" };
    async function signedIn(prior = null) {
      const f = await start(prior);
      await claim(f);
      assert.deepEqual(await reserve(f), expectedReservation);
      await complete(f);
      await exchange(f);
      return f;
    }
    const scrubbed = (before) => ({
      ...before, status: "cancelled", browser_hash: null, provider_state: null,
      provider_nonce: null, provider_verifier: null, reservation_hash: null,
      code_hash: null, code_expires_at: null, account_type: null, data_scope: null,
    });

    // Even schema-permitted unexpected code/account fields must be cleared by a
    // matching abort, while its handoff proof, family and prior session survive.
    const base = await signedIn();
    const target = await start(base.session);
    await claim(target);
    await pool.query(`UPDATE paypal_markets_native_auth.handoffs SET code_hash=$2,
      code_expires_at=clock_timestamp()+interval '1 minute',account_type=$3,data_scope=$4
      WHERE handle_hash=$1`, [target.handoff, key(sequence++), identity.accountType, identity.dataScope]);
    const before = await handoffRow(target.handoff);
    const previous = await sessionRow(base.session), family = await familyRow(base.handoff);
    assert.equal(before.status, "claimed");
    assert.equal(before.reservation_hash, target.claim);
    for (const args of [
      [key(sequence++), context, target.browser, target.claim],
      [target.handoff, foreign, target.browser, target.claim],
      [target.handoff, context, key(sequence++), target.claim],
      [target.handoff, context, target.browser, key(sequence++)],
    ]) {
      await store.abortClaim(...args);
      assert.deepEqual(await handoffRow(target.handoff), before, "Wrong binding must not alter the claim");
    }
    await store.abortClaim(target.handoff, context, target.browser, target.claim);
    assert.deepEqual(await handoffRow(target.handoff), scrubbed(before));
    assert.deepEqual(await sessionRow(base.session), previous);
    assert.deepEqual(await familyRow(base.handoff), family);
    assert.deepEqual(await identityOf(base.session), identity);
    await store.abortClaim(target.handoff, context, target.browser, target.claim);
    assert.deepEqual(await handoffRow(target.handoff), scrubbed(before), "Abort must be idempotent");
    assert.equal(await reserve(target), null, "A reserved code cannot follow an aborted claim");
    assert.equal(await store.cancel(target.handoff, context, wrongVerifier), false);
    assert.equal(await store.cancel(target.handoff, context, verifier), true);
    assert.deepEqual(await identityOf(base.session), identity, "Cancelling an unissued proof must preserve its prior session");

    // Expiry of either the handoff or its predecessor must not stop the
    // ownership-bound abort. An expired predecessor is retained, not revived.
    const expiredBase = await signedIn();
    const expired = await start(expiredBase.session);
    await claim(expired);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET expires_at=clock_timestamp()-interval '1 second' WHERE handle_hash=$1", [expired.handoff]);
    const expiredBefore = await handoffRow(expired.handoff), expiredFamily = await familyRow(expiredBase.handoff);
    await store.abortClaim(expired.handoff, context, expired.browser, expired.claim);
    assert.deepEqual(await handoffRow(expired.handoff), scrubbed(expiredBefore));
    assert.deepEqual(await familyRow(expiredBase.handoff), expiredFamily);
    assert.deepEqual(await identityOf(expiredBase.session), identity);

    const priorExpiredBase = await signedIn();
    const priorExpired = await start(priorExpiredBase.session);
    await claim(priorExpired);
    await pool.query("UPDATE paypal_markets_native_auth.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE handle_hash=$1", [priorExpiredBase.session]);
    const priorExpiredBefore = await handoffRow(priorExpired.handoff);
    const expiredPrevious = await sessionRow(priorExpiredBase.session);
    await store.abortClaim(priorExpired.handoff, context, priorExpired.browser, priorExpired.claim);
    assert.deepEqual(await handoffRow(priorExpired.handoff), scrubbed(priorExpiredBefore));
    assert.deepEqual(await sessionRow(priorExpiredBase.session), expiredPrevious);
    assert.equal(expiredPrevious.revoked, false);
    assert.equal(await store.readSession(priorExpiredBase.session, context), null);

    // A reused hash cannot authorize abort in processing or ready state. The
    // ready-row tag is synthetic but schema-permitted and tests the status gate.
    const transitionBase = await signedIn();
    const transition = await start(transitionBase.session);
    await claim(transition);
    assert.deepEqual(await reserve(transition, store, transition.claim), expectedReservation);
    const processing = await handoffRow(transition.handoff);
    assert.equal(processing.status, "processing");
    assert.equal(processing.reservation_hash, transition.claim);
    await store.abortClaim(transition.handoff, context, transition.browser, transition.claim);
    assert.deepEqual(await handoffRow(transition.handoff), processing);
    assert.deepEqual(await identityOf(transitionBase.session), identity);
    await complete(transition, transition.claim);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET reservation_hash=$2 WHERE handle_hash=$1", [transition.handoff, transition.claim]);
    const readyBefore = await handoffRow(transition.handoff);
    assert.equal(readyBefore.status, "ready");
    await store.abortClaim(transition.handoff, context, transition.browser, transition.claim);
    assert.deepEqual(await handoffRow(transition.handoff), readyBefore);
    assert.deepEqual(await identityOf(transitionBase.session), identity);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET reservation_hash=NULL WHERE handle_hash=$1", [transition.handoff]);
    await exchange(transition);
    const exchanged = await handoffRow(transition.handoff);
    assert.equal(exchanged.issued, true);
    await store.abortClaim(transition.handoff, context, transition.browser, transition.claim);
    assert.deepEqual(await handoffRow(transition.handoff), exchanged);
    assert.deepEqual(await identityOf(transition.session), identity);

    // The schema does not forbid this inconsistent combination; specifically
    // test the issued guard even when status, browser and tag otherwise match.
    const issuedBase = await signedIn();
    const issued = await start(issuedBase.session);
    await claim(issued);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET issued=true WHERE handle_hash=$1", [issued.handoff]);
    const issuedBefore = await handoffRow(issued.handoff);
    await store.abortClaim(issued.handoff, context, issued.browser, issued.claim);
    assert.deepEqual(await handoffRow(issued.handoff), issuedBefore);
    assert.deepEqual(await identityOf(issuedBase.session), identity);

    // Older stores left reservation_hash NULL in claimed rows. The new reserve
    // path must still accept that row and finish the same synthetic sign-in.
    const legacyBase = await signedIn();
    const legacy = await start(legacyBase.session);
    await claim(legacy);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET reservation_hash=NULL WHERE handle_hash=$1", [legacy.handoff]);
    const legacyBefore = await handoffRow(legacy.handoff);
    await store.abortClaim(legacy.handoff, context, legacy.browser, legacy.claim);
    assert.deepEqual(await handoffRow(legacy.handoff), legacyBefore);
    assert.deepEqual(await reserve(legacy), expectedReservation);
    const legacyProcessing = await handoffRow(legacy.handoff);
    assert.equal(legacyProcessing.status, "processing");
    assert.equal(legacyProcessing.reservation_hash, legacy.reservation);
    assert.equal(legacyProcessing.provider_state, null);
    assert.equal(legacyProcessing.provider_nonce, null);
    assert.equal(legacyProcessing.provider_verifier, null);
    await complete(legacy);
    await exchange(legacy);
    assert.equal(await store.readSession(legacyBase.session, context), null);
    assert.deepEqual(await identityOf(legacy.session), identity);

    // Both operations wait on the real store advisory lock. After release,
    // either abort wins before reservation or reservation wins and is retained.
    const raceBase = await signedIn();
    const race = await start(raceBase.session);
    await claim(race);
    const blocker = await pool.connect();
    let results;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(1347437612, 1312904278)");
      results = Promise.allSettled([
        reserve(race, store),
        secondStore.abortClaim(race.handoff, context, race.browser, race.claim),
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const count = (await blocker.query(`SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype='advisory' AND NOT granted AND classid=1347437612::oid
            AND objid=1312904278::oid AND objsubid=2`)).rows[0].n;
        waiting = count >= 2;
        if (!waiting) await delay(15);
      }
      assert.equal(waiting, true, "Both operations must actually wait on the advisory lock");
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    const [reserved, aborted] = await results;
    assert.equal(reserved.status, "fulfilled");
    assert.equal(aborted.status, "fulfilled");
    const raced = await handoffRow(race.handoff);
    assert.deepEqual(await identityOf(raceBase.session), identity, "Neither race outcome revokes the previous session");
    if (reserved.value === null) {
      assert.equal(raced.status, "cancelled");
      assert.equal(raced.provider_verifier, null);
      assert.equal(raced.reservation_hash, null);
    } else {
      assert.deepEqual(reserved.value, expectedReservation);
      assert.equal(raced.status, "processing");
      assert.equal(raced.reservation_hash, race.reservation);
      await complete(race);
      await exchange(race);
      assert.deepEqual(await identityOf(race.session), identity);
    }
  } finally {
    if (secondStore) await secondStore.close();
    if (store) await store.close();
    if (pool) await pool.end();
    if (server && server.exitCode === null && server.signalCode === null && !serverError) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([exited, delay(3_000)]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await Promise.race([exited, delay(2_000)]);
      }
    }
    if (server && !serverError && server.exitCode === null && server.signalCode === null) {
      throw new Error(`Synthetic database did not stop; fixture preserved at ${work}`);
    }
    rmSync(work, { recursive: true, force: true });
  }
});
