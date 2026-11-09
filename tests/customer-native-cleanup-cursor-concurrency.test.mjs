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

// Opt-in only: the guarded runner supplies a cleared environment and resource
// limits. The database is freshly initialized and accepts only a private socket.
test("native cleanup publishes its cursor in commit order and recovers after rollback", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 45_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-cursor-order-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  const control = {
    connects: 0,
    scans: [],
    holdNextCommit: null,
    failAfterNextScrub: false,
    pauseNextScan: null,
  };
  const ackGate = { entered: deferred(), resume: deferred() };
  const retryGate = { entered: deferred(), resume: deferred() };
  const tracked = [];
  let server, serverError, pool, observerPool, store, blocker;
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
    const settings = {
      host: socket, port: 5432, user: "auth_fixture", password: "fixture-unused",
      database: "postgres", ssl: false, sslnegotiation: "postgres",
      application_name: "paypal-cursor-fixture", client_encoding: "UTF8",
      options: "-c search_path=pg_catalog", connectionTimeoutMillis: 1_000,
    };
    pool = new pg.Pool({ ...settings, max: 1 });
    observerPool = new pg.Pool({ ...settings, max: 1 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Synthetic database exited during startup");
      try { await pool.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");
    await pool.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));

    // Instrument the real store's clients only. A COMMIT is sent to PostgreSQL
    // and allowed to complete; the returned result is then held before tx()
    // receives it. The normal pg pool remains untouched for independent reads.
    class InstrumentedPool extends pg.Pool {
      connect(callback) {
        if (typeof callback === "function") return super.connect(callback);
        control.connects += 1;
        return super.connect().then((client) => new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args) => {
                const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
                const isScan = sql.includes("SELECT h.handle_hash,h.family_hash,h.context_hash FROM");
                const isScrub = sql.includes("UPDATE paypal_markets_native_auth.handoffs h SET status='cancelled'");
                if (isScan) {
                  control.scans.push(args[1]?.[0]);
                  const gate = control.pauseNextScan;
                  if (gate) {
                    control.pauseNextScan = null;
                    gate.entered.resolve();
                    await gate.resume.promise;
                  }
                }
                const result = await target.query(...args);
                if (isScrub && control.failAfterNextScrub) {
                  control.failAfterNextScrub = false;
                  control.pauseNextScan = retryGate;
                  throw new Error("synthetic failure after cleanup update");
                }
                const gate = sql === "COMMIT" ? control.holdNextCommit : null;
                if (gate) {
                  control.holdNextCommit = null;
                  gate.entered.resolve();
                  await gate.resume.promise;
                }
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

    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), state = token(1), verifier = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const input = { state, challenge, platform: "android" };
    async function addFamily(family) {
      await pool.query(`INSERT INTO paypal_markets_native_auth.families
        (family_hash,context_hash,generation,revoked,expires_at)
        VALUES($1,$2,0,false,clock_timestamp()+interval '30 minutes')`, [family, context]);
    }
    async function addClaim(handoff, family, serial) {
      await pool.query(`INSERT INTO paypal_markets_native_auth.handoffs
        (handle_hash,context_hash,family_hash,family_generation,app_state,challenge,platform,status,
         browser_hash,provider_state,provider_nonce,provider_verifier,reservation_hash,expires_at)
        VALUES($1,$2,$3,0,$4,$5,'android','claimed',$6,$7,$8,$9,$10,clock_timestamp()-interval '1 minute')`,
      [handoff, context, family, state, challenge, key(100_000 + serial),
        provider.state, provider.nonce, provider.verifier, key(200_000 + serial)]);
    }
    const allRows = async (queryable, handles) => (await queryable.query(
      "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash", [handles],
    )).rows;

    // The first 40 eligible handoffs are held by a different transaction.
    // The first pass skips them, so publishing its cursor is necessary for the
    // second pass to reach the unlocked later page.
    const family = key(70_000);
    await addFamily(family);
    const handles = Array.from({ length: 60 }, (_, index) => key(70_001 + index));
    for (let index = 0; index < handles.length; index++) await addClaim(handles[index], family, index);
    blocker = await pool.connect();
    await blocker.query("BEGIN");
    const locked = await blocker.query(`SELECT handle_hash FROM paypal_markets_native_auth.handoffs
      WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash FOR UPDATE`, [handles.slice(0, 40)]);
    assert.equal(locked.rowCount, 40);

    control.holdNextCommit = ackGate;
    const first = store.createHandoff(key(90_001), context, input, null);
    const firstResult = Promise.allSettled([first]);
    tracked.push(firstResult);
    await within(ackGate.entered.promise, 8_000, "First maintenance COMMIT did not finish");
    assert.deepEqual(control.scans, [""], "The first pass must start at the beginning");

    // An independent session can acquire the same advisory lock only after the
    // server committed. The store is still waiting on our held return value.
    const observer = await observerPool.connect();
    try {
      await observer.query("BEGIN");
      const state = (await observer.query("SELECT pg_try_advisory_xact_lock(1347437612, 1312904278) AS acquired")).rows[0];
      assert.equal(state.acquired, true, "The server must have released the COMMIT's advisory lock");
      await observer.query("COMMIT");
    } finally {
      await observer.query("ROLLBACK").catch(() => {});
      observer.release();
    }

    const second = store.createHandoff(key(90_002), context, input, null);
    const both = Promise.allSettled([first, second]);
    tracked.push(both);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(control.connects, 1, "The second create cannot begin a maintenance transaction before cursor publication");
    assert.deepEqual(control.scans, [""], "The second create cannot start a stale maintenance scan");
    ackGate.resume.resolve();
    const initialResults = await within(both, 12_000, "Queued creates did not finish");
    assert.deepEqual(initialResults.map((result) => result.status), ["fulfilled", "fulfilled"]);
    assert.deepEqual(control.scans, ["", handles[39]], "The next scan must start after the locked first page");
    const after = await allRows(blocker, handles);
    assert.equal(after.length, 60);
    for (let index = 0; index < after.length; index++) {
      assert.equal(after[index].handle_hash, handles[index]);
      assert.equal(after[index].status, index < 40 ? "claimed" : "cancelled");
      assert.equal(after[index].provider_verifier, index < 40 ? provider.verifier : null);
    }
    await blocker.query("COMMIT");
    blocker.release();
    blocker = null;

    // Inject a failure after a real scrub UPDATE but before its transaction can
    // commit. Pause the already-queued retry before its first scan so a separate
    // observer can prove that the failed UPDATE was rolled back.
    const rollbackFamily = key(80_000), rollbackHandles = [key(80_001), key(80_002)];
    await addFamily(rollbackFamily);
    for (let index = 0; index < rollbackHandles.length; index++) await addClaim(rollbackHandles[index], rollbackFamily, 80 + index);
    const beforeRollback = await allRows(observerPool, rollbackHandles);
    control.failAfterNextScrub = true;
    const failed = store.createHandoff(key(90_003), context, input, null);
    const queued = store.createHandoff(key(90_004), context, input, null);
    const failedResult = Promise.allSettled([failed]);
    const retryResults = Promise.allSettled([failed, queued]);
    tracked.push(failedResult, retryResults);
    await within(retryGate.entered.promise, 8_000, "The queued retry did not begin after the rejected pass");
    const [failure] = await failedResult;
    assert.equal(failure.status, "rejected");
    assert.match(String(failure.reason?.message), /synthetic failure after cleanup update/);
    assert.deepEqual(await allRows(observerPool, rollbackHandles), beforeRollback, "The first pass must roll back its real UPDATE");
    assert.equal((await observerPool.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [key(90_003)])).rows[0].n, 0);
    assert.deepEqual(control.scans.slice(-2), [handles[59], handles[59]], "The retry must reuse the last committed cursor");

    retryGate.resume.resolve();
    const finalResults = await within(retryResults, 12_000, "The queued retry did not finish");
    assert.deepEqual(finalResults.map((result) => result.status), ["rejected", "fulfilled"]);
    const cleaned = await allRows(observerPool, rollbackHandles);
    assert.equal(cleaned.length, 2);
    for (const row of cleaned) {
      assert.equal(row.status, "cancelled");
      assert.equal(row.provider_state, null);
      assert.equal(row.provider_nonce, null);
      assert.equal(row.provider_verifier, null);
      assert.equal(row.reservation_hash, null);
      assert.equal(row.challenge, challenge, "Cleanup keeps the cancellation proof");
    }
    assert.equal((await observerPool.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [key(90_004)])).rows[0].n, 1);
  } finally {
    ackGate.resume.resolve();
    retryGate.resume.resolve();
    if (blocker) {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    await Promise.all(tracked);
    if (store) await store.close();
    if (observerPool) await observerPool.end();
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
