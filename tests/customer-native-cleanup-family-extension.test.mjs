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

// Run only under the guarded private-network fixture; no configured database
// or real provider participates in these synthetic transactions.
test("native family cleanup skips locked extensions and locked children", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 40_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-native-family-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  let server, serverError, admin, observer, store;
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
      host: socket, port: 5432, user: "auth_fixture",
      database: "postgres", ssl: false, connectionTimeoutMillis: 1_000,
    };
    admin = new Pool({ ...settings, max: 1 });
    observer = new Pool({ ...settings, max: 1 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Synthetic database exited during startup");
      try { await admin.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");
    await admin.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));
    store = createNativePostgresStore(settings);
    assert.equal(await store.ready(), true);

    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), verifier = token(1), wrongVerifier = token(9), state = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const identity = { accountType: "business", dataScope: `v1_${token(6)}` };
    const input = { state, challenge, platform: "android" };
    let sequence = 100;
    const fresh = () => ({
      handoff: key(sequence++), browser: key(sequence++), claim: key(sequence++),
      reservation: key(sequence++), code: key(sequence++), session: key(sequence++),
    });
    async function signedIn(prior = null) {
      const result = fresh();
      await store.createHandoff(result.handoff, context, input, prior);
      await store.claimHandoff(result.handoff, context, result.browser, provider, result.claim);
      assert.deepEqual(await store.reserveProvider(result.handoff, context, result.browser, provider.state, result.reservation),
        { transaction: provider, appState: state, platform: "android" });
      await store.completeProvider(result.handoff, context, result.reservation, result.code, identity);
      await store.exchange(result.handoff, context, { state, verifier, codeHash: result.code, sessionHash: result.session });
      return result;
    }
    async function identityOf(handle) {
      const result = await store.readSession(handle, context);
      return result && { accountType: result.accountType, dataScope: result.dataScope };
    }
    const readHandoff = async (handle) => (await observer.query(
      "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [handle],
    )).rows[0];
    const readSession = async (handle) => (await observer.query(
      "SELECT * FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [handle],
    )).rows[0];
    async function mustCompleteWhileLocked(operation, description, timeoutMs = 2_000) {
      let timeout;
      try {
        const outcome = await Promise.race([
          operation,
          new Promise((resolve) => { timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
        ]);
        assert.notEqual(outcome.timedOut, true, `${description} must finish while the lock is still held`);
        assert.equal(outcome.error, undefined, `${description} must finish successfully`);
      } finally {
        clearTimeout(timeout);
      }
    }
    const launchCleanup = () => {
      const handle = key(sequence++);
      return store.createHandoff(handle, context, input, null).then(
        () => ({ handle }), (error) => ({ error }),
      );
    };

    // A family is committed as expired, but another transaction has already
    // extended it while retaining its row lock. Maintenance sees the old
    // expired MVCC version and must skip it without deleting issued proof.
    const ancestor = await signedIn();
    const descendant = await signedIn(ancestor.session);
    assert.deepEqual(await identityOf(descendant.session), identity);
    await admin.query("UPDATE paypal_markets_native_auth.families SET expires_at=clock_timestamp()-interval '1 minute' WHERE family_hash=$1", [ancestor.handoff]);
    const proofBefore = await readHandoff(ancestor.handoff);
    const descendantBefore = await readSession(descendant.session);
    assert.equal(proofBefore.issued, true);
    assert.ok(descendantBefore && !descendantBefore.revoked);
    const familyBlocker = await admin.connect();
    let familyCleanup;
    try {
      await familyBlocker.query("BEGIN");
      const extension = (await familyBlocker.query(`
        UPDATE paypal_markets_native_auth.families SET expires_at=clock_timestamp()+interval '30 minutes'
        WHERE family_hash=$1 RETURNING expires_at>clock_timestamp() AS live
      `, [ancestor.handoff])).rows[0];
      assert.deepEqual(extension, { live: true });
      const proofLock = await familyBlocker.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE", [ancestor.handoff],
      );
      const descendantLock = await familyBlocker.query(
        "SELECT 1 FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1 FOR UPDATE", [descendant.session],
      );
      assert.equal(proofLock.rowCount, 1);
      assert.equal(descendantLock.rowCount, 1);
      assert.deepEqual((await observer.query(`
        SELECT expires_at<=clock_timestamp() AS expired FROM paypal_markets_native_auth.families WHERE family_hash=$1
      `, [ancestor.handoff])).rows[0], { expired: true }, "The independent snapshot must still see the expired family");
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE NOWAIT", [ancestor.handoff],
      ), { code: "55P03" });
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE NOWAIT", [ancestor.handoff],
      ), { code: "55P03" });
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1 FOR UPDATE NOWAIT", [descendant.session],
      ), { code: "55P03" });
      familyCleanup = launchCleanup();
      await mustCompleteWhileLocked(familyCleanup, "Maintenance against an independently extended family");
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE NOWAIT", [ancestor.handoff],
      ), { code: "55P03" });
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE NOWAIT", [ancestor.handoff],
      ), { code: "55P03" });
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1 FOR UPDATE NOWAIT", [descendant.session],
      ), { code: "55P03" });
      assert.deepEqual(await readHandoff(ancestor.handoff), proofBefore, "Issued proof must survive the skipped family");
      assert.deepEqual(await readSession(descendant.session), descendantBefore, "Its live descendant must survive the skipped family");
      await familyBlocker.query("COMMIT");
    } finally {
      await familyBlocker.query("ROLLBACK").catch(() => {});
      familyBlocker.release();
      if (familyCleanup) await familyCleanup;
    }
    assert.deepEqual((await observer.query(
      "SELECT expires_at>clock_timestamp() AS live FROM paypal_markets_native_auth.families WHERE family_hash=$1", [ancestor.handoff],
    )).rows[0], { live: true });
    assert.equal(await store.cancel(ancestor.handoff, context, wrongVerifier), false);
    assert.deepEqual(await identityOf(descendant.session), identity);
    assert.equal(await store.cancel(ancestor.handoff, context, verifier), true);
    assert.equal(await store.readSession(descendant.session, context), null, "The retained issued proof must still revoke its descendant");

    // On a different expired family, an independently locked child must be
    // skipped without a deadlock. The family cannot be removed while that
    // child remains, and a later pass removes both after the lock is released.
    const childFamily = await signedIn();
    await admin.query("UPDATE paypal_markets_native_auth.families SET expires_at=clock_timestamp()-interval '1 minute' WHERE family_hash=$1", [childFamily.handoff]);
    const childBefore = await readHandoff(childFamily.handoff);
    assert.equal(childBefore.issued, true);
    const childBlocker = await admin.connect();
    let childCleanup;
    try {
      await childBlocker.query("BEGIN");
      const locked = await childBlocker.query(
        "SELECT handle_hash FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE", [childFamily.handoff],
      );
      assert.equal(locked.rowCount, 1);
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE NOWAIT", [childFamily.handoff],
      ), { code: "55P03" });
      childCleanup = launchCleanup();
      await mustCompleteWhileLocked(childCleanup, "Maintenance against an independently locked child");
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE NOWAIT", [childFamily.handoff],
      ), { code: "55P03" });
      assert.deepEqual(await readHandoff(childFamily.handoff), childBefore, "The locked proof must remain untouched");
      assert.equal((await observer.query(
        "SELECT count(*)::int AS n FROM paypal_markets_native_auth.families WHERE family_hash=$1", [childFamily.handoff],
      )).rows[0].n, 1, "A family with a locked child cannot be deleted");
      await childBlocker.query("COMMIT");
    } finally {
      await childBlocker.query("ROLLBACK").catch(() => {});
      childBlocker.release();
      if (childCleanup) await childCleanup;
    }
    const retry = launchCleanup();
    await mustCompleteWhileLocked(retry, "A later cleanup pass");
    assert.equal(await readHandoff(childFamily.handoff), undefined);
    assert.equal(await readSession(childFamily.session), undefined);
    assert.equal((await observer.query(
      "SELECT count(*)::int AS n FROM paypal_markets_native_auth.families WHERE family_hash=$1", [childFamily.handoff],
    )).rows[0].n, 0, "Expired family cleanup should finish after the child lock is released");

    // Give each cursor scenario a fresh instance and an otherwise empty,
    // isolated schema. All rows are fictional and remain inside this cluster.
    async function resetFixture() {
      await store.close();
      await admin.query("TRUNCATE paypal_markets_native_auth.handoffs,paypal_markets_native_auth.sessions,paypal_markets_native_auth.families");
      store = createNativePostgresStore(settings);
      assert.equal(await store.ready(), true);
    }
    async function seedExpiredFamilies(base, count) {
      const families = Array.from({ length: count }, (_, index) => key(base + index));
      const children = Array.from({ length: count }, (_, index) => key(base + 1_000 + index));
      await admin.query(`
        INSERT INTO paypal_markets_native_auth.families(family_hash,context_hash,generation,revoked,expires_at)
        SELECT f.family,$2,0,false,clock_timestamp()-interval '1 minute'
        FROM unnest($1::text[]) AS f(family)
      `, [families, context]);
      await admin.query(`
        INSERT INTO paypal_markets_native_auth.handoffs
          (handle_hash,context_hash,family_hash,family_generation,app_state,challenge,platform,status,issued,expires_at)
        SELECT p.child,$3,p.family,0,$4,$5,'android','exchanged',true,clock_timestamp()-interval '1 minute'
        FROM unnest($1::text[],$2::text[]) AS p(family,child)
      `, [families, children, context, state, challenge]);
      return { families, children };
    }
    async function readFamilies(handles) {
      return (await observer.query(
        "SELECT * FROM paypal_markets_native_auth.families WHERE family_hash=ANY($1::text[]) ORDER BY family_hash", [handles],
      )).rows;
    }
    async function readChildren(handles) {
      return (await observer.query(
        "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash", [handles],
      )).rows;
    }

    // The first page contains 20 locked families and 20 unlocked families
    // whose children are locked. A later family must be reached on the next
    // pass, and the cursor must wrap back after all independent locks release.
    await resetFixture();
    const fairness = await seedExpiredFamilies(50_000, 41);
    const familiesBefore = await readFamilies(fairness.families);
    const childrenBefore = await readChildren(fairness.children);
    const fairnessBlocker = await admin.connect();
    let fairnessFirst, fairnessSecond;
    try {
      await fairnessBlocker.query("BEGIN");
      const familyLocks = await fairnessBlocker.query(`
        SELECT family_hash FROM paypal_markets_native_auth.families
        WHERE family_hash=ANY($1::text[]) ORDER BY family_hash FOR UPDATE
      `, [fairness.families.slice(0, 20)]);
      const childLocks = await fairnessBlocker.query(`
        SELECT handle_hash FROM paypal_markets_native_auth.handoffs
        WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash FOR UPDATE
      `, [fairness.children.slice(20, 40)]);
      assert.equal(familyLocks.rowCount, 20);
      assert.equal(childLocks.rowCount, 20);
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.families WHERE family_hash=$1 FOR UPDATE NOWAIT", [fairness.families[0]],
      ), { code: "55P03" });
      await assert.rejects(observer.query(
        "SELECT 1 FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1 FOR UPDATE NOWAIT", [fairness.children[20]],
      ), { code: "55P03" });
      fairnessFirst = launchCleanup();
      await mustCompleteWhileLocked(fairnessFirst, "The first family-cursor pass", 6_000);
      assert.deepEqual(await readFamilies(fairness.families), familiesBefore);
      assert.deepEqual(await readChildren(fairness.children), childrenBefore);
      fairnessSecond = launchCleanup();
      await mustCompleteWhileLocked(fairnessSecond, "The next family-cursor pass");
      assert.deepEqual(await readFamilies(fairness.families), familiesBefore.slice(0, 40), "The later family must not be starved");
      assert.deepEqual(await readChildren(fairness.children), childrenBefore.slice(0, 40), "Its issued child must be removed with the expired family");
      await fairnessBlocker.query("COMMIT");
    } finally {
      await fairnessBlocker.query("ROLLBACK").catch(() => {});
      fairnessBlocker.release();
      if (fairnessFirst) await fairnessFirst;
      if (fairnessSecond) await fairnessSecond;
    }
    await mustCompleteWhileLocked(launchCleanup(), "The wrapped family-cursor pass", 6_000);
    assert.deepEqual(await readFamilies(fairness.families), [], "The cursor must revisit formerly locked families");
    assert.deepEqual(await readChildren(fairness.children), []);

    // A deferred failure after child deletes proves that neither deletion nor
    // the separate process-local family cursor is published before COMMIT.
    await resetFixture();
    const rollback = await seedExpiredFamilies(70_000, 41);
    const rollbackFamiliesBefore = await readFamilies(rollback.families);
    const rollbackChildrenBefore = await readChildren(rollback.children);
    await admin.query(`
      CREATE FUNCTION paypal_markets_native_auth.fixture_reject_family_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic deferred family deletion failure'; END $$;
      CREATE CONSTRAINT TRIGGER fixture_reject_family_commit
        AFTER DELETE ON paypal_markets_native_auth.handoffs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION paypal_markets_native_auth.fixture_reject_family_commit();
    `);
    try {
      const trigger = (await admin.query(`
        SELECT tgdeferrable,tginitdeferred FROM pg_trigger
        WHERE tgrelid='paypal_markets_native_auth.handoffs'::regclass AND tgname='fixture_reject_family_commit'
      `)).rows[0];
      assert.deepEqual(trigger, { tgdeferrable: true, tginitdeferred: true });
      const failedHandle = key(sequence++);
      await assert.rejects(store.createHandoff(failedHandle, context, input, null), /synthetic deferred family deletion failure/);
      assert.equal(await readHandoff(failedHandle), undefined);
      assert.deepEqual(await readFamilies(rollback.families), rollbackFamiliesBefore, "Failed COMMIT must restore the families");
      assert.deepEqual(await readChildren(rollback.children), rollbackChildrenBefore, "Failed COMMIT must restore the issued proofs");
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS fixture_reject_family_commit ON paypal_markets_native_auth.handoffs");
      await admin.query("DROP FUNCTION IF EXISTS paypal_markets_native_auth.fixture_reject_family_commit()");
    }
    await mustCompleteWhileLocked(launchCleanup(), "The family-cursor retry", 6_000);
    assert.deepEqual(await readFamilies(rollback.families), rollbackFamiliesBefore.slice(40), "Retry must process the original first page");
    assert.deepEqual(await readChildren(rollback.children), rollbackChildrenBefore.slice(40));
    await mustCompleteWhileLocked(launchCleanup(), "The final family-cursor pass");
    assert.deepEqual(await readFamilies(rollback.families), []);
    assert.deepEqual(await readChildren(rollback.children), []);
  } finally {
    if (store) await store.close();
    if (observer) await observer.end();
    if (admin) await admin.end();
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
