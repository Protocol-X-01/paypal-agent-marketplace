import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const pg = createRequire(import.meta.url)("pg");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The guarded runner must opt in. The only database is a newly initialized
// cluster listening on its private Unix socket; all records are fictional.
test("native maintenance commits its family-first scrub before expired-child deletion", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 45_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-lock-order-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  const scrubGate = { entered: deferred(), resume: deferred() };
  const deletionGate = deferred();
  const deletionStarted = deferred();
  const control = { target: "", sawScrub: false, scrubCommitDelivered: false, deletionPaused: false };
  const clients = new Set(), tracked = [];
  let server, serverError, pool, store;
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
      "-c", "deadlock_timeout=4s", "-c", "fsync=off", "-c", "full_page_writes=off",
    ], { env: safeEnv, stdio: "ignore" });
    server.on("error", (error) => { serverError = error; });
    const settings = {
      host: socket, port: 5432, user: "auth_fixture", password: "fixture-unused",
      database: "postgres", ssl: false, sslnegotiation: "postgres",
      application_name: "paypal-lock-order-fixture", client_encoding: "UTF8",
      options: "-c search_path=pg_catalog", connectionTimeoutMillis: 1_000,
      statement_timeout: 8_500, query_timeout: 9_000,
    };
    pool = new pg.Pool({ ...settings, max: 4 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Synthetic database exited during startup");
      try { await pool.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");
    await pool.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));

    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), state = token(1), verifier = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const identity = { accountType: "business", dataScope: `v1_${token(6)}` };
    const input = { state, challenge, platform: "android" };
    async function checkout() {
      const client = await pool.connect();
      clients.add(client);
      return client;
    }
    function release(client) {
      if (clients.delete(client)) client.release();
    }
    function settle(tag, promise) {
      const result = promise.then(
        (value) => ({ tag, ok: true, value }),
        (error) => ({ tag, ok: false, error }),
      );
      tracked.push(result);
      return result;
    }
    async function seed(offset) {
      const f = { family: key(offset), claim: key(offset + 1), child: key(offset + 2), session: key(offset + 3) };
      await pool.query(`INSERT INTO paypal_markets_native_auth.families
        (family_hash,context_hash,generation,revoked,expires_at)
        VALUES($1,$2,1,false,clock_timestamp()+interval '30 minutes')`, [f.family, context]);
      await pool.query(`INSERT INTO paypal_markets_native_auth.sessions
        (handle_hash,context_hash,family_hash,family_generation,account_type,data_scope,expires_at)
        VALUES($1,$2,$3,1,$4,$5,clock_timestamp()+interval '30 minutes')`,
      [f.session, context, f.family, identity.accountType, identity.dataScope]);
      await pool.query(`INSERT INTO paypal_markets_native_auth.handoffs
        (handle_hash,context_hash,family_hash,family_generation,initial_session_hash,app_state,challenge,platform,status,
         browser_hash,provider_state,provider_nonce,provider_verifier,reservation_hash,issued,expires_at)
        VALUES($1,$2,$3,1,$4,$5,$6,'android','claimed',$7,$8,$9,$10,$11,false,clock_timestamp()-interval '1 minute')`,
      [f.claim, context, f.family, f.session, state, challenge, key(offset + 4),
        provider.state, provider.nonce, provider.verifier, key(offset + 5)]);
      await pool.query(`INSERT INTO paypal_markets_native_auth.handoffs
        (handle_hash,context_hash,family_hash,family_generation,app_state,challenge,platform,status,issued,expires_at)
        VALUES($1,$2,$3,0,$4,$5,'android','exchanged',true,clock_timestamp()-interval '1 minute')`,
      [f.child, context, f.family, state, challenge]);
      return f;
    }
    async function setNearExpiry(observer, f) {
      await observer.query("UPDATE paypal_markets_native_auth.families SET expires_at=clock_timestamp()+interval '3 seconds' WHERE family_hash=$1", [f.family]);
      await observer.query(`UPDATE paypal_markets_native_auth.sessions SET expires_at=
        (SELECT expires_at-interval '1 millisecond' FROM paypal_markets_native_auth.families WHERE family_hash=$1)
        WHERE handle_hash=$2`, [f.family, f.session]);
    }
    async function assertFamilyLive(observer, f) {
      const row = (await observer.query("SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_native_auth.families WHERE family_hash=$1", [f.family])).rows[0];
      assert.equal(row?.live, true, "The family must be live when the scrub locks it");
    }
    async function waitForExpiry(observer, f) {
      await observer.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision+0.05)
        FROM paypal_markets_native_auth.families WHERE family_hash=$1`, [f.family]);
      const row = (await observer.query("SELECT expires_at<=clock_timestamp() AS expired FROM paypal_markets_native_auth.families WHERE family_hash=$1", [f.family])).rows[0];
      assert.equal(row?.expired, true, "The family must expire before the deletion phase");
    }
    async function waitForEdge(observer, waiter, holder, label) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const row = (await observer.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [holder, waiter])).rows[0];
        if (row.blocked) return;
        await delay(10);
      }
      throw new Error(label);
    }
    async function waitForCycle(observer, left, right) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const row = (await observer.query(`SELECT $1::int=ANY(pg_blocking_pids($2::int))
          AND $2::int=ANY(pg_blocking_pids($1::int)) AS cycle`, [left, right])).rows[0];
        if (row.cycle) return;
        await delay(10);
      }
      throw new Error("The fictional old ordering did not form the expected lock cycle");
    }

    // Negative control: reproduce the previous combined-transaction lock
    // ordering directly using the same expired-child DELETE. The external
    // writer holds another child and then requests the scrub-held family.
    const oldFixture = await seed(10_000);
    const externalOld = await checkout(), old = await checkout(), observerOld = await checkout();
    try {
      await externalOld.query("BEGIN");
      const externalPid = (await externalOld.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.equal((await externalOld.query("SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE", [oldFixture.child])).rowCount, 1);
      await setNearExpiry(observerOld, oldFixture);
      await old.query("BEGIN");
      const oldPid = (await old.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await old.query("SELECT pg_advisory_xact_lock(1347437612, 1312904278)");
      assert.equal((await old.query("SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE", [oldFixture.family])).rowCount, 1);
      assert.equal((await old.query("SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE", [oldFixture.claim])).rowCount, 1);
      const scrub = await old.query(`UPDATE paypal_markets_native_auth.handoffs h SET status='cancelled',
        browser_hash=NULL,provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL
        WHERE h.handle_hash=$1 AND h.expires_at<=clock_timestamp() AND EXISTS
          (SELECT 1 FROM paypal_markets_native_auth.families f WHERE f.family_hash=h.family_hash AND f.expires_at>clock_timestamp())`, [oldFixture.claim]);
      assert.equal(scrub.rowCount, 1, "The old scrub must occur while the family is live");
      const oldFamilyWait = settle("external", externalOld.query("SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE", [oldFixture.family]));
      await waitForEdge(observerOld, externalPid, oldPid, "External writer did not wait on the old scrub-held family");
      await assertFamilyLive(observerOld, oldFixture);
      await waitForExpiry(observerOld, oldFixture);
      const oldDelete = settle("old", old.query(`DELETE FROM paypal_markets_native_auth.handoffs WHERE handle_hash IN
        (SELECT t.handle_hash FROM paypal_markets_native_auth.handoffs t JOIN paypal_markets_native_auth.families f USING(family_hash)
          WHERE f.expires_at<=clock_timestamp() LIMIT 100)`));
      await waitForCycle(observerOld, externalPid, oldPid);
      const first = await within(Promise.race([oldFamilyWait, oldDelete]), 5_000, "The fictional deadlock was not resolved");
      if (!first.ok) await (first.tag === "old" ? old : externalOld).query("ROLLBACK").catch(() => {});
      const outcomes = await within(Promise.all([oldFamilyWait, oldDelete]), 5_000, "The other fictional lock waiter did not settle");
      assert.equal(outcomes.filter((outcome) => !outcome.ok && outcome.error?.code === "40P01").length, 1,
        "The combined ordering must reproduce one PostgreSQL deadlock victim");
      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    } finally {
      await Promise.allSettled([old.query("ROLLBACK"), externalOld.query("ROLLBACK")]);
      release(old); release(externalOld); release(observerOld);
    }

    // Clear the negative-control records so its expired family cannot interfere
    // with the real store's independent deletion pass.
    await pool.query("TRUNCATE paypal_markets_native_auth.handoffs,paypal_markets_native_auth.sessions,paypal_markets_native_auth.families");
    const splitFixture = await seed(20_000);
    control.target = splitFixture.claim;
    class InstrumentedPool extends pg.Pool {
      connect(callback) {
        if (typeof callback === "function") return super.connect(callback);
        return super.connect().then((client) => new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args) => {
                const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
                const isScrub = sql.includes("UPDATE paypal_markets_native_auth.handoffs h SET status='cancelled'") && args[1]?.[0] === control.target;
                const isFamilyScan = sql.includes("SELECT family_hash FROM paypal_markets_native_auth.families WHERE family_hash>$1");
                if (isFamilyScan && !control.deletionPaused) {
                  control.deletionPaused = true;
                  deletionStarted.resolve({ pid: target.processID, scrubCommitDelivered: control.scrubCommitDelivered });
                  await deletionGate.promise;
                }
                const result = await target.query(...args);
                if (isScrub) {
                  control.sawScrub = true;
                  scrubGate.entered.resolve({ pid: target.processID, rowCount: result.rowCount });
                  await scrubGate.resume.promise;
                }
                if (sql === "COMMIT" && control.sawScrub && !control.scrubCommitDelivered) control.scrubCommitDelivered = true;
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }));
      }
    }
    const { createNativePostgresStore } = load("src/lib/customer-auth/native-store.ts", {
      pg: { ...pg, Pool: InstrumentedPool },
    });
    store = createNativePostgresStore(settings);
    const external = await checkout(), observer = await checkout();
    try {
      await external.query("BEGIN");
      const externalPid = (await external.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.equal((await external.query("SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE", [splitFixture.child])).rowCount, 1);
      await setNearExpiry(observer, splitFixture);
      const created = settle("store", store.createHandoff(key(90_001), context, input, null));
      const scrubbed = await within(scrubGate.entered.promise, 4_000, "The real store did not pause after its scrub");
      assert.equal(scrubbed.rowCount, 1, "The real scrub must occur while the family is live");
      const familyWait = settle("external", external.query("SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE", [splitFixture.family]));
      await waitForEdge(observer, externalPid, scrubbed.pid, "External writer did not wait on the real scrub-held family");
      await assertFamilyLive(observer, splitFixture);
      await waitForExpiry(observer, splitFixture);

      scrubGate.resume.resolve();
      const externalResult = await within(familyWait, 2_000, "The scrub did not release its family lock");
      assert.equal(externalResult.ok, true, "The external writer must acquire the family without a deadlock");
      const deleting = await within(deletionStarted.promise, 2_000, "The separate expired-family cleanup did not start");
      assert.equal(deleting.scrubCommitDelivered, true, "The scrub COMMIT must finish before expired-family cleanup starts");
      deletionGate.resolve();
      const outcome = await within(created, 4_000, "Cleanup did not skip the family held by the external writer");
      assert.equal(outcome.ok, true, outcome.error?.message);
      const skipped = (await observer.query(`SELECT
        (SELECT count(*)::int FROM paypal_markets_native_auth.handoffs WHERE family_hash=$1) AS handoffs,
        (SELECT count(*)::int FROM paypal_markets_native_auth.sessions WHERE family_hash=$1) AS sessions,
        (SELECT count(*)::int FROM paypal_markets_native_auth.families WHERE family_hash=$1) AS families`, [splitFixture.family])).rows[0];
      assert.deepEqual(skipped, { handoffs: 2, sessions: 1, families: 1 }, "An independently locked family must be left intact for a later pass");
      const retained = (await observer.query("SELECT status,provider_verifier FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [splitFixture.claim])).rows[0];
      assert.deepEqual(retained, { status: "cancelled", provider_verifier: null }, "The earlier scrub committed before the family was skipped");
      await external.query("COMMIT");
      const later = await within(settle("later", store.createHandoff(key(90_002), context, input, null)), 4_000,
        "A later cleanup did not finish after the external writer released its locks");
      assert.equal(later.ok, true, later.error?.message);
      const remaining = (await observer.query(`SELECT
        (SELECT count(*)::int FROM paypal_markets_native_auth.handoffs WHERE family_hash=$1) AS handoffs,
        (SELECT count(*)::int FROM paypal_markets_native_auth.sessions WHERE family_hash=$1) AS sessions,
        (SELECT count(*)::int FROM paypal_markets_native_auth.families WHERE family_hash=$1) AS families`, [splitFixture.family])).rows[0];
      assert.deepEqual(remaining, { handoffs: 0, sessions: 0, families: 0 });
      assert.equal((await observer.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [key(90_001)])).rows[0].n, 1);
      assert.equal((await observer.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [key(90_002)])).rows[0].n, 1);
    } finally {
      scrubGate.resume.resolve();
      deletionGate.resolve();
      await external.query("ROLLBACK").catch(() => {});
      release(external); release(observer);
    }
  } finally {
    scrubGate.resume.resolve();
    deletionGate.resolve();
    await Promise.allSettled([...clients].map((client) => client.query("ROLLBACK")));
    for (const client of clients) client.release();
    clients.clear();
    await Promise.all(tracked);
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
