import "server-only";

import { createHash } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

const RESERVATION_FUNCTION = "paypal_markets_channel3_budget.reserve_request";

export class Channel3BudgetUnavailableError extends Error {
  constructor() {
    super("Channel3 request budget is unavailable.");
    this.name = "Channel3BudgetUnavailableError";
  }
}

export class Channel3BudgetExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Channel3 request budget is exhausted.");
    this.name = "Channel3BudgetExceededError";
  }
}

export type Channel3BudgetReservation = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 86_400 ? parsed : null;
}

function validateConnectionString(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      !!url.hostname && !!url.username && !!url.password && url.pathname.length > 1 &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function failClosed(): never {
  throw new Channel3BudgetUnavailableError();
}

/**
 * PostgreSQL SECURITY DEFINER function owns the transaction and all counter
 * locks. Runtime credentials can reserve capacity but cannot inspect or reset it.
 */
export function createChannel3RequestBudget(config: PoolConfig) {
  const pool = new Pool({
    max: 1,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    statement_timeout: 1500,
    idleTimeoutMillis: 10_000,
    ...config,
  });
  pool.on("error", () => {});

  return {
    async reserve(): Promise<Channel3BudgetReservation> {
      try {
        // One function call is one PostgreSQL transaction. It locks and updates
        // all three fixed windows atomically, using DB time after acquiring locks.
        const result = await pool.query<{ allowed: unknown; retry_after_seconds: unknown }>(
          `SELECT allowed, retry_after_seconds FROM ${RESERVATION_FUNCTION}()`,
        );
        if (result.rows.length !== 1 || typeof result.rows[0].allowed !== "boolean") return failClosed();
        if (result.rows[0].allowed) {
          if (result.rows[0].retry_after_seconds !== null) return failClosed();
          return { allowed: true };
        }
        const retryAfterSeconds = positiveInteger(result.rows[0].retry_after_seconds);
        if (retryAfterSeconds === null) return failClosed();
        return { allowed: false, retryAfterSeconds };
      } catch {
        throw new Channel3BudgetUnavailableError();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

type RuntimeBudget = ReturnType<typeof createChannel3RequestBudget>;
type RuntimeBudgetGlobal = typeof globalThis & {
  __paypalMarketsChannel3RequestBudget?: { key: string; budget: RuntimeBudget };
};
const globalForBudget = globalThis as RuntimeBudgetGlobal;

function runtimeBudget(): RuntimeBudget {
  const connectionString = process.env.CHANNEL3_BUDGET_DATABASE_URL;
  if (!validateConnectionString(connectionString)) return failClosed();

  const key = createHash("sha256").update(connectionString).digest("hex");
  const current = globalForBudget.__paypalMarketsChannel3RequestBudget;
  if (current?.key === key) return current.budget;

  if (current) void current.budget.close().catch(() => {});
  const budget = createChannel3RequestBudget({
    connectionString,
    ssl: { rejectUnauthorized: true },
  });
  globalForBudget.__paypalMarketsChannel3RequestBudget = { key, budget };
  return budget;
}

/** Local development keeps the existing process-local per-IP throttle. Production requires the shared DB budget. */
export async function reserveChannel3ProviderRequest(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  const result = await runtimeBudget().reserve();
  if (!result.allowed) throw new Channel3BudgetExceededError(result.retryAfterSeconds);
}
