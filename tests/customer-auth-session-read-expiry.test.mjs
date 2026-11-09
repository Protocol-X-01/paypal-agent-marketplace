import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { load } from './customer-auth-fixtures.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { createPostgresStore } = load('src/lib/customer-auth/store.ts');

// Run only inside the guarded private-network fixture. This file uses no configured database.
test('session read must reject expiry crossed during a table-lock wait', { skip: process.env.PAYPAL_AUTH_ISOLATED_PG_TEST !== '1', timeout: 30_000 }, async () => {
  const work = mkdtempSync('/tmp/paypal-auth-read-expiry-');
  const data = `${work}/data`, socket = `${work}/socket`;
  mkdirSync(socket, { mode: 0o700 });
  const bin = '/usr/lib/postgresql/18/bin';
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'Etc/UTC' };
  let server, pool, store;
  try {
    const init = spawnSync(`${bin}/initdb`, ['-D', data, '--auth=trust', '--no-sync', '--username=auth_fixture'], { env, stdio: 'inherit', timeout: 10_000 });
    assert.equal(init.status, 0, `Synthetic database initialization failed: ${init.error?.code ?? init.status ?? 'unknown'}`);
    server = spawn(`${bin}/postgres`, ['-D', data, '-k', socket, '-p', '5432', '-c', 'listen_addresses=', '-c', 'max_connections=8', '-c', 'shared_buffers=12MB', '-c', 'max_worker_processes=0', '-c', 'max_parallel_workers=0', '-c', 'max_wal_senders=0', '-c', 'autovacuum=off', '-c', 'track_activities=off', '-c', 'fsync=off', '-c', 'full_page_writes=off'], { env, stdio: 'ignore' });
    const settings = { host: socket, port: 5432, user: 'auth_fixture', database: 'postgres', connectionTimeoutMillis: 1000 };
    pool = new Pool({ ...settings, max: 1 });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      if (server.exitCode !== null) throw new Error('Synthetic database exited during startup');
      try { await pool.query('SELECT 1'); ready = true; } catch { await delay(100); }
    }
    assert.equal(ready, true, 'Synthetic database did not start');
    await pool.query(readFileSync(new URL('../docs/customer-auth-schema.sql', import.meta.url), 'utf8'));
    store = createPostgresStore(settings);
    assert.equal(await store.ready(), true);
    const key = (n) => n.toString(16).padStart(64, '0');
    const context = 'f'.repeat(64);
    const txn = { state: 'synthetic-state', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier' };
    const identity = { accountType: 'personal', dataScope: `v1_${'A'.repeat(43)}` };
    const results = [];
    for (const [index, table, column] of [[0, 'sessions', 'handle_hash'], [1, 'session_families', 'family_hash']]) {
      const family = key(12000 + index * 10), session = key(12001 + index * 10);
      await store.createTransaction(family, context, txn, null, null);
      assert.deepEqual(await store.consumeTransaction(family, context, txn.state), txn);
      await store.createSession(session, context, identity, family, null);
      assert.deepEqual(await store.readSession(session, context), identity, `${table}: fixture session must initially be live`);
      const target = table === 'sessions' ? session : family;
      const expiry = (await pool.query(`UPDATE paypal_markets_auth.${table} SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE ${column}=$1 RETURNING expires_at::text AS expiry`, [target])).rows[0].expiry;
      const blocker = await pool.connect();
      let pending, settled = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`LOCK TABLE paypal_markets_auth.${table} IN ACCESS EXCLUSIVE MODE`);
        pending = store.readSession(session, context).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
        let blocked = false;
        for (let i = 0; i < 60 && !settled; i++) {
          const locks = await blocker.query(`SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted AND locktype='relation' AND mode='AccessShareLock' AND relation=$1::regclass`, [`paypal_markets_auth.${table}`]);
          blocked = locks.rows[0].count > 0;
          if (blocked) break;
          await delay(15);
        }
        assert.equal(blocked, true, `${table}: the read must be visibly waiting on the table lock`);
        assert.equal((await blocker.query('SELECT $1::timestamptz>clock_timestamp() AS live', [expiry])).rows[0].live, true, `${table}: expiry must still be in the future while blocked`);
        await blocker.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))::double precision + 0.05)', [expiry]);
        assert.equal((await blocker.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [expiry])).rows[0].expired, true, `${table}: expiry must pass before lock release`);
        assert.equal(settled, false, `${table}: the read must still be waiting, not timed out`);
        await blocker.query('COMMIT');
        const outcome = await pending;
        assert.equal(outcome.error, undefined, `${table}: read must finish without timeout`);
        results.push({ target: table, returnedAuthenticated: outcome.value !== null });
        console.log(`fixture ${table}: blocked-before-expiry=yes expired-before-release=yes returnedAuthenticated=${outcome.value !== null}`);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
        if (pending) await pending;
      }
    }
    assert.deepEqual(results, [
      { target: 'sessions', returnedAuthenticated: false },
      { target: 'session_families', returnedAuthenticated: false },
    ], 'A session read released after either expiry must not authenticate');
  } finally {
    if (store) await store.close();
    if (pool) await pool.end();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
      if (server.exitCode === null) { server.kill('SIGKILL'); await new Promise((resolve) => server.once('exit', resolve)); }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
