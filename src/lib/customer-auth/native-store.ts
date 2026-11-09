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
  claimHandoff(hash: string, context: string, browserHash: string, provider: LoginTransaction, claimHash: string): Promise<void>;
  abortClaim(hash: string, context: string, browserHash: string, claimHash: string): Promise<void>;
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
  issued: boolean; live: boolean; family_live: boolean; prior_live: boolean;
};
/** Unwired foundation. Callers supply only hashed handles and a verified TLS pool config.
 * A single native-only transaction lock bounds quotas and serializes mutations across
 * processes. No provider/network work occurs inside these transactions. */
export function createNativePostgresStore(config: PoolConfig, testLimits: Partial<Limits> = {}): NativeAuthStore {
  const limits = { ...DEFAULTS, ...testLimits };
  for (const k of Object.keys(DEFAULTS) as (keyof Limits)[]) if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > DEFAULTS[k]) throw new NativeStoreError("invalid");
  const pool = new Pool({ ...config, max: 3, connectionTimeoutMillis: 2500, query_timeout: 2500, statement_timeout: 2500, idleTimeoutMillis: 10000 });
  pool.on("error", () => {});
  // A process-local scan cursor prevents persistently locked early rows from
  // hiding all later candidates. It is not a durable retention scheduler.
  let cleanupCursor = "";
  let familyCleanupCursor = "";
  async function tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect(); let discard = false;
    try { await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(1347437612, 1312904278)"); const result = await work(c); await c.query("COMMIT"); return result; }
    catch (error) { try { await c.query("ROLLBACK"); } catch { discard = true; } throw error; }
    finally { c.release(discard); }
  }
  async function scrubExpiredHandoffs(c: PoolClient, cursor: string): Promise<string> {
    // Scan a small bounded page. Apply all eligibility filters before LIMIT so
    // retained issued/pending proofs cannot crowd out expired secret material.
    const candidates = async (after: string) => c.query<{ handle_hash: string; family_hash: string; context_hash: string }>(`
      SELECT h.handle_hash,h.family_hash,h.context_hash FROM ${S}.handoffs h
      JOIN ${S}.families f ON f.family_hash=h.family_hash AND f.context_hash=h.context_hash
      WHERE h.handle_hash>$1 AND NOT h.issued AND NOT f.revoked AND f.expires_at>clock_timestamp()
        AND ((h.status IN ('claimed','processing') AND h.expires_at<=clock_timestamp()) OR
             (h.status='ready' AND (h.expires_at<=clock_timestamp() OR h.code_expires_at<=clock_timestamp())))
      ORDER BY h.handle_hash LIMIT 40`, [after]);
    let nextCursor = cursor;
    let page = await candidates(nextCursor);
    if (!page.rowCount && nextCursor) { nextCursor = ""; page = await candidates(nextCursor); }
    let scrubbed = 0;
    for (const candidate of page.rows) {
      nextCursor = candidate.handle_hash;
      // Match live operations' family-first order without waiting behind an
      // independently locked row. A later pass can revisit skipped rows.
      const family = await c.query(`SELECT 1 FROM ${S}.families WHERE family_hash=$1 AND context_hash=$2 FOR UPDATE SKIP LOCKED`,
        [candidate.family_hash, candidate.context_hash]);
      if (!family.rowCount) continue;
      const handoff = await c.query(`SELECT 1 FROM ${S}.handoffs WHERE handle_hash=$1 AND family_hash=$2 AND context_hash=$3 FOR UPDATE SKIP LOCKED`,
        [candidate.handle_hash, candidate.family_hash, candidate.context_hash]);
      if (!handoff.rowCount) continue;
      const changed = await c.query(`UPDATE ${S}.handoffs h SET status='cancelled',browser_hash=NULL,provider_state=NULL,provider_nonce=NULL,
        provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,code_expires_at=NULL,account_type=NULL,data_scope=NULL
        WHERE h.handle_hash=$1 AND h.family_hash=$2 AND h.context_hash=$3 AND NOT h.issued
          AND ((h.status IN ('claimed','processing') AND h.expires_at<=clock_timestamp()) OR
               (h.status='ready' AND (h.expires_at<=clock_timestamp() OR h.code_expires_at<=clock_timestamp())))
          AND EXISTS (SELECT 1 FROM ${S}.families f WHERE f.family_hash=h.family_hash AND f.context_hash=h.context_hash
            AND NOT f.revoked AND f.expires_at>clock_timestamp())`,
      [candidate.handle_hash, candidate.family_hash, candidate.context_hash]);
      scrubbed += changed.rowCount ?? 0;
      if (scrubbed >= 20) break;
    }
    return nextCursor;
  }
  async function cleanup(c: PoolClient, cursor: string): Promise<string> {
    // Family-first locking protects an extension already in progress. The
    // separate post-lock expiry check avoids using an old snapshot after a wait.
    const candidates = async (after: string) => c.query<{ family_hash: string }>(`
      SELECT family_hash FROM ${S}.families WHERE family_hash>$1 AND expires_at<=clock_timestamp()
      ORDER BY family_hash LIMIT 40`, [after]);
    let nextCursor = cursor;
    let page = await candidates(nextCursor);
    if (!page.rowCount && nextCursor) { nextCursor = ""; page = await candidates(nextCursor); }
    // At most 100 deleted rows and 40 visited families per pass. Locks on
    // independent child operations are skipped, not waited on.
    let remaining = 100;
    for (const candidate of page.rows) {
      nextCursor = candidate.family_hash;
      const family = await c.query(`SELECT 1 FROM ${S}.families WHERE family_hash=$1 FOR UPDATE SKIP LOCKED`, [candidate.family_hash]);
      if (!family.rowCount) continue;
      const expired = await c.query(`SELECT 1 FROM ${S}.families WHERE family_hash=$1 AND expires_at<=clock_timestamp()`, [candidate.family_hash]);
      if (!expired.rowCount) continue;
      for (const table of ["handoffs", "sessions"] as const) {
        const deleted = await c.query(`WITH selected AS MATERIALIZED (
          SELECT handle_hash FROM ${S}.${table} WHERE family_hash=$1 ORDER BY handle_hash LIMIT $2 FOR UPDATE SKIP LOCKED
        ) DELETE FROM ${S}.${table} t USING selected s
          WHERE t.handle_hash=s.handle_hash AND t.family_hash=$1`, [candidate.family_hash, remaining]);
        remaining -= deleted.rowCount ?? 0;
        if (!remaining) break;
      }
      if (remaining) {
        const deleted = await c.query(`DELETE FROM ${S}.families f WHERE f.family_hash=$1 AND f.expires_at<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM ${S}.handoffs h WHERE h.family_hash=f.family_hash)
          AND NOT EXISTS(SELECT 1 FROM ${S}.sessions s WHERE s.family_hash=f.family_hash)`, [candidate.family_hash]);
        remaining -= deleted.rowCount ?? 0;
      }
      if (!remaining) break;
    }
    return nextCursor;
  }
  // Keep a store instance's cursor publication ordered with its maintenance
  // commits. The database advisory lock separately coordinates other instances.
  let cleanupQueue: Promise<void> = Promise.resolve();
  function runCleanup(): Promise<void> {
    const current = cleanupQueue.then(async () => {
      // Commit the family-first scrub before deleting expired-family children.
      // This prevents a later deletion from waiting on a child while still
      // holding a live family's lock acquired by the scrub.
      cleanupCursor = await tx(c => scrubExpiredHandoffs(c, cleanupCursor));
      familyCleanupCursor = await tx(c => cleanup(c, familyCleanupCursor));
    });
    cleanupQueue = current.catch(() => {});
    return current;
  }
  async function capacity(c: PoolClient, table: keyof Limits) {
    const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${S}.${table}`);
    if (Number(r.rows[0].n) >= limits[table]) throw new NativeStoreError("capacity");
  }
  async function row(c: PoolClient, h: string, context: string): Promise<Row | null> {
    const r = await c.query<Row>(`SELECT h.*,f.generation,(h.expires_at>clock_timestamp()) AS live,
      (f.expires_at>clock_timestamp() AND NOT f.revoked) AS family_live,(h.code_expires_at>clock_timestamp()) AS code_live,
      (h.initial_session_hash IS NULL OR EXISTS (SELECT 1 FROM ${S}.sessions s WHERE s.handle_hash=h.initial_session_hash
        AND s.context_hash=h.context_hash AND s.family_hash=h.family_hash AND s.family_generation=f.generation
        AND NOT s.revoked AND s.expires_at>clock_timestamp())) AS prior_live
      FROM ${S}.handoffs h JOIN ${S}.families f USING(family_hash)
      WHERE h.handle_hash=$1 AND h.context_hash=$2 AND f.context_hash=$2`, [h, context]);
    return r.rows[0] ?? null;
  }
  function pending(r: Row | null): asserts r is Row { if (!r || !r.live || !r.family_live || !r.prior_live || r.family_generation !== r.generation) throw unavailable(); }
  async function revoke(c: PoolClient, family: string) {
    await c.query(`UPDATE ${S}.families SET revoked=true WHERE family_hash=$1`, [family]);
    await c.query(`UPDATE ${S}.sessions SET revoked=true WHERE family_hash=$1`, [family]);
    await c.query(`UPDATE ${S}.handoffs SET status='cancelled',provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,account_type=NULL,data_scope=NULL WHERE family_hash=$1`, [family]);
  }
  async function session(c: PoolClient, h: string, context: string) {
    const r = await c.query<{ family_hash: string; generation: number; account_type: CustomerIdentity["accountType"]; data_scope: string; expires_at: Date }>(`SELECT s.family_hash,f.generation,s.account_type,s.data_scope,s.expires_at
      FROM ${S}.sessions s JOIN ${S}.families f USING(family_hash) WHERE s.handle_hash=$1 AND s.context_hash=$2 AND f.context_hash=$2
      AND NOT s.revoked AND NOT f.revoked AND s.family_generation=f.generation AND s.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()`, [h, context]);
    return r.rows[0] ?? null;
  }
  // Family first matches cancellation/logout. Read expiry only in a separate
  // statement after row locks, since a lock-only wait can make an earlier
  // predicate stale even when the locked row was not updated.
  async function lockedHandoff(c: PoolClient, h: string, context: string): Promise<Row | null> {
    const lookup = await c.query<{ family_hash: string }>(`SELECT family_hash FROM ${S}.handoffs WHERE handle_hash=$1 AND context_hash=$2`, [h, context]);
    const family = lookup.rows[0]?.family_hash;
    if (!family) return null;
    const f = await c.query(`SELECT 1 FROM ${S}.families WHERE family_hash=$1 AND context_hash=$2 FOR UPDATE`, [family, context]);
    if (!f.rowCount) return null;
    const handoff = await c.query(`SELECT 1 FROM ${S}.handoffs WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 FOR UPDATE`, [h, context, family]);
    return handoff.rowCount ? row(c, h, context) : null;
  }
  async function lockedSession(c: PoolClient, h: string, context: string) {
    const lookup = await c.query<{ family_hash: string }>(`SELECT family_hash FROM ${S}.sessions WHERE handle_hash=$1 AND context_hash=$2`, [h, context]);
    const family = lookup.rows[0]?.family_hash;
    if (!family) return null;
    const f = await c.query(`SELECT 1 FROM ${S}.families WHERE family_hash=$1 AND context_hash=$2 FOR UPDATE`, [family, context]);
    if (!f.rowCount) return null;
    const s = await c.query(`SELECT 1 FROM ${S}.sessions WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 FOR UPDATE`, [h, context, family]);
    return s.rowCount ? session(c, h, context) : null;
  }
  async function lockedHandoffWithPrior(c: PoolClient, h: string, context: string): Promise<Row | null> {
    const handoff = await lockedHandoff(c, h, context);
    if (!handoff) return null;
    if (handoff.initial_session_hash) {
      const previous = await c.query(`SELECT 1 FROM ${S}.sessions WHERE handle_hash=$1 AND family_hash=$2 AND context_hash=$3 FOR UPDATE`,
        [handoff.initial_session_hash, handoff.family_hash, context]);
      if (!previous.rowCount) return null;
    }
    return row(c, h, context);
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
      return tx(async c => { const r = await row(c, h, context); return !!r && r.live && r.family_live && r.prior_live && r.family_generation === r.generation && r.status === "pending"; });
    },
    async createHandoff(h, context, input, prior) {
      hash(h); hash(context); if (prior) hash(prior); handle(input.state); handle(input.challenge);
      if (!["android", "ios"].includes(input.platform)) throw new NativeStoreError("invalid");
      // Publish the in-memory cursor only after the maintenance commit. A
      // rolled-back pass must not skip its candidates on the next attempt.
      await runCleanup();
      await tx(async c => {
        await capacity(c, "handoffs");
        let family = h; let generation = 0;
        if (prior) {
          const previous = await lockedSession(c, prior, context); if (!previous) throw unavailable();
          family = previous.family_hash; generation = previous.generation;
          await c.query(`UPDATE ${S}.handoffs SET status='superseded',provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,reservation_hash=NULL,code_hash=NULL,account_type=NULL,data_scope=NULL
            WHERE family_hash=$1 AND status IN ('pending','claimed','processing','ready')`, [family]);
          const current = await session(c, prior, context);
          if (!current || current.family_hash !== family || current.generation !== generation) throw unavailable();
        } else { await capacity(c, "families"); await c.query(`INSERT INTO ${S}.families(family_hash,context_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '5 minutes')`, [family, context]); }
        await c.query(`INSERT INTO ${S}.handoffs(handle_hash,context_hash,family_hash,family_generation,initial_session_hash,app_state,challenge,platform,status,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',clock_timestamp()+interval '5 minutes')`, [h, context, family, generation, prior, input.state, input.challenge, input.platform]);
        const created = await row(c, h, context); pending(created);
        if (created.status !== "pending" || created.family_hash !== family || created.initial_session_hash !== prior) throw unavailable();
        if (prior) {
          // The insert or supersession may have waited. Keep the original
          // family/session expiry authoritative until the last guarded update.
          const extended = await c.query(`UPDATE ${S}.families f SET expires_at=GREATEST(f.expires_at,clock_timestamp()+interval '5 minutes')
            WHERE f.family_hash=$1 AND f.context_hash=$2 AND f.generation=$3 AND NOT f.revoked AND f.expires_at>clock_timestamp()
              AND EXISTS (SELECT 1 FROM ${S}.sessions s WHERE s.handle_hash=$4 AND s.context_hash=$2 AND s.family_hash=$1
                AND s.family_generation=$3 AND NOT s.revoked AND s.expires_at>clock_timestamp())
              AND EXISTS (SELECT 1 FROM ${S}.handoffs n WHERE n.handle_hash=$5 AND n.context_hash=$2 AND n.family_hash=$1
                AND n.family_generation=$3 AND n.status='pending' AND n.expires_at>clock_timestamp())`,
          [family, context, generation, prior, h]);
          if (!extended.rowCount) throw unavailable();
        }
      });
    },
    async claimHandoff(h, context, browser, provider, claim) {
      [h, context, browser, claim].forEach(hash); [provider.state, provider.nonce, provider.verifier].forEach(handle);
      await tx(async c => { const r = await lockedHandoffWithPrior(c, h, context); pending(r); if (r.status !== "pending") throw unavailable();
        // While claimed, reservation_hash holds this POST's independent claim
        // tag. reserveProvider replaces it with its own reservation tag.
        await c.query(`UPDATE ${S}.handoffs SET status='claimed',browser_hash=$2,provider_state=$3,provider_nonce=$4,provider_verifier=$5,reservation_hash=$6 WHERE handle_hash=$1`, [h, browser, provider.state, provider.nonce, provider.verifier, claim]);
        const claimed = await row(c, h, context); pending(claimed);
        if (claimed.status !== "claimed" || claimed.browser_hash !== browser || claimed.reservation_hash !== claim) throw unavailable(); });
    },
    async abortClaim(h, context, browser, claim) {
      [h, context, browser, claim].forEach(hash);
      await tx(async c => {
        // Do not require an unexpired handoff: an ambiguous claim can expire
        // before cleanup. The exact tag prevents a failed competing POST
        // from cancelling the winner, even if their provider values match.
        const r = await lockedHandoff(c, h, context);
        if (!r || r.issued || r.status !== "claimed" || !r.browser_hash || !same(r.browser_hash, browser) ||
            !r.reservation_hash || !same(r.reservation_hash, claim)) return;
        await c.query(`UPDATE ${S}.handoffs SET status='cancelled',browser_hash=NULL,provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL,
          reservation_hash=NULL,code_hash=NULL,code_expires_at=NULL,account_type=NULL,data_scope=NULL
          WHERE handle_hash=$1 AND context_hash=$2 AND browser_hash=$3 AND reservation_hash=$4 AND status='claimed' AND NOT issued`,
        [h, context, browser, claim]);
      });
    },
    async reserveProvider(h, context, browser, state, reservation) {
      [h, context, browser, reservation].forEach(hash); handle(state);
      return tx(async c => { const r = await lockedHandoffWithPrior(c, h, context);
        if (!r || !r.live || !r.family_live || !r.prior_live || r.family_generation !== r.generation || r.status !== "claimed" || !r.browser_hash || !same(r.browser_hash, browser) || !r.provider_state || !same(r.provider_state, state)) return null;
        const result = { transaction: { state: r.provider_state, nonce: r.provider_nonce!, verifier: r.provider_verifier! }, appState: r.app_state, platform: r.platform };
        await c.query(`UPDATE ${S}.handoffs SET status='processing',reservation_hash=$2,provider_state=NULL,provider_nonce=NULL,provider_verifier=NULL WHERE handle_hash=$1`, [h, reservation]);
        const reserved = await row(c, h, context); pending(reserved);
        if (reserved.status !== "processing" || reserved.reservation_hash !== reservation) throw unavailable();
        return result;
      });
    },
    async completeProvider(h, context, reservation, code, owner) {
      [h, context, reservation, code].forEach(hash); identity(owner);
      await tx(async c => { const r = await lockedHandoffWithPrior(c, h, context); pending(r);
        if (r.status !== "processing" || !r.reservation_hash || !same(r.reservation_hash, reservation)) throw unavailable();
        if (r.initial_session_hash && !await session(c, r.initial_session_hash, context)) throw unavailable();
        await c.query(`UPDATE ${S}.handoffs SET status='ready',reservation_hash=NULL,code_hash=$2,code_expires_at=LEAST(expires_at,clock_timestamp()+interval '60 seconds'),account_type=$3,data_scope=$4 WHERE handle_hash=$1`, [h, code, owner.accountType, owner.dataScope]);
        const completed = await row(c, h, context); pending(completed);
        if (completed.status !== "ready" || !completed.code_live || completed.code_hash !== code ||
            (completed.initial_session_hash && !await session(c, completed.initial_session_hash, context))) throw unavailable();
      });
    },
    async exchange(h, context, input) {
      [h, context, input.codeHash, input.sessionHash].forEach(hash); handle(input.state); handle(input.verifier);
      const challenge = createHash("sha256").update(input.verifier, "ascii").digest("base64url");
      return tx(async c => { const locked = await lockedHandoff(c, h, context); pending(locked);
        // Revocation updates every retained alias. Lock them in a stable order
        // before checking time so an alias lock wait cannot extend authority.
        await c.query(`SELECT handle_hash FROM ${S}.sessions WHERE family_hash=$1 ORDER BY handle_hash FOR UPDATE`, [locked.family_hash]);
        const checkReady = async () => {
          const r = await row(c, h, context); pending(r);
          if (r.status !== "ready" || !r.code_live || !r.code_hash || !same(r.code_hash, input.codeHash) || !same(r.app_state, input.state) || !same(r.challenge, challenge) || !r.account_type || !r.data_scope) throw unavailable();
          if (r.initial_session_hash && !await session(c, r.initial_session_hash, context)) throw unavailable();
          return r;
        };
        const r = await checkReady();
        const accountType = r.account_type, dataScope = r.data_scope;
        if (!accountType || !dataScope) throw unavailable();
        await capacity(c, "sessions");
        const result = await c.query<{ expires_at: Date }>(`INSERT INTO ${S}.sessions(handle_hash,context_hash,family_hash,family_generation,account_type,data_scope,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '30 minutes') RETURNING expires_at`, [input.sessionHash, context, r.family_hash, r.generation + 1, accountType, dataScope]);
        // A uniqueness conflict can block the insert even after all existing
        // family rows are locked. Recheck before touching any old session.
        await checkReady();
        await c.query(`UPDATE ${S}.sessions SET revoked=true WHERE family_hash=$1 AND handle_hash<>$2`, [r.family_hash, input.sessionHash]);
        const exchanged = await c.query(`UPDATE ${S}.handoffs h SET status='exchanged',issued=true,code_hash=NULL,account_type=NULL,data_scope=NULL
          WHERE h.handle_hash=$1 AND h.context_hash=$2 AND h.family_hash=$3 AND h.family_generation=$4 AND h.status='ready'
            AND h.expires_at>clock_timestamp() AND h.code_expires_at>clock_timestamp()
            AND EXISTS (SELECT 1 FROM ${S}.families f WHERE f.family_hash=$3 AND f.context_hash=$2 AND f.generation=$4
              AND NOT f.revoked AND f.expires_at>clock_timestamp())
            AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM ${S}.sessions s WHERE s.handle_hash=$5 AND s.context_hash=$2
              AND s.family_hash=$3 AND s.family_generation=$4 AND s.revoked AND s.expires_at>clock_timestamp()))`,
        [h, context, r.family_hash, r.generation, r.initial_session_hash]);
        if (!exchanged.rowCount) throw unavailable();
        // This is the final authorization point before COMMIT. Do not extend
        // the family until the original family, handoff, code and previous
        // session have all passed one advancing-clock check.
        const extended = await c.query(`UPDATE ${S}.families f SET generation=f.generation+1,expires_at=clock_timestamp()+interval '30 minutes'
          WHERE f.family_hash=$1 AND f.context_hash=$2 AND f.generation=$3 AND NOT f.revoked AND f.expires_at>clock_timestamp()
            AND EXISTS (SELECT 1 FROM ${S}.handoffs h WHERE h.handle_hash=$4 AND h.context_hash=$2 AND h.family_hash=$1
              AND h.family_generation=$3 AND h.status='exchanged' AND h.issued AND h.expires_at>clock_timestamp()
              AND h.code_expires_at>clock_timestamp() AND h.initial_session_hash IS NOT DISTINCT FROM $5::text)
            AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM ${S}.sessions s WHERE s.handle_hash=$5 AND s.context_hash=$2
              AND s.family_hash=$1 AND s.family_generation=$3 AND s.revoked AND s.expires_at>clock_timestamp()))
            AND EXISTS (SELECT 1 FROM ${S}.sessions n WHERE n.handle_hash=$6 AND n.context_hash=$2 AND n.family_hash=$1
              AND n.family_generation=$3+1 AND NOT n.revoked AND n.expires_at>clock_timestamp())`,
        [r.family_hash, context, r.generation, h, r.initial_session_hash, input.sessionHash]);
        if (!extended.rowCount) throw unavailable();
        return { accountType, dataScope, expiresAt: result.rows[0].expires_at.toISOString() };
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
