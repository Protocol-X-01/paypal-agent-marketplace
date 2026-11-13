// Isolated local PostgreSQL fixture only; no production database or provider is contacted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const { Pool } = createRequire(import.meta.url)("pg");
const { createChannel3RequestBudget, Channel3BudgetUnavailableError } = load("src/lib/channel3-request-budget.ts");

test("isolated PostgreSQL shares atomic minute/day reservations and fails closed", {
  skip: process.env.PAYPAL_CHANNEL3_BUDGET_ISOLATED_PG_TEST !== "1",
  timeout: 45_000,
}, async () => {
  const work = mkdtempSync("/mnt/protocol-data/UserData/protocol-x/paypal-validation/.channel3-budget-pg-");
  const socket = `${work}/socket`;
  const data = `${work}/data`;
  const bin = "/usr/lib/postgresql/18/bin";
  mkdirSync(socket, { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" };
  let server;
  let admin;
  let migration;
  let first;
  let second;
  let runtime;
  try {
    const init = spawnSync(`${bin}/initdb`, ["-D", data, "--auth=trust", "--no-sync", "--username=budget_fixture"], {
      env, stdio: "ignore", timeout: 10_000,
    });
    assert.equal(init.status, 0, "temporary PostgreSQL fixture initializes");
    server = spawn(`${bin}/postgres`, ["-D", data, "-k", socket, "-p", "5432", "-c", "listen_addresses=", "-c", "unix_socket_permissions=0700", "-c", "shared_buffers=12MB", "-c", "max_connections=10", "-c", "max_worker_processes=0", "-c", "max_parallel_workers=0", "-c", "max_wal_senders=0", "-c", "autovacuum=off"], { env, stdio: "ignore" });
    const adminSettings = { host: socket, port: 5432, user: "budget_fixture", database: "postgres", connectionTimeoutMillis: 1000 };
    admin = new Pool({ ...adminSettings, max: 1 });
    admin.on("error", () => {});
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await admin.query("SELECT 1"); break; }
      catch (error) { if (attempt === 49) throw error; await delay(100); }
    }

    await admin.query("CREATE ROLE paypal_budget_migrator LOGIN CREATEROLE");
    await admin.query("ALTER DATABASE postgres OWNER TO paypal_budget_migrator");
    migration = new Pool({ ...adminSettings, user: "paypal_budget_migrator", max: 1 });
    migration.on("error", () => {});
    await migration.query(readFileSync(new URL("../docs/channel3-request-budget-migration.sql", import.meta.url), "utf8"));
    await migration.end();
    migration = null;
    await admin.query("ALTER ROLE paypal_channel3_budget_runtime LOGIN");
    await admin.query("CREATE SCHEMA paypal_markets_auth_budget; CREATE TABLE paypal_markets_auth_budget.windows (operation text)");
    await admin.query("REVOKE ALL ON SCHEMA paypal_markets_auth_budget FROM PUBLIC; REVOKE ALL ON ALL TABLES IN SCHEMA paypal_markets_auth_budget FROM PUBLIC");
    const security = await admin.query(`
      SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
             r.rolcanlogin AS owner_can_login, r.rolsuper AS owner_is_superuser,
             has_database_privilege(r.oid, current_database(), 'CREATE') AS owner_can_create_schema,
             pg_has_role('paypal_channel3_budget_runtime', r.oid, 'MEMBER') AS runtime_is_owner
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'paypal_markets_channel3_budget.reserve_request()'::regprocedure
    `);
    assert.equal(security.rows.length, 1);
    assert.equal(security.rows[0].prosecdef, true);
    assert.equal(security.rows[0].owner, "paypal_channel3_budget_owner");
    assert.equal(security.rows[0].owner_can_login, false);
    assert.equal(security.rows[0].owner_is_superuser, false);
    assert.equal(security.rows[0].owner_can_create_schema, false);
    assert.equal(security.rows[0].runtime_is_owner, false);
    assert.ok(security.rows[0].proconfig.some(value => value.includes("search_path=pg_catalog, paypal_markets_channel3_budget")));
    const migrationRole = await admin.query("SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname='paypal_budget_migrator'");
    assert.deepEqual(migrationRole.rows[0], { rolsuper: false, rolcreaterole: true, rolcreatedb: false });
    const ownerMembership = await admin.query(`
      SELECT am.admin_option, am.set_option, am.inherit_option
      FROM pg_auth_members am
      JOIN pg_roles member_role ON member_role.oid = am.member
      JOIN pg_roles granted_role ON granted_role.oid = am.roleid
      WHERE member_role.rolname='paypal_budget_migrator' AND granted_role.rolname='paypal_channel3_budget_owner'
    `);
    assert.deepEqual(ownerMembership.rows, [{ admin_option: true, set_option: false, inherit_option: false }]);

    const runtimeSettings = { ...adminSettings, user: "paypal_channel3_budget_runtime" };
    runtime = new Pool(runtimeSettings);
    runtime.on("error", () => {});
    first = createChannel3RequestBudget(runtimeSettings);
    second = createChannel3RequestBudget(runtimeSettings);

    await assert.rejects(runtime.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=1 WHERE period='minute'"), /permission denied/i);
    await assert.rejects(runtime.query("INSERT INTO paypal_markets_channel3_budget.counters (period) VALUES ('other')"), /permission denied/i);
    await assert.rejects(runtime.query("UPDATE paypal_markets_channel3_budget.counters SET used=0 WHERE period='day'"), /permission denied/i);
    await assert.rejects(runtime.query("DELETE FROM paypal_markets_channel3_budget.counters WHERE period='day'"), /permission denied/i);
    await assert.rejects(runtime.query("SELECT * FROM paypal_markets_channel3_budget.counters"), /permission denied/i);
    await assert.rejects(runtime.query("CREATE TABLE paypal_markets_channel3_budget.attacker_table (value text)"), /permission denied/i);
    await assert.rejects(runtime.query("SELECT * FROM paypal_markets_auth_budget.windows"), /permission denied/i);
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError, "unconfigured quota fails closed through the allowed function");

    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit = CASE period WHEN 'minute' THEN 3 ELSE 4 END");
    const concurrent = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).reserve()));
    assert.equal(concurrent.filter(result => result.allowed).length, 3);
    assert.ok(concurrent.filter(result => !result.allowed).every(result => result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 86_400));
    let counters = await admin.query("SELECT period, used FROM paypal_markets_channel3_budget.counters ORDER BY period");
    assert.deepEqual(Object.fromEntries(counters.rows.map(row => [row.period, row.used])), { day: 3, minute: 3 });

    // The minute is exhausted while the day still has room. Denial must not spend the daily unit.
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms = floor(extract(epoch FROM clock_timestamp())*1000/60000)::bigint*60000-60000, used=0 WHERE period='minute'");
    assert.deepEqual(await first.reserve(), { allowed: true });
    counters = await admin.query("SELECT period, used FROM paypal_markets_channel3_budget.counters ORDER BY period");
    assert.deepEqual(Object.fromEntries(counters.rows.map(row => [row.period, row.used])), { day: 4, minute: 1 });

    // Day is now exhausted. A fresh minute window remains untouched on denial.
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms = floor(extract(epoch FROM clock_timestamp())*1000/60000)::bigint*60000-60000, used=0 WHERE period='minute'");
    const dailyDenial = await first.reserve();
    assert.equal(dailyDenial.allowed, false);
    assert.ok(dailyDenial.retryAfterSeconds >= 1 && dailyDenial.retryAfterSeconds <= 86_400);
    counters = await admin.query("SELECT period, window_start_ms, used FROM paypal_markets_channel3_budget.counters ORDER BY period");
    assert.deepEqual(Object.fromEntries(counters.rows.map(row => [row.period, row.used])), { day: 4, minute: 0 });
    assert.ok(Number(counters.rows.find(row => row.period === "minute").window_start_ms) < Date.now() - 1_000);

    // Counters from a completed UTC day/minute reset together using database time.
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms = CASE period WHEN 'day' THEN floor(extract(epoch FROM clock_timestamp())*1000/86400000)::bigint*86400000-86400000 ELSE floor(extract(epoch FROM clock_timestamp())*1000/60000)::bigint*60000-60000 END, used=99");
    assert.deepEqual(await second.reserve(), { allowed: true });
    counters = await admin.query("SELECT period, used FROM paypal_markets_channel3_budget.counters ORDER BY period");
    assert.deepEqual(Object.fromEntries(counters.rows.map(row => [row.period, row.used])), { day: 1, minute: 1 });

    // Unconfigured quotas, missing rows and future/corrupt state all fail closed.
    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=NULL WHERE period='minute'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=3 WHERE period='minute'");
    await admin.query("DELETE FROM paypal_markets_channel3_budget.counters WHERE period='minute'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    await admin.query("INSERT INTO paypal_markets_channel3_budget.counters (period) VALUES ('minute')");
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms=floor(extract(epoch FROM clock_timestamp())*1000/86400000)::bigint*86400000+86400000 WHERE period='day'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);

    // A row-lock timeout rolls the transaction back; a subsequent request can use the pool.
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms=0,used=0");
    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=100");
    const lock = await admin.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT period FROM paypal_markets_channel3_budget.counters WHERE period='day' FOR UPDATE");
      await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    assert.deepEqual(await first.reserve(), { allowed: true });

    await admin.query("DROP SCHEMA paypal_markets_channel3_budget CASCADE");
    await assert.rejects(second.reserve(), error => error instanceof Channel3BudgetUnavailableError);
  } finally {
    await Promise.all([first?.close(), second?.close(), runtime?.end(), migration?.end(), admin?.end()]);
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise(resolve => server.once("exit", resolve));
    }
    rmSync(work, { recursive: true, force: true });
  }
});
