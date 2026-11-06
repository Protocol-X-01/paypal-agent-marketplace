import "server-only";
import { createHash } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import type { AuthConfig } from "./config";

/** Demo defaults requiring an operational review before real traffic. Global, not per-client. */
export const AUTH_BUDGET_LIMITS = {
  "web.start": 60, "web.callback": 60, "web.session": 300,
  "native.availability": 300, "native.handoffs": 60, "native.authorizeGet": 120,
  "native.authorizePost": 60, "native.callback": 60, "native.exchange": 60,
  "native.session": 300,
} as const;
export type AuthBudgetOperation = keyof typeof AUTH_BUDGET_LIMITS;
export type AuthBudgetResult = { allowed: boolean; retryAfter: number };
export type AuthBudgetConsumer = (config: AuthConfig, operation: AuthBudgetOperation) => Promise<AuthBudgetResult>;
const WINDOW = 60_000;

/** Database milliseconds only; the application clock never grants capacity. */
export function nextAuthBudget(now: number, start: number, used: number, limit: number) {
  if (![now, start, used, limit].every(Number.isSafeInteger) || now < start || start < 0 || used < 0 || used > limit + 1 || limit < 1) throw new Error("Authentication budget unavailable");
  const reset = now >= start + WINDOW;
  const windowStart = reset ? now : start;
  const count = reset ? 1 : Math.min(used + 1, limit + 1);
  return { windowStart, count, allowed: count <= limit, retryAfter: Math.max(1, Math.min(60, Math.ceil((windowStart + WINDOW - now) / 1000))) };
}
export function createAuthRequestBudget(config: PoolConfig) {
  const pool = new Pool({ ...config, max: 1, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500, idleTimeoutMillis: 10000 });
  pool.on("error", () => {});
  return {
    async consume(operation: AuthBudgetOperation): Promise<AuthBudgetResult> {
      if (!Object.hasOwn(AUTH_BUDGET_LIMITS, operation)) throw new Error("Authentication budget unavailable");
      const client = await pool.connect(); let discard = false;
      try {
        await client.query("BEGIN");
        const row = await client.query<{ window_start_ms: string; used: number }>("SELECT window_start_ms, used FROM paypal_markets_auth_budget.windows WHERE operation=$1 FOR UPDATE", [operation]);
        if (row.rows.length !== 1) throw new Error("Authentication budget unavailable");
        // Read clock AFTER acquiring the row lock, not at transaction/statement start.
        const time = await client.query<{ now_ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms");
        const next = nextAuthBudget(Number(time.rows[0].now_ms), Number(row.rows[0].window_start_ms), row.rows[0].used, AUTH_BUDGET_LIMITS[operation]);
        await client.query("UPDATE paypal_markets_auth_budget.windows SET window_start_ms=$2, used=$3 WHERE operation=$1", [operation, next.windowStart, next.count]);
        await client.query("COMMIT");
        return { allowed: next.allowed, retryAfter: next.retryAfter };
      } catch {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
        throw new Error("Authentication budget unavailable");
      } finally { client.release(discard); }
    },
    async close() { await pool.end(); },
  };
}
let cached: { key: string; store: ReturnType<typeof createAuthRequestBudget> } | undefined;
export const consumeAuthRequestBudget: AuthBudgetConsumer = async (config, operation) => {
  const key = createHash("sha256").update(config.databaseUrl).digest("hex");
  if (!cached || cached.key !== key) {
    const previous = cached;
    cached = { key, store: createAuthRequestBudget({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true } }) };
    if (previous) void previous.store.close().catch(() => {});
  }
  return cached.store.consume(operation);
};
