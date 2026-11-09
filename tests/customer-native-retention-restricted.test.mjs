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

// The opt-in runner supplies private namespaces and process/memory guards.
// This fixture initializes its own socket-only database with fictional data.
test("restricted native runtime can abort claims and scrub expired handoffs", {
  skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1",
  timeout: 40_000,
}, async () => {
  const work = mkdtempSync("/tmp/paypal-native-restricted-");
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = "/usr/lib/postgresql/18/bin";
  const safeEnv = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "Etc/UTC" };
  let server, serverError, admin, restricted, store;
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
    await admin.query(readFileSync(new URL("../docs/customer-native-auth-schema.sql", import.meta.url), "utf8"));
    await admin.query(`
      REVOKE ALL ON SCHEMA paypal_markets_native_auth FROM PUBLIC;
      GRANT USAGE ON SCHEMA paypal_markets_native_auth TO auth_fixture_runtime;
      REVOKE ALL ON ALL TABLES IN SCHEMA paypal_markets_native_auth FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA paypal_markets_native_auth TO auth_fixture_runtime;
    `);

    // Authenticate as the restricted role itself; the owner is used only for
    // fixture schema setup, synthetic expiry changes and inspection.
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
        has_schema_privilege(current_user,'paypal_markets_native_auth','USAGE') AS auth_usage,
        has_schema_privilege(current_user,'paypal_markets_native_auth','CREATE') AS auth_create
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
      WHERE n.nspname='paypal_markets_native_auth' AND c.relkind='r'
      ORDER BY c.relname
    `)).rows;
    assert.deepEqual(privileges.map((row) => row.relname), ["families", "handoffs", "sessions"]);
    assert.ok(privileges.every((row) => row.owner_name === "auth_fixture_owner" && row.dml && !row.can_grant && !row.extra));
    assert.equal((await restricted.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='paypal_markets_native_auth'")).rows[0].owner, "auth_fixture_owner");
    for (const sql of [
      "CREATE TEMP TABLE forbidden_temp (value integer)",
      "CREATE TABLE paypal_markets_native_auth.forbidden_table (value integer)",
      "TRUNCATE paypal_markets_native_auth.handoffs",
      "CREATE ROLE forbidden_role",
      "ALTER TABLE paypal_markets_native_auth.handoffs ADD COLUMN forbidden integer",
    ]) await assert.rejects(restricted.query(sql), { code: "42501" });
    await restricted.end(); restricted = null;

    store = createNativePostgresStore(runtimeSettings);
    assert.equal(await store.ready(), true, "The restricted role must satisfy native-store readiness");
    const key = (n) => n.toString(16).padStart(64, "0");
    const token = (n) => Buffer.alloc(32, n).toString("base64url");
    const context = key(9999), otherContext = key(9998);
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
    async function start(prior = null) {
      const result = fresh();
      await store.createHandoff(result.handoff, context, input, prior);
      return result;
    }
    async function claim(result) {
      await store.claimHandoff(result.handoff, context, result.browser, provider, result.claim);
    }
    async function reserve(result) {
      assert.deepEqual(await store.reserveProvider(result.handoff, context, result.browser, provider.state, result.reservation),
        { transaction: provider, appState: state, platform: "android" });
    }
    async function signedIn() {
      const result = await start();
      await claim(result);
      await reserve(result);
      await store.completeProvider(result.handoff, context, result.reservation, result.code, identity);
      await store.exchange(result.handoff, context, { state, verifier, codeHash: result.code, sessionHash: result.session });
      return result;
    }
    async function identityOf(handle) {
      const result = await store.readSession(handle, context);
      return result && { accountType: result.accountType, dataScope: result.dataScope };
    }
    const readHandoff = async (handle) => (await admin.query(
      "SELECT * FROM paypal_markets_native_auth.handoffs WHERE handle_hash=$1", [handle],
    )).rows[0];
    const cleared = (before) => ({
      ...before, status: "cancelled", browser_hash: null, provider_state: null,
      provider_nonce: null, provider_verifier: null, reservation_hash: null,
      code_hash: null, code_expires_at: null, account_type: null, data_scope: null,
    });

    // A real synthetic prior session is created using the restricted store.
    // Only the matching context, browser and unique claim tag can abort it.
    const prior = await signedIn();
    assert.deepEqual(await identityOf(prior.session), identity);
    const ambiguous = await start(prior.session);
    await claim(ambiguous);
    const claimed = await readHandoff(ambiguous.handoff);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.reservation_hash, ambiguous.claim);
    for (const [ctx, browser, claimTag] of [
      [otherContext, ambiguous.browser, ambiguous.claim],
      [context, key(9001), ambiguous.claim],
      [context, ambiguous.browser, key(9002)],
    ]) {
      assert.equal(await store.abortClaim(ambiguous.handoff, ctx, browser, claimTag), undefined);
      assert.deepEqual(await readHandoff(ambiguous.handoff), claimed, "A mismatched abort must leave the winning claim intact");
      assert.deepEqual(await identityOf(prior.session), identity);
    }
    await admin.query("UPDATE paypal_markets_native_auth.handoffs SET expires_at=clock_timestamp()-interval '1 minute' WHERE handle_hash=$1", [ambiguous.handoff]);
    const expiredClaim = await readHandoff(ambiguous.handoff);
    assert.equal(await store.abortClaim(ambiguous.handoff, context, ambiguous.browser, ambiguous.claim), undefined);
    assert.deepEqual(await readHandoff(ambiguous.handoff), cleared(expiredClaim),
      "A matching abort must scrub even after the claim expires");
    assert.deepEqual(await identityOf(prior.session), identity);
    assert.equal(await store.cancel(ambiguous.handoff, context, wrongVerifier), false);
    assert.equal(await store.cancel(ambiguous.handoff, context, verifier), true);
    assert.deepEqual(await identityOf(prior.session), identity, "A retained unissued proof must not revoke the prior session");

    // Different synthetic families keep each real flow independent while
    // arranging claimed, processing and code-expired ready rows together.
    const claimedParent = await signedIn(), processingParent = await signedIn(), readyParent = await signedIn(), liveParent = await signedIn();
    const claimedChild = await start(claimedParent.session);
    await claim(claimedChild);
    const processingChild = await start(processingParent.session);
    await claim(processingChild);
    await reserve(processingChild);
    const processingBeforeAbort = await readHandoff(processingChild.handoff);
    await store.abortClaim(processingChild.handoff, context, processingChild.browser, processingChild.claim);
    assert.deepEqual(await readHandoff(processingChild.handoff), processingBeforeAbort, "An old claim tag cannot abort a reserved provider callback");
    const readyChild = await start(readyParent.session);
    await claim(readyChild);
    await reserve(readyChild);
    await store.completeProvider(readyChild.handoff, context, readyChild.reservation, readyChild.code, identity);
    const liveChild = await start(liveParent.session);
    await claim(liveChild);

    await admin.query(`
      UPDATE paypal_markets_native_auth.handoffs SET expires_at=clock_timestamp()-interval '1 minute'
      WHERE handle_hash=ANY($1::text[])
    `, [[claimedChild.handoff, processingChild.handoff]]);
    await admin.query("UPDATE paypal_markets_native_auth.handoffs SET code_expires_at=clock_timestamp()-interval '1 minute' WHERE handle_hash=$1", [readyChild.handoff]);
    const children = [claimedChild, processingChild, readyChild];
    const before = new Map();
    for (const child of [...children, liveChild]) before.set(child.handoff, await readHandoff(child.handoff));
    const issuedBefore = await readHandoff(claimedParent.handoff);
    assert.equal(issuedBefore.issued, true);
    await start();
    for (const child of children) {
      assert.deepEqual(await readHandoff(child.handoff), cleared(before.get(child.handoff)),
        "Restricted cleanup must scrub expired data and retain the cancellation proof");
    }
    assert.deepEqual(await readHandoff(liveChild.handoff), before.get(liveChild.handoff), "A live claim must stay unchanged");
    assert.deepEqual(await readHandoff(claimedParent.handoff), issuedBefore, "Issued aliases must stay unchanged");
    for (const [child, parent] of [
      [claimedChild, claimedParent], [processingChild, processingParent], [readyChild, readyParent],
    ]) {
      assert.equal(await store.cancel(child.handoff, context, wrongVerifier), false);
      assert.equal(await store.cancel(child.handoff, context, verifier), true);
      assert.deepEqual(await identityOf(parent.session), identity);
    }
    assert.equal(await store.cancel(claimedParent.handoff, context, wrongVerifier), false);
    assert.deepEqual(await identityOf(claimedParent.session), identity);
    assert.equal(await store.cancel(claimedParent.handoff, context, verifier), true);
    assert.equal(await store.readSession(claimedParent.session, context), null, "A retained issued proof must revoke its descendant");
    assert.deepEqual(await identityOf(processingParent.session), identity);
    assert.deepEqual(await identityOf(readyParent.session), identity);
    assert.deepEqual(await identityOf(liveParent.session), identity);
    assert.deepEqual(await identityOf(prior.session), identity);
  } finally {
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
