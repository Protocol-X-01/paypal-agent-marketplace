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

test("isolated PostgreSQL atomically enforces second/minute/day quotas and fails closed", {
  skip: process.env.PAYPAL_CHANNEL3_BUDGET_ISOLATED_PG_TEST !== "1",
  timeout: 60_000,
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
    admin = new Pool({ ...adminSettings, max: 4 });
    admin.on("error", () => {});
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await admin.query("SELECT 1"); break; }
      catch (error) { if (attempt === 49) throw error; await delay(100); }
    }

    await admin.query("CREATE ROLE paypal_budget_migrator LOGIN CREATEROLE");
    await admin.query("ALTER DATABASE postgres OWNER TO paypal_budget_migrator");
    // Match the existing restricted hosted database: runtime access cannot rely
    // on inherited PUBLIC CONNECT/TEMP/CREATE database privileges.
    await admin.query("REVOKE ALL PRIVILEGES ON DATABASE postgres FROM PUBLIC");
    const publicDatabasePrivileges = await admin.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_database d
        CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) privilege
        WHERE d.datname = current_database() AND privilege.grantee = 0
      ) AS granted
    `);
    assert.equal(publicDatabasePrivileges.rows[0].granted, false, "PUBLIC has no database privileges before migration");

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
             pg_has_role('paypal_channel3_budget_runtime', r.oid, 'MEMBER') AS runtime_is_owner,
             has_database_privilege('paypal_channel3_budget_runtime', current_database(), 'CONNECT') AS runtime_can_connect,
             has_database_privilege('paypal_channel3_budget_runtime', current_database(), 'TEMPORARY') AS runtime_can_temp,
             has_database_privilege('paypal_channel3_budget_runtime', current_database(), 'CREATE') AS runtime_can_create,
             has_schema_privilege('paypal_channel3_budget_runtime', 'paypal_markets_auth_budget', 'USAGE') AS runtime_can_use_auth_schema
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
    assert.equal(security.rows[0].runtime_can_connect, true, "runtime gets its own CONNECT grant despite PUBLIC revocation");
    assert.equal(security.rows[0].runtime_can_temp, false);
    assert.equal(security.rows[0].runtime_can_create, false);
    assert.equal(security.rows[0].runtime_can_use_auth_schema, false);
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
    assert.equal((await runtime.query("SELECT 1 AS connected")).rows[0].connected, 1, "runtime role can connect to the protected database");
    await assert.rejects(runtime.query("CREATE TEMP TABLE budget_temp_probe (value integer)"), /permission denied/i);
    await assert.rejects(runtime.query("CREATE SCHEMA budget_create_probe"), /permission denied/i);
    await assert.rejects(runtime.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=1 WHERE period='minute'"), /permission denied/i);
    await assert.rejects(runtime.query("INSERT INTO paypal_markets_channel3_budget.counters (period) VALUES ('other')"), /permission denied/i);
    await assert.rejects(runtime.query("UPDATE paypal_markets_channel3_budget.counters SET used=0 WHERE period='day'"), /permission denied/i);
    await assert.rejects(runtime.query("DELETE FROM paypal_markets_channel3_budget.counters WHERE period='day'"), /permission denied/i);
    await assert.rejects(runtime.query("SELECT * FROM paypal_markets_channel3_budget.counters"), /permission denied/i);
    await assert.rejects(runtime.query("CREATE TABLE paypal_markets_channel3_budget.attacker_table (value text)"), /permission denied/i);
    await assert.rejects(runtime.query("SELECT * FROM paypal_markets_auth_budget.windows"), /permission denied/i);
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError, "unconfigured quotas fail closed through the allowed function");

    async function readWindows() {
      const result = await admin.query(`
        WITH clock_sample AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
        )
        SELECT now_ms,
               floor(now_ms::numeric / 86400000)::bigint * 86400000 AS day_start,
               floor(now_ms::numeric / 60000)::bigint * 60000 AS minute_start,
               floor(now_ms::numeric / 1000)::bigint * 1000 AS second_start
        FROM clock_sample
      `);
      return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
    }
    async function configureLimits(secondLimit, minuteLimit, dayLimit) {
      await admin.query(`
        UPDATE paypal_markets_channel3_budget.limits SET request_limit = CASE period
          WHEN 'second' THEN $1::integer WHEN 'minute' THEN $2::integer WHEN 'day' THEN $3::integer END
      `, [secondLimit, minuteLimit, dayLimit]);
    }
    async function setCounters(windows, values) {
      const dayStart = windows.day ?? windows.day_start;
      const minuteStart = windows.minute ?? windows.minute_start;
      const secondStart = windows.second ?? windows.second_start;
      await admin.query(`
        UPDATE paypal_markets_channel3_budget.counters
        SET window_start_ms = CASE period WHEN 'day' THEN $1::bigint WHEN 'minute' THEN $2::bigint WHEN 'second' THEN $3::bigint END,
            used = CASE period WHEN 'day' THEN $4::integer WHEN 'minute' THEN $5::integer WHEN 'second' THEN $6::integer END
      `, [dayStart, minuteStart, secondStart, values.day, values.minute, values.second]);
    }
    async function counters() {
      const result = await admin.query("SELECT period, window_start_ms, used FROM paypal_markets_channel3_budget.counters ORDER BY period");
      return Object.fromEntries(result.rows.map(row => [row.period, { window_start_ms: Number(row.window_start_ms), used: row.used }]));
    }
    async function waitForStableMinute() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const windows = await readWindows();
        if (windows.minute_start + 60_000 - windows.now_ms > 3_000 &&
            windows.day_start + 86_400_000 - windows.now_ms > 3_000) return windows;
        await delay(200);
      }
      throw new Error("could not find a stable minute/day window for the concurrency fixture");
    }
    async function waitForFreshSecond() {
      for (let attempt = 0; attempt < 5; attempt++) {
        const windows = await readWindows();
        if (windows.now_ms - windows.second_start < 100) return windows;
        await delay(1_015 - (windows.now_ms - windows.second_start));
      }
      throw new Error("could not align an immediate denial check to a fresh second window");
    }

    await configureLimits(2, 30, 100);
    let windows = await waitForStableMinute();
    await setCounters(windows, { second: 0, minute: 0, day: 0 });
    const concurrent = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).reserve()));
    const admitted = concurrent.filter(result => result.allowed).length;
    assert.ok(admitted >= 1 && admitted <= 4, `two adjacent fixed-second buckets admit at most four calls; admitted ${admitted}`);
    assert.ok(concurrent.filter(result => !result.allowed).every(result => result.retryAfterSeconds === 1), "second-window denials return a one-second retry");
    let current = await counters();
    assert.ok(current.second.used <= 2, "concurrent reservations never exceed the fixed-second limit");
    assert.equal(current.minute.used, admitted, "minute usage matches all admitted requests in a stable minute");
    assert.equal(current.day.used, admitted, "day usage matches all admitted requests in a stable day");

    // Per-second denial: do not charge minute/day when the shortest window is full.
    windows = await waitForFreshSecond();
    await setCounters({ day: windows.day_start, minute: windows.minute_start, second: windows.second_start }, { day: 1, minute: 1, second: 2 });
    const beforeSecondDenial = await counters();
    const secondDenial = await first.reserve();
    assert.deepEqual(secondDenial, { allowed: false, retryAfterSeconds: 1 });
    assert.deepEqual(await counters(), beforeSecondDenial, "second denial consumes none of the windows");

    // Per-minute denial: expired second capacity is not partially written back.
    windows = await readWindows();
    await setCounters({ day: windows.day_start, minute: windows.minute_start, second: windows.second_start - 1_000 }, { day: 1, minute: 30, second: 1 });
    const beforeMinuteDenial = await counters();
    const minuteDenial = await first.reserve();
    assert.equal(minuteDenial.allowed, false);
    assert.ok(minuteDenial.retryAfterSeconds >= 1 && minuteDenial.retryAfterSeconds <= 60);
    assert.deepEqual(await counters(), beforeMinuteDenial, "minute denial does not reset or charge second/day windows");

    // Per-day denial: expired second/minute capacity is likewise not persisted.
    windows = await readWindows();
    await setCounters({ day: windows.day_start, minute: windows.minute_start - 60_000, second: windows.second_start - 1_000 }, { day: 100, minute: 1, second: 1 });
    const beforeDayDenial = await counters();
    const dayDenial = await first.reserve();
    assert.equal(dayDenial.allowed, false);
    assert.ok(dayDenial.retryAfterSeconds >= 1 && dayDenial.retryAfterSeconds <= 86_400);
    assert.deepEqual(await counters(), beforeDayDenial, "day denial does not reset or charge minute/second windows");

    // When several windows are exhausted, Retry-After reports the latest reset.
    windows = await readWindows();
    await setCounters({ day: windows.day_start, minute: windows.minute_start, second: windows.second_start }, { day: 100, minute: 30, second: 2 });
    const beforeCombinedDenial = await counters();
    const retryWindows = await readWindows();
    const combinedDenial = await first.reserve();
    assert.equal(combinedDenial.allowed, false);
    const expectedLatestResetSeconds = Math.max(1, Math.ceil(Math.max(
      retryWindows.day_start + 86_400_000 - retryWindows.now_ms,
      retryWindows.minute_start + 60_000 - retryWindows.now_ms,
      retryWindows.second_start + 1_000 - retryWindows.now_ms,
    ) / 1_000));
    assert.ok(Math.abs(combinedDenial.retryAfterSeconds - expectedLatestResetSeconds) <= 1,
      "Retry-After reflects the latest remaining reset, including near UTC midnight");
    assert.deepEqual(await counters(), beforeCombinedDenial, "combined exhaustion leaves every counter unchanged");

    // Concurrent exhaustion within one fixed-second counter cannot overspend a second.
    windows = await waitForFreshSecond();
    await setCounters({ day: windows.day_start, minute: windows.minute_start, second: windows.second_start }, { day: 0, minute: 0, second: 0 });
    const concurrentSecond = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).reserve()));
    const admittedThisSecond = concurrentSecond.filter(result => result.allowed).length;
    assert.equal(admittedThisSecond, 2, "concurrent callers share a single fixed-second quota");
    assert.ok(concurrentSecond.filter(result => !result.allowed).every(result => result.retryAfterSeconds === 1));
    current = await counters();
    assert.equal(current.second.used, 2);

    // A completed second, minute, and UTC day reset together using database time.
    windows = await readWindows();
    await setCounters({ day: windows.day_start - 86_400_000, minute: windows.minute_start - 60_000, second: windows.second_start - 1_000 }, { day: 99, minute: 99, second: 99 });
    assert.deepEqual(await first.reserve(), { allowed: true });
    current = await counters();
    assert.deepEqual(Object.fromEntries(Object.entries(current).map(([period, value]) => [period, value.used])), { day: 1, minute: 1, second: 1 });

    // Unconfigured quota, missing row, and invalid future/misaligned state fail closed.
    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=NULL WHERE period='second'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    await admin.query("UPDATE paypal_markets_channel3_budget.limits SET request_limit=2 WHERE period='second'");
    await admin.query("DELETE FROM paypal_markets_channel3_budget.counters WHERE period='second'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    await admin.query("INSERT INTO paypal_markets_channel3_budget.counters (period) VALUES ('second')");
    await admin.query("UPDATE paypal_markets_channel3_budget.counters SET window_start_ms=floor(extract(epoch FROM clock_timestamp())*1000/1000)::bigint*1000+60000 WHERE period='second'");
    await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);

    // The function locks day, minute, then second. While it waits on day,
    // separate fixture transactions can still acquire minute and second.
    await configureLimits(100, 100, 100);
    windows = await readWindows();
    await setCounters(windows, { day: 0, minute: 0, second: 0 });
    const lock = await admin.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT period FROM paypal_markets_channel3_budget.counters WHERE period='day' FOR UPDATE");
      const pendingReservation = first.reserve();
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await admin.query(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND query ILIKE '%reserve_request%'
          ) AS waiting
        `);
        if (state.rows[0].waiting) { waiting = true; break; }
        await delay(10);
      }
      assert.equal(waiting, true, "reservation is blocked on the day row before acquiring later locks");
      await admin.query("SELECT period FROM paypal_markets_channel3_budget.counters WHERE period='minute' FOR UPDATE NOWAIT");
      await admin.query("SELECT period FROM paypal_markets_channel3_budget.counters WHERE period='second' FOR UPDATE NOWAIT");
      await lock.query("ROLLBACK");
      assert.deepEqual(await pendingReservation, { allowed: true });
    } finally {
      await lock.query("ROLLBACK").catch(() => {});
      lock.release();
    }

    // A row-lock timeout rolls the transaction back; a subsequent request can use the pool.
    await setCounters({ day: 0, minute: 0, second: 0 }, { day: 0, minute: 0, second: 0 });
    const timeoutLock = await admin.connect();
    try {
      await timeoutLock.query("BEGIN");
      await timeoutLock.query("SELECT period FROM paypal_markets_channel3_budget.counters WHERE period='day' FOR UPDATE");
      await assert.rejects(first.reserve(), error => error instanceof Channel3BudgetUnavailableError);
    } finally {
      await timeoutLock.query("ROLLBACK");
      timeoutLock.release();
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
