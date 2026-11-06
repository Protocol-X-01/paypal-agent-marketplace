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
test("native PostgreSQL enforces challenge-bound one-use handoffs and revocable session families", { skip: process.env.PAYPAL_NATIVE_AUTH_ISOLATED_PG_TEST !== "1", timeout: 30_000 }, async () => {
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
    const fresh = () => ({ handoff: key(sequence++), browser: key(sequence++), reservation: key(sequence++), code: key(sequence++), session: key(sequence++) });
    async function start(prior = null, target = store) {
      const f = fresh(); await target.createHandoff(f.handoff, context, { state, challenge, platform: "android" }, prior); return f;
    }
    async function prepare(f, target = store) {
      await target.claimHandoff(f.handoff, context, f.browser, provider);
      assert.deepEqual(await target.reserveProvider(f.handoff, context, f.browser, provider.state, f.reservation), { transaction: provider, appState: state, platform: "android" });
      await target.completeProvider(f.handoff, context, f.reservation, f.code, owner); return f;
    }
    const exchange = (f, target = store, overrides = {}) => target.exchange(f.handoff, context, { state, verifier, codeHash: f.code, sessionHash: f.session, ...overrides });
    const signedIn = async (prior = null) => { const f = await start(prior); await prepare(f); await exchange(f); return f; };
    const identityOf = async h => { const r = await store.readSession(h, context); return r && { accountType: r.accountType, dataScope: r.dataScope }; };

    const f = await start();
    assert.equal(await store.canStartHandoff(f.handoff, context), true);
    assert.equal(await store.canStartHandoff(f.handoff, foreign), false);
    await assert.rejects(store.createHandoff(key(900), context, { state, challenge, platform: "other" }, null));
    await assert.rejects(store.claimHandoff(f.handoff, foreign, f.browser, provider));
    const claims = await Promise.allSettled([store.claimHandoff(f.handoff, context, f.browser, provider), store.claimHandoff(f.handoff, context, key(999), provider)]);
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
    await assert.rejects(store.claimHandoff(expiredHandoff.handoff, context, expiredHandoff.browser, provider));

    // Cancellation while provider request is in flight must prevent finalization.
    const cancelled = await start(); await store.claimHandoff(cancelled.handoff, context, cancelled.browser, provider);
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
