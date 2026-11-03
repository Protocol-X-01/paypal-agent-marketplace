import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.cwd(), 'data', 'marketplace.db');

function init(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
      paypal_email TEXT,
      spend_policy TEXT NOT NULL DEFAULT '{"autopilot_cents":2500,"monthly_cents":10000}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS wallet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cents INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('allowance','topup','purchase','sale','refund')),
      paypal_ref TEXT,
      memo TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      retail_cents INTEGER,
      channel3_enriched INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id),
      buyer_id TEXT NOT NULL REFERENCES agents(id),
      paypal_order_id TEXT,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pending_approval INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      payer_id TEXT NOT NULL REFERENCES agents(id),
      beneficiary_id TEXT NOT NULL REFERENCES agents(id),
      paypal_subscription_id TEXT,
      cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

type DB = ReturnType<typeof init>;

const globalForDb = globalThis as unknown as { __market_db?: DB };

export function db(): DB {
  if (!globalForDb.__market_db) {
    globalForDb.__market_db = init(dbPath);
  }
  return globalForDb.__market_db;
}

export function balance(agentId: string): number {
  const row = db()
    .prepare('SELECT COALESCE(SUM(cents),0) AS bal FROM wallet_entries WHERE agent_id = ?')
    .get(agentId) as { bal: number };
  return row.bal;
}

export function credit(agentId: string, cents: number, source: string, paypalRef?: string, memo?: string) {
  db().prepare(
    'INSERT INTO wallet_entries (agent_id, cents, source, paypal_ref, memo) VALUES (?,?,COALESCE(?,source),?,?)',
  ).run(agentId, cents, source, paypalRef ?? null, memo ?? null);
}

export function debit(agentId: string, cents: number, source: string, paypalRef?: string, memo?: string) {
  const bal = balance(agentId);
  if (bal < cents) throw new Error(`insufficient wallet: ${agentId} has ${bal} < ${cents}`);
  credit(agentId, -cents, source, paypalRef, memo);
}
