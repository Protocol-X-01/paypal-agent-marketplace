import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { CustomerIdentity, LoginTransaction } from "./store";

export type NativeHandoffInput = { state: string; challenge: string; platform: "android" | "ios" };
export type NativeSession = CustomerIdentity & { expiresAt: string };
export type NativeProviderReservation = { transaction: LoginTransaction; appState: string; platform: "android" | "ios" };
export interface NativeAuthStore {
  ready(): Promise<boolean>;
  canStartHandoff(hash: string, context: string): Promise<boolean>;
  createHandoff(hash: string, context: string, input: NativeHandoffInput, priorSessionHash: string | null): Promise<void>;
  claimHandoff(hash: string, context: string, browserHash: string, provider: LoginTransaction): Promise<void>;
  reserveProvider(hash: string, context: string, browserHash: string, providerState: string, reservationHash: string): Promise<NativeProviderReservation | null>;
  completeProvider(hash: string, context: string, reservationHash: string, codeHash: string, identity: CustomerIdentity): Promise<void>;
  exchange(hash: string, context: string, input: { state: string; verifier: string; codeHash: string; sessionHash: string }): Promise<NativeSession>;
  cancel(hash: string, context: string, verifier: string): Promise<boolean>;
  readSession(hash: string, context: string): Promise<NativeSession | null>;
  logout(hash: string, context: string): Promise<boolean>;
  close(): Promise<void>;
}
export class NativeStoreError extends Error {
  constructor(readonly code: "unavailable" | "capacity" | "invalid") { super(`Native authentication ${code}`); }
}
type Limits = { families: number; handoffs: number; sessions: number };
const DEFAULTS: Limits = { families: 2048, handoffs: 4096, sessions: 8192 };
const S = "paypal_markets_native_auth";
const unavailable = () => new NativeStoreError("unavailable");
function hash(value: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new NativeStoreError("invalid"); }
function handle(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) throw new NativeStoreError("invalid");
}
function same(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function identity(value: CustomerIdentity): void {
  if (!["personal", "business", "unknown"].includes(value.accountType) || !/^v1_[A-Za-z0-9_-]{43}$/.test(value.dataScope)) throw new NativeStoreError("invalid");
}
type Row = {
  handle_hash: string; family_hash: string; family_generation: number; generation: number;
  initial_session_hash: string | null; platform: "android" | "ios"; app_state: string; challenge: string; status: string;
  browser_hash: string | null; provider_state: string | null; provider_nonce: string | null; provider_verifier: string | null;
  reservation_hash: string | null; code_hash: string | null; code_live: boolean;
  account_type: CustomerIdentity["accountType"] | null; data_scope: string | null;
  issued: boolean; live: boolean; family_live: boolean;
};
/** Unwired foundation. Callers supply only hashed handles and a verified TLS pool config.
 * A single native-only transaction lock bounds quotas and serializes mutations across
 * processes. No provider/network work occurs inside these transactions. */
export function createNativePostgresStore(config: PoolConfig, testLimits: Partial<Limits> = {}): NativeAuthStore {
  const limits = { ...DEFAULTS, ...testLimits };
  for (const k of Object.keys(DEFAULTS) as (keyof Limits)[]) if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > DEFAULTS[k]) throw new NativeStoreError("invalid");
  const pool = new Pool({ ...config, max: 3, connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2500, idleTimeoutMillis: 10000 });
  pool.on("error", () => {});
  async function tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect(); let discard = false;
    try { await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(1347437612, 1312904278)"); const result = await work(c); await c.query("COMMIT"); return result; }
    catch (error) { try { await c.query("ROLLBACK"); } catch { discard = true; } throw error; }
    finally { c.release(discard); }
  }
  async function cleanup(c: PoolClient) {
    // At most 100 rows total, no cascading delete. Preserve every alias and
    // cancel proof while its family can have an active descendant.
    let remaining = 100;
    for (const table of ["handoffs", "sessions"] as const) {
      const r = await c.query(`DELETE FROM ${S}.${table} WHERE handle_hash IN
        (SELECT t.handle_hash FROM ${S}.${table} t JOIN ${S}.families f USING(family_hash) WHERE f.expires_at<=now() LIMIT $1)`, [remaining]);
      remaining -= r.rowCount ?? 0;
    }
    if (remaining) await c.query(`DELETE FROM ${S}.families WHERE family_hash IN (SELECT f.family_hash FROM ${S}.families f WHERE f.expires_at<=now()
      AND NOT EXISTS(SELECT 1 FROM ${S}.handoffs h WHERE h.family_hash=f.family_hash)
      AND NOT EXISTS(SELECT 1 FROM ${S}.sessions s WHERE s.family_hash=f.family_hash) LIMIT $1)`, [remaining]);
  }
  async function capacity(c: PoolClient, table: keyof Limits) {
    const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${S}.${table}`);
    if (Number(r.rows[0].n) >= limits[table]) throw new NativeStoreError("capacity");
  }
  async function row(c: PoolClient, h: string, context: string): Promise<Row | null> {
    const r = await c.query<Row>(`SELECT h.*,f.generation,(h.expires_at>now()) AS live,
      (f.expires_at>now() AND NOT f.revoked) AS family_live,(h.code_expires_at>now()) AS code_live
      FROM ${S}.handoffs h JOIN ${S}.families f USING(family_hash)
      WHERE h.handle_hash=$1 AND h.context_hash=$2 AND f.context_hash=$2`, [h, context]);
    return r.rows[0] ?? null;
  }
  function pending(r: Row | null): asserts r is Row { if (!r || !r.live || !r.family_live || r.family_generation !== r.generation) throw unavailable(); }
  async function revoke(c: PoolClient, family: string) {
    await c.query(`UPDATE ${S}.families SET revoked=true WHERE family_hash=$1`, [family]);
    await c.query(`UPDATE ${S}.sessions SET revoked=true WHERE family_hash=$1`, [family]);
    await c.query(`UPDATE ${S}.handoffs SET status='cancelled',provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,account_type=NULL,data_scope=NULL WHERE family_hash=$1`, [family]);
  }
  async function session(c: PoolClient, h: string, context: string) {
    const r = await c.query<{ family_hash: string; generation: number; account_type: CustomerIdentity["accountType"]; data_scope: string; expires_at: Date }>(`SELECT s.family_hash,f.generation,s.account_type,s.data_scope,s.expires_at
      FROM ${S}.sessions s JOIN ${S}.families f USING(family_hash) WHERE s.handle_hash=$1 AND s.context_hash=$2 AND f.context_hash=$2
      AND NOT s.revoked AND NOT f.revoked AND s.family_generation=f.generation AND s.expires_at>now() AND f.expires_at>now()`, [h, context]);
    return r.rows[0] ?? null;
  }
  return {
    async ready() {
      try {
        await pool.query(`SELECT family_hash,context_hash,generation,revoked,expires_at FROM ${S}.families WHERE false`);
        await pool.query(`SELECT handle_hash,context_hash,family_hash,family_generation,initial_session_hash,app_state,challenge,platform,status,browser_hash,provider_state,provider_nonce,provider_verifier,reservation_hash,code_hash,code_expires_at,account_type,data_scope,issued,expires_at FROM ${S}.handoffs WHERE false`);
        await pool.query(`SELECT handle_hash,context_hash,family_hash,family_generation,revoked,account_type,data_scope,expires_at FROM ${S}.sessions WHERE false`);
        const r = await pool.query<{ allowed: boolean }>(`SELECT bool_and(has_table_privilege(current_user,t,p)) AS allowed FROM unnest(ARRAY['${S}.families','${S}.handoffs','${S}.sessions']) t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`);
        return r.rows[0]?.allowed === true;
      } catch { return false; }
    },
    async canStartHandoff(h, context) {
      [h, context].forEach(hash);
      return tx(async c => { const r = await row(c, h, context); return !!r && r.live && r.family_live && r.family_generation === r.generation && r.status === "pending"; });
    },
    async createHandoff(h, context, input, prior) {
      hash(h); hash(context); if (prior) hash(prior); handle(input.state); handle(input.challenge);
      if (!["android", "ios"].includes(input.platform)) throw new NativeStoreError("invalid");
      await tx(cleanup);
      await tx(async c => {
        await capacity(c, "handoffs");
        let family = h; let generation = 0;
        if (prior) {
          const previous = await session(c, prior, context); if (!previous) throw unavailable();
          family = previous.family_hash; generation = previous.generation;
          await c.query(`UPDATE ${S}.handoffs SET status='superseded',provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,account_type=NULL,data_scope=NULL
            WHERE family_hash=$1 AND status IN ('pending','claimed','processing','ready')`, [family]);
          await c.query(`UPDATE ${S}.families SET expires_at=GREATEST(expires_at,now()+interval '5 minutes') WHERE family_hash=$1`, [family]);
        } else { await capacity(c, "families"); await c.query(`INSERT INTO ${S}.families(family_hash,context_hash,expires_at) VALUES($1,$2,now()+interval '5 minutes')`, [family, context]); }
        await c.query(`INSERT INTO ${S}.handoffs(handle_hash,context_hash,family_hash,family_generation,initial_session_hash,app_state,challenge,platform,status,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',now()+interval '5 minutes')`, [h, context, family, generation, prior, input.state, input.challenge, input.platform]);
      });
    },
    async claimHandoff(h, context, browser, provider) {
      [h, context, browser].forEach(hash); [provider.state, provider.nonce, provider.verifier].forEach(handle);
      await tx(async c => { const r = await row(c, h, context); pending(r); if (r.status !== "pending") throw unavailable();
        await c.query(`UPDATE ${S}.handoffs SET status='claimed',browser_hash=$2,provider_state=$3,provider_nonce=$4,provider_verifier=$5 WHERE handle_hash=$1`, [h, browser, provider.state, provider.nonce, provider.verifier]); });
    },
    async reserveProvider(h, context, browser, state, reservation) {
      [h, context, browser, reservation].forEach(hash); handle(state);
      return tx(async c => { const r = await row(c, h, context);
        if (!r || !r.live || !r.family_live || r.family_generation !== r.generation || r.status !== "claimed" || !r.browser_hash || !same(r.browser_hash, browser) || !r.provider_state || !same(r.provider_state, state)) return null;
        const result = { transaction: { state: r.provider_state, nonce: r.provider_nonce!, verifier: r.provider_verifier! }, appState: r.app_state, platform: r.platform };
        await c.query(`UPDATE ${S}.handoffs SET status='processing',reservation_hash=$2,provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL WHERE handle_hash=$1`, [h, reservation]); return result;
      });
    },
    async completeProvider(h, context, reservation, code, owner) {
      [h, context, reservation, code].forEach(hash); identity(owner);
      await tx(async c => { const r = await row(c, h, context); pending(r); if (r.status !== "processing" || !r.reservation_hash || !same(r.reservation_hash, reservation)) throw unavailable();
        if (r.initial_session_hash && !await session(c, r.initial_session_hash, context)) throw unavailable();
        await c.query(`UPDATE ${S}.handoffs SET status='ready',reservation_hash=NULL,code_hash=$2,code_expires_at=LEAST(expires_at,now()+interval '60 seconds'),account_type=$3,data_scope=$4 WHERE handle_hash=$1`, [h, code, owner.accountType, owner.dataScope]);
      });
    },
    async exchange(h, context, input) {
      [h, context, input.codeHash, input.sessionHash].forEach(hash); handle(input.state); handle(input.verifier);
      const challenge = createHash("sha256").update(input.verifier, "ascii").digest("base64url");
      return tx(async c => { const r = await row(c, h, context); pending(r);
        if (r.status !== "ready" || !r.code_live || !r.code_hash || !same(r.code_hash, input.codeHash) || !same(r.app_state, input.state) || !same(r.challenge, challenge) || !r.account_type || !r.data_scope) throw unavailable();
        if (r.initial_session_hash && !await session(c, r.initial_session_hash, context)) throw unavailable();
        await capacity(c, "sessions");
        await c.query(`UPDATE ${S}.sessions SET revoked=true WHERE family_hash=$1`, [r.family_hash]);
        await c.query(`UPDATE ${S}.families SET generation=generation+1,expires_at=now()+interval '30 minutes' WHERE family_hash=$1`, [r.family_hash]);
        const result = await c.query<{ expires_at: Date }>(`INSERT INTO ${S}.sessions(handle_hash,context_hash,family_hash,family_generation,account_type,data_scope,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes') RETURNING expires_at`, [input.sessionHash, context, r.family_hash, r.generation + 1, r.account_type, r.data_scope]);
        await c.query(`UPDATE ${S}.handoffs SET status='exchanged',issued=true,code_hash=NULL,account_type=NULL,data_scope=NULL WHERE handle_hash=$1`, [h]);
        return { accountType: r.account_type, dataScope: r.data_scope, expiresAt: result.rows[0].expires_at.toISOString() };
      });
    },
    async cancel(h, context, verifier) {
      [h, context].forEach(hash); handle(verifier); const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      return tx(async c => {
        // Do not mistake a context-filtered miss for authoritative absence.
        const found = await c.query<{ family_hash: string; context_hash: string; family_context: string | null; challenge: string; issued: boolean }>(`SELECT h.family_hash,h.context_hash,f.context_hash AS family_context,h.challenge,h.issued FROM ${S}.handoffs h LEFT JOIN ${S}.families f USING(family_hash) WHERE h.handle_hash=$1`, [h]);
        const r = found.rows[0];
        if (!r) return true; // Cleanup cannot remove proof while descendants live.
        if (!r.family_context) throw unavailable();
        if (!same(r.context_hash, context) || !same(r.family_context, context) || !same(r.challenge, challenge)) return false;
        if (r.issued) await revoke(c, r.family_hash);
        else await c.query(`UPDATE ${S}.handoffs SET status='cancelled',provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,account_type=NULL,data_scope=NULL WHERE handle_hash=$1`, [h]);
        return true;
      });
    },
    async readSession(h, context) {
      [h, context].forEach(hash); return tx(async c => { const r = await session(c, h, context); return r ? { accountType: r.account_type, dataScope: r.data_scope, expiresAt: r.expires_at.toISOString() } : null; });
    },
    async logout(h, context) {
      [h, context].forEach(hash); return tx(async c => {
        const r = await c.query<{ family_hash: string; context_hash: string; family_context: string | null }>(`SELECT s.family_hash,s.context_hash,f.context_hash AS family_context FROM ${S}.sessions s LEFT JOIN ${S}.families f USING(family_hash)
          WHERE s.handle_hash=$1`, [h]);
        if (!r.rows[0]) return true;
        if (!r.rows[0].family_context) throw unavailable();
        if (!same(r.rows[0].context_hash, context) || !same(r.rows[0].family_context, context)) return false;
        await revoke(c, r.rows[0].family_hash); return true;
      });
    },
    async close() { await pool.end(); },
  };
}
