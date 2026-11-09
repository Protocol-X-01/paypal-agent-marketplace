import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const { Pool } = createRequire(import.meta.url)("pg");
const { createPostgresStore } = load("src/lib/customer-auth/store.ts");

// The opt-in runner must supply process/memory guards and a private network.
// This fixture initializes its own socket-only cluster and uses fictional data.
test("restricted runtime can claim, scrub, issue and revoke without ownership", {
  skip: process.env.PAYPAL_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 35_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-auth-claim-");
  const data = `${work}/data`;
  const socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  let server;
  let serverError;
  let admin;
  let restricted;
  let store;
  let parallel;
  try {
    const init = spawnSync(`${bin}/initdb`, [
      "-D", data, "--auth=trust", "--no-sync", "--username=auth_fixture_owner",
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
    const ownerSettings = {
      host: socket, port: 5432, user: "auth_fixture_owner",
      database: "postgres", ssl: false, connectionTimeoutMillis: 1_000,
    };
    admin = new Pool({ ...ownerSettings, max: 1 });
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Synthetic database exited during startup");
      try { await admin.query("SELECT 1"); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, "Synthetic database did not start");

    await admin.query(`
      CREATE ROLE auth_fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS;
      REVOKE ALL ON DATABASE postgres FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO auth_fixture_runtime;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    `);
    await admin.query(readFileSync(new URL("../docs/customer-auth-schema.sql", import.meta.url), "utf8"));
    await admin.query(`
      REVOKE ALL ON SCHEMA paypal_markets_auth FROM PUBLIC;
      GRANT USAGE ON SCHEMA paypal_markets_auth TO auth_fixture_runtime;
      REVOKE ALL ON ALL TABLES IN SCHEMA paypal_markets_auth FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA paypal_markets_auth TO auth_fixture_runtime;
    `);

    // Connect as the restricted role itself, rather than an owner with SET ROLE.
    const runtimeSettings = { ...ownerSettings, user: "auth_fixture_runtime" };
    restricted = new Pool({ ...runtimeSettings, max: 1 });
    const role = (await restricted.query(`
      SELECT current_user AS role_name, session_user AS login_name,
        r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
        r.rolinherit, r.rolreplication, r.rolbypassrls,
        pg_has_role(current_user,'auth_fixture_owner','MEMBER') AS owner_member,
        has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
        has_database_privilege(current_user,current_database(),'TEMP') AS database_temp,
        has_schema_privilege(current_user,'public','CREATE') AS public_create,
        has_schema_privilege(current_user,'paypal_markets_auth','USAGE') AS auth_usage,
        has_schema_privilege(current_user,'paypal_markets_auth','CREATE') AS auth_create
      FROM pg_roles r WHERE r.rolname=current_user
    `)).rows[0];
    assert.deepEqual(role, {
      role_name: "auth_fixture_runtime", login_name: "auth_fixture_runtime",
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false,
      owner_member: false, database_create: false, database_temp: false,
      public_create: false, auth_usage: true, auth_create: false,
    });
    const privileges = (await restricted.query(`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner_name,
        (SELECT bool_and(has_table_privilege(current_user,c.oid,p.privilege))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)) AS dml,
        (SELECT bool_or(has_table_privilege(current_user,c.oid,p.privilege || ' WITH GRANT OPTION'))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)) AS can_grant,
        (SELECT bool_or(has_table_privilege(current_user,c.oid,p.privilege))
          FROM unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(privilege)) AS extra
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='paypal_markets_auth' AND c.relkind='r'
      ORDER BY c.relname
    `)).rows;
    assert.deepEqual(privileges.map((row) => row.relname), ["login_transactions", "session_families", "sessions"]);
    assert.ok(privileges.every((row) => row.owner_name === "auth_fixture_owner" && row.dml && !row.can_grant && !row.extra));
    assert.equal((await restricted.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='paypal_markets_auth'")).rows[0].owner, "auth_fixture_owner");
    for (const sql of [
      "CREATE TEMP TABLE forbidden_temp (value integer)",
      "CREATE TABLE paypal_markets_auth.forbidden_table (value integer)",
      "TRUNCATE paypal_markets_auth.sessions",
      "CREATE ROLE forbidden_role",
      "ALTER TABLE paypal_markets_auth.sessions ADD COLUMN forbidden integer",
    ]) {
      await assert.rejects(restricted.query(sql), { code: "42501" });
    }
    await restricted.end(); restricted = null;

    store = createPostgresStore(runtimeSettings);
    parallel = createPostgresStore(runtimeSettings);
    assert.equal(await store.ready(), true, "The restricted runtime must meet store readiness");
    assert.equal(await parallel.ready(), true);
    const key = (n) => n.toString(16).padStart(64, "0");
    const context = "f".repeat(64);
    const otherContext = "e".repeat(64);
    const login = { state: "fixture-state", nonce: "fixture-nonce", verifier: "fixture-verifier" };
    const identity = { accountType: "personal", dataScope: `v1_${"A".repeat(43)}` };
    const readTransaction = async (handle) => (await admin.query(
      "SELECT status,state,nonce,verifier FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [handle],
    )).rows[0];
    const pending = { status: "pending", ...login };
    const scrubbed = { status: "processing", state: "", nonce: "", verifier: "" };
    const completed = { status: "completed", state: null, nonce: null, verifier: null };

    // A wrong state preserves a live attempt; two independent pools race to
    // claim it, and only the winner receives the original synthetic values.
    const transaction = key(21000), session = key(21001);
    await store.createTransaction(transaction, context, login, null, null);
    assert.equal(await store.consumeTransaction(transaction, context, "wrong-state"), null);
    assert.deepEqual(await readTransaction(transaction), pending);
    const claims = await Promise.all([
      store.consumeTransaction(transaction, context, login.state),
      parallel.consumeTransaction(transaction, context, login.state),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.deepEqual(claims.find(Boolean), login);
    assert.equal(claims.filter((value) => value === null).length, 1);
    assert.deepEqual(await readTransaction(transaction), scrubbed, "A committed claim logically scrubs transaction values");
    await store.createSession(session, context, identity, transaction, null);
    assert.deepEqual(await store.readSession(session, context), identity);
    assert.deepEqual(await readTransaction(transaction), completed);
    await store.logout(session, null);
    assert.equal(await store.readSession(session, context), null);
    const revoked = (await admin.query(`
      SELECT s.revoked, f.generation FROM paypal_markets_auth.sessions s
      JOIN paypal_markets_auth.session_families f ON f.family_hash=s.family_hash
      WHERE s.handle_hash=$1
    `, [session])).rows[0];
    assert.deepEqual(revoked, { revoked: true, generation: 1 });

    const crossContext = key(21002);
    await store.createTransaction(crossContext, context, login, null, null);
    assert.equal(await parallel.consumeTransaction(crossContext, otherContext, login.state), null);
    assert.deepEqual(await readTransaction(crossContext), completed);
    assert.equal(await store.consumeTransaction(crossContext, context, login.state), null);

    // The claimant starts while another transaction owns the row and changes
    // all three values. It must wait and return only the committed new values.
    const waiting = key(21003);
    const changed = { state: "fixture-new-state", nonce: "fixture-new-nonce", verifier: "fixture-new-verifier" };
    await store.createTransaction(waiting, context, login, null, null);
    const blocker = await admin.connect();
    let claim;
    let settled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`
        UPDATE paypal_markets_auth.login_transactions SET state=$2, nonce=$3, verifier=$4 WHERE handle_hash=$1
      `, [waiting, changed.state, changed.nonce, changed.verifier]);
      claim = store.consumeTransaction(waiting, context, changed.state).then(
        (value) => { settled = true; return { value }; },
        (error) => { settled = true; return { error }; },
      );
      let blocked = false;
      for (let attempt = 0; attempt < 60 && !settled; attempt++) {
        const locks = await blocker.query("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype='transactionid'");
        if (locks.rows[0].n > 0) { blocked = true; break; }
        await delay(15);
      }
      assert.equal(blocked, true, "The claimant must actually wait for the synthetic row lock");
      assert.equal(settled, false);
      await blocker.query("COMMIT");
      const outcome = await claim;
      assert.equal(outcome.error, undefined);
      assert.deepEqual(outcome.value, changed);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      if (claim) await claim;
    }
    assert.deepEqual(await readTransaction(waiting), scrubbed);

    // An initially-deferred constraint trigger fails at COMMIT, after the
    // marker UPDATE and freshness read. No values may escape; rollback restores
    // the original pending row and the same runtime connection remains usable.
    const failed = key(21004);
    await store.createTransaction(failed, context, login, null, null);
    await admin.query(`
      CREATE FUNCTION paypal_markets_auth.fixture_reject_claim_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic deferred claim failure'; END $$;
      CREATE CONSTRAINT TRIGGER fixture_reject_claim_commit
        AFTER UPDATE ON paypal_markets_auth.login_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.status='processing')
        EXECUTE FUNCTION paypal_markets_auth.fixture_reject_claim_commit();
    `);
    try {
      const trigger = (await admin.query(`
        SELECT tgdeferrable,tginitdeferred FROM pg_trigger
        WHERE tgrelid='paypal_markets_auth.login_transactions'::regclass AND tgname='fixture_reject_claim_commit'
      `)).rows[0];
      assert.deepEqual(trigger, { tgdeferrable: true, tginitdeferred: true });
      await assert.rejects(store.consumeTransaction(failed, context, login.state), /synthetic deferred claim failure/);
      assert.deepEqual(await readTransaction(failed), pending, "A failed COMMIT must restore the original pending row");
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS fixture_reject_claim_commit ON paypal_markets_auth.login_transactions");
      await admin.query("DROP FUNCTION IF EXISTS paypal_markets_auth.fixture_reject_claim_commit()");
    }
    assert.deepEqual(await store.consumeTransaction(failed, context, login.state), login);
    assert.deepEqual(await readTransaction(failed), scrubbed);
    const recoveredSession = key(21005);
    await store.createSession(recoveredSession, context, identity, failed, null);
    assert.deepEqual(await store.readSession(recoveredSession, context), identity);
    await store.logout(recoveredSession, null);
    assert.equal(await store.readSession(recoveredSession, context), null);
  } finally {
    if (parallel) await parallel.close();
    if (store) await store.close();
    if (restricted) await restricted.end();
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
