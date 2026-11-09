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

// The guarded runner must opt in. No configured database or provider is used.
test("native cleanup scrubs bounded expired unissued handoffs without losing proofs", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 40_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-native-cleanup-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
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
      "-c", "fsync=off", "-c", "full_page_writes=off",
    ], { env: safeEnv, stdio: "ignore" });
    server.on("error", (error) => { serverError = error; });
    const settings = {
      host: socket, port: 5432, user: "auth_fixture", database: "postgres",
      ssl: false, connectionTimeoutMillis: 1_000,
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
    assert.equal(await store.ready(), true);

    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999);
    const verifier = token(1), wrongVerifier = token(9), state = token(2);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const provider = { state: token(3), nonce: token(4), verifier: token(5) };
    const identity = { accountType: "business", dataScope: `v1_${token(6)}` };
    const input = { state, challenge, platform: "android" };
    let sequence = 100;
    const fresh = () => ({
      handoff: key(sequence++), browser: key(sequence++), claim: key(sequence++), reservation: key(sequence++),
      code: key(sequence++), session: key(sequence++),
    });
    async function signedIn(prior = null) {
      const f = fresh();
      await store.createHandoff(f.handoff, context, input, prior);
      await store.claimHandoff(f.handoff, context, f.browser, provider, f.claim);
      assert.deepEqual(await store.reserveProvider(f.handoff, context, f.browser, provider.state, f.reservation),
        { transaction: provider, appState: state, platform: "android" });
      await store.completeProvider(f.handoff, context, f.reservation, f.code, identity);
      await store.exchange(f.handoff, context, { state, verifier, codeHash: f.code, sessionHash: f.session });
      return f;
    }
    async function identityOf(handle) {
      const value = await store.readSession(handle, context);
      return value && { accountType: value.accountType, dataScope: value.dataScope };
    }
    async function newFamily(family, { expired = false, revoked = false } = {}) {
      await pool.query(`
        INSERT INTO paypal_markets_native_auth.families(family_hash,context_hash,generation,revoked,expires_at)
        VALUES($1,$2,0,$3,CASE WHEN $4::boolean THEN clock_timestamp()-interval '1 minute'
          ELSE clock_timestamp()+interval '30 minutes' END)
      `, [family, context, revoked, expired]);
    }
    // Populate every scrubbable column with fictional values, including
    // combinations normally cleared earlier in the flow, to verify cleanup.
    async function insertHandoff({ handle, family, prior = null, status, expired = false, codeExpired = false, issued = false }) {
      await pool.query(`
        INSERT INTO paypal_markets_native_auth.handoffs
          (handle_hash,context_hash,family_hash,family_generation,initial_session_hash,app_state,challenge,platform,status,
           browser_hash,provider_state,provider_nonce,provider_verifier,reservation_hash,code_hash,code_expires_at,
           account_type,data_scope,issued,expires_at)
        VALUES($1,$2,$3,(SELECT generation FROM paypal_markets_native_auth.families WHERE family_hash=$3),$4,$5,$6,'android',$7,
          $8,$9,$10,$11,$12,$13,
          CASE WHEN $14::boolean THEN clock_timestamp()-interval '1 minute' ELSE clock_timestamp()+interval '5 minutes' END,
          $15,$16,$17,
          CASE WHEN $18::boolean THEN clock_timestamp()-interval '1 minute' ELSE clock_timestamp()+interval '5 minutes' END)
      `, [handle, context, family, prior, state, challenge, status, key(sequence++),
        provider.state, provider.nonce, provider.verifier, key(sequence++), key(sequence++), codeExpired,
        identity.accountType, identity.dataScope, issued, expired]);
    }
    async function readHandoff(handle) {
      return (await pool.query("SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [handle])).rows[0];
    }
    const cleared = (before) => ({
      ...before, status: "cancelled", browser_hash: null, provider_state: null,
      provider_nonce: null, provider_verifier: null, reservation_hash: null,
      code_hash: null, code_expires_at: null, account_type: null, data_scope: null,
    });
    const triggerCleanup = async () => {
      const h = key(sequence++);
      await store.createHandoff(h, context, input, null);
      return h;
    };

    // Keep a real synthetic session descendant alive while exercising
    // individual handoff cleanup and the ancestor's issued cancellation proof.
    const ancestor = await signedIn();
    const descendant = await signedIn(ancestor.session);
    assert.deepEqual(await identityOf(descendant.session), identity);
    await pool.query("UPDATE paypal_markets_native_auth.handoffs SET expires_at=clock_timestamp()-interval '1 minute' WHERE handle_hash=$1", [ancestor.handoff]);

    const eligible = [
      { status: "claimed", expired: true },
      { status: "processing", expired: true },
      { status: "ready", expired: true },
      { status: "ready", codeExpired: true },
    ].map((entry) => ({ ...entry, handle: key(sequence++), family: ancestor.handoff, prior: descendant.session }));
    const liveControls = [
      { status: "claimed" }, { status: "processing" }, { status: "ready" },
      { status: "pending", expired: true },
      { status: "ready", expired: true, codeExpired: true, issued: true },
    ].map((entry) => ({ ...entry, handle: key(sequence++), family: ancestor.handoff, prior: descendant.session }));
    const revokedFamily = key(sequence++), expiredFamily = key(sequence++);
    await newFamily(revokedFamily, { revoked: true });
    await newFamily(expiredFamily, { expired: true });
    const revokedControl = { handle: key(sequence++), family: revokedFamily, status: "claimed", expired: true };
    const expiredAlias = { handle: key(sequence++), family: expiredFamily, status: "exchanged", expired: true, issued: true };
    const expiredSession = key(sequence++);
    for (const item of [...eligible, ...liveControls, revokedControl, expiredAlias]) await insertHandoff(item);
    await pool.query(`
      INSERT INTO paypal_markets_native_auth.sessions(handle_hash,context_hash,family_hash,family_generation,account_type,data_scope,expires_at)
      VALUES($1,$2,$3,0,$4,$5,clock_timestamp()-interval '1 minute')
    `, [expiredSession, context, expiredFamily, identity.accountType, identity.dataScope]);

    const watched = [ancestor.handoff, ...eligible.map((item) => item.handle), ...liveControls.map((item) => item.handle), revokedControl.handle];
    const before = new Map();
    for (const handle of watched) before.set(handle, await readHandoff(handle));
    const familyBefore = (await pool.query("SELECT * FROM paypal_markets_native_auth.families WHERE family_hash=$1", [ancestor.handoff])).rows[0];
    await triggerCleanup();

    for (const item of eligible) {
      assert.deepEqual(await readHandoff(item.handle), cleared(before.get(item.handle)),
        `${item.status}: expired unissued data is scrubbed while the row, challenge and family proof remain`);
    }
    for (const handle of [ancestor.handoff, ...liveControls.map((item) => item.handle), revokedControl.handle]) {
      assert.deepEqual(await readHandoff(handle), before.get(handle), "Live, issued, pending and revoked-family controls must stay untouched");
    }
    assert.deepEqual((await pool.query("SELECT * FROM paypal_markets_native_auth.families WHERE family_hash=$1", [ancestor.handoff])).rows[0], familyBefore);
    assert.equal(await readHandoff(expiredAlias.handle), undefined, "An expired family's issued alias remains eligible for family deletion");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.sessions WHERE handle_hash=$1", [expiredSession])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.families WHERE family_hash=$1", [expiredFamily])).rows[0].n, 0);

    assert.equal(await store.cancel(eligible[0].handle, context, wrongVerifier), false, "A retained row must still check the cancellation proof");
    assert.deepEqual(await identityOf(descendant.session), identity);
    assert.equal(await store.cancel(eligible[0].handle, context, verifier), true);
    assert.deepEqual(await identityOf(descendant.session), identity, "Cancelling an unissued handoff must preserve the prior session");
    assert.equal(await store.cancel(ancestor.handoff, context, wrongVerifier), false);
    assert.deepEqual(await identityOf(descendant.session), identity);
    assert.equal(await store.cancel(ancestor.handoff, context, verifier), true);
    assert.equal(await store.readSession(descendant.session, context), null, "An issued ancestor proof still revokes a live descendant");

    // A separate, deterministic batch makes the per-pass limit observable
    // without assuming which 20 rows the implementation selects first.
    await pool.query("TRUNCATE paypal_markets_native_auth.handoffs,paypal_markets_native_auth.sessions,paypal_markets_native_auth.families");
    const batchFamily = key(50_000);
    await newFamily(batchFamily);
    const batch = Array.from({ length: 45 }, (_, index) => ({
      handle: key(50_001 + index), family: batchFamily, status: "claimed", expired: true,
    }));
    const batchBefore = new Map();
    for (const item of batch) {
      await insertHandoff(item);
      batchBefore.set(item.handle, await readHandoff(item.handle));
    }
    async function assertBatch(expectedCancelled) {
      const rows = (await pool.query(
        "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=ANY($1::text[])", [batch.map((item) => item.handle)],
      )).rows;
      assert.equal(rows.length, batch.length, "Cleanup must retain every handoff proof");
      assert.equal(rows.filter((row) => row.status === "cancelled").length, expectedCancelled);
      assert.equal(rows.filter((row) => row.status === "claimed").length, batch.length - expectedCancelled);
      for (const row of rows) {
        const original = batchBefore.get(row.handle_hash);
        assert.deepEqual(row, row.status === "cancelled" ? cleared(original) : original);
      }
    }
    await triggerCleanup();
    await assertBatch(20);

    // The duplicate handoff is guaranteed to fail its creation after cleanup.
    // Its attempted new family must roll back, while that cleanup stays committed.
    const duplicate = batch[0].handle;
    await assert.rejects(store.createHandoff(duplicate, context, input, null));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM paypal_markets_native_auth.families WHERE family_hash=$1", [duplicate])).rows[0].n, 0);
    await assertBatch(40);
    await triggerCleanup();
    await assertBatch(45);
    assert.equal(await store.cancel(batch[0].handle, context, wrongVerifier), false);
    assert.equal(await store.cancel(batch[0].handle, context, verifier), true);
    assert.ok(await readHandoff(batch[0].handle), "Correct cancellation must not remove the retained proof");

    // Reset the instance too: its cursor must start before all of these
    // ordered rows, independently of the preceding proof and batch checks.
    async function resetFixture() {
      await store.close();
      await pool.query("TRUNCATE paypal_markets_native_auth.handoffs,paypal_markets_native_auth.sessions,paypal_markets_native_auth.families");
      store = createNativePostgresStore(settings);
      assert.equal(await store.ready(), true);
    }
    await resetFixture();
    const prefixFamily = key(60_000);
    await newFamily(prefixFamily);
    const prefix = Array.from({ length: 120 }, (_, index) => ({
      handle: key(60_001 + index), family: prefixFamily,
      status: ["ready", "pending", "cancelled"][index % 3],
      issued: index % 3 === 0, expired: true, codeExpired: true,
    }));
    const afterPrefix = { handle: key(60_200), family: prefixFamily, status: "claimed", expired: true };
    const prefixBefore = new Map();
    for (const item of [...prefix, afterPrefix]) {
      await insertHandoff(item);
      prefixBefore.set(item.handle, await readHandoff(item.handle));
    }
    await triggerCleanup();
    assert.deepEqual(await readHandoff(afterPrefix.handle), cleared(prefixBefore.get(afterPrefix.handle)),
      "A long earlier run of ineligible issued, pending and cancelled rows cannot hide an eligible claim");
    for (const item of prefix) {
      assert.deepEqual(await readHandoff(item.handle), prefixBefore.get(item.handle),
        "Prefiltered rows must remain untouched");
    }

    await resetFixture();
    const lockedFamily = key(70_000);
    await newFamily(lockedFamily);
    const lockedBatch = Array.from({ length: 60 }, (_, index) => ({
      handle: key(70_001 + index), family: lockedFamily, status: "claimed", expired: true,
    }));
    const lockedBefore = new Map();
    for (const item of lockedBatch) {
      await insertHandoff(item);
      lockedBefore.set(item.handle, await readHandoff(item.handle));
    }
    const earlyHandles = lockedBatch.slice(0, 40).map((item) => item.handle);
    const laterHandles = lockedBatch.slice(40).map((item) => item.handle);
    async function assertLockedBatch(queryable, expectedEarly, expectedLater) {
      const rows = (await queryable.query(
        "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=ANY($1::text[])", [lockedBatch.map((item) => item.handle)],
      )).rows;
      assert.equal(rows.length, 60, "The locked-page fixture must retain every proof");
      const early = rows.filter((row) => earlyHandles.includes(row.handle_hash));
      const later = rows.filter((row) => laterHandles.includes(row.handle_hash));
      assert.equal(early.filter((row) => row.status === "cancelled").length, expectedEarly);
      assert.equal(later.filter((row) => row.status === "cancelled").length, expectedLater);
      for (const row of rows) {
        const original = lockedBefore.get(row.handle_hash);
        assert.deepEqual(row, row.status === "cancelled" ? cleared(original) : original);
      }
    }
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      const locked = await blocker.query(`
        SELECT handle_hash FROM paypal_markets_native_auth.handoffs
        WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash FOR UPDATE
      `, [earlyHandles]);
      assert.equal(locked.rowCount, 40, "The first page must actually be row-locked by another transaction");
      await triggerCleanup();
      await assertLockedBatch(blocker, 0, 0);
      await triggerCleanup();
      await assertLockedBatch(blocker, 0, 20);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    await triggerCleanup();
    await assertLockedBatch(pool, 20, 20);
    await triggerCleanup();
    await assertLockedBatch(pool, 40, 20);

    // Cursor progress must be published only after the maintenance COMMIT.
    // The deferred trigger rejects that COMMIT after its first 20 scrubs;
    // a retry must begin with those same earliest rows, not the later page.
    await resetFixture();
    const rollbackFamily = key(80_000);
    await newFamily(rollbackFamily);
    const rollbackBatch = Array.from({ length: 40 }, (_, index) => ({
      handle: key(80_001 + index), family: rollbackFamily, status: "claimed", expired: true,
    }));
    const rollbackBefore = new Map();
    for (const item of rollbackBatch) {
      await insertHandoff(item);
      rollbackBefore.set(item.handle, await readHandoff(item.handle));
    }
    async function assertRollbackBatch(expectedCleared) {
      const rows = (await pool.query(
        "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=ANY($1::text[]) ORDER BY handle_hash",
        [rollbackBatch.map((item) => item.handle)],
      )).rows;
      assert.equal(rows.length, rollbackBatch.length);
      for (let index = 0; index < rows.length; index++) {
        assert.equal(rows[index].handle_hash, rollbackBatch[index].handle);
        const original = rollbackBefore.get(rows[index].handle_hash);
        assert.deepEqual(rows[index], index < expectedCleared ? cleared(original) : original,
          `Maintenance must clear the expected ordered prefix; row ${index + 1}`);
      }
    }
    await pool.query(`
      CREATE FUNCTION paypal_markets_native_auth.fixture_reject_cleanup_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic deferred cleanup failure'; END $$;
      CREATE CONSTRAINT TRIGGER fixture_reject_cleanup_commit
        AFTER UPDATE ON paypal_markets_native_auth.handoffs
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (OLD.status='claimed' AND NEW.status='cancelled')
        EXECUTE FUNCTION paypal_markets_native_auth.fixture_reject_cleanup_commit();
    `);
    try {
      const trigger = (await pool.query(`
        SELECT tgdeferrable,tginitdeferred FROM pg_trigger
        WHERE tgrelid='paypal_markets_native_auth.handoffs'::regclass AND tgname='fixture_reject_cleanup_commit'
      `)).rows[0];
      assert.deepEqual(trigger, { tgdeferrable: true, tginitdeferred: true });
      const failedHandle = key(sequence);
      await assert.rejects(triggerCleanup(), /synthetic deferred cleanup failure/);
      assert.equal(await readHandoff(failedHandle), undefined, "Failed maintenance must not create a handoff");
      await assertRollbackBatch(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fixture_reject_cleanup_commit ON paypal_markets_native_auth.handoffs");
      await pool.query("DROP FUNCTION IF EXISTS paypal_markets_native_auth.fixture_reject_cleanup_commit()");
    }
    await triggerCleanup();
    await assertRollbackBatch(20);
    await triggerCleanup();
    await assertRollbackBatch(40);
  } finally {
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
