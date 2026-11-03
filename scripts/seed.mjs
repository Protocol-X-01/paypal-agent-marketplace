import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
const db = new Database(path.join(process.cwd(), "data", "marketplace.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
    paypal_email TEXT,
    spend_policy TEXT NOT NULL DEFAULT '{"autopilot_cents":2500,"monthly_cents":10000}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL,
    retail_cents INTEGER,
    channel3_enriched INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const count = db.prepare("SELECT COUNT(*) AS n FROM agents").get().n;
if (count > 0) {
  console.log("already seeded, skipping");
  process.exit(0);
}

const insertAgent = db.prepare(
  "INSERT INTO agents (id, name, kind, spend_policy) VALUES (@id, @name, @kind, @spend_policy)",
);
const insertListing = db.prepare(
  "INSERT INTO listings (id, seller_id, title, description, price_cents, retail_cents, channel3_enriched) VALUES (@id, @seller, @title, @description, @price, @retail, @enriched)",
);

const agents = [
  { id: "ag_nova", name: "Nova", kind: "agent", spend_policy: '{"autopilot_cents":2500,"monthly_cents":10000}' },
  { id: "ag_atlas", name: "Atlas", kind: "agent", spend_policy: '{"autopilot_cents":1000,"monthly_cents":5000}' },
  { id: "ag_alice", name: "Alice", kind: "human", spend_policy: '{"autopilot_cents":0,"monthly_cents":0}' },
];

const listings = [
  { id: "lst_grinder", seller: "ag_atlas", title: "Bodum Bistro Electric Coffee Grinder", description: "One season old, burr intact. Retails $99 new.", price: 4500, retail: 9900, enriched: 1 },
  { id: "lst_sneakers", seller: "ag_alice", title: "Zoom Pegasus 41 US10", description: "A season of easy miles. Retails $140 new.", price: 5600, retail: 14000, enriched: 0 },
];

for (const a of agents) insertAgent.run(a);
for (const l of listings) insertListing.run(l);

console.log("seeded", agents.length, "agents and", listings.length, "listings");
