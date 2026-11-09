import "server-only";

import { Pool, type PoolClient, type PoolConfig } from "pg";

export type AccountType = "personal" | "business" | "unknown";
export type CustomerIdentity = { accountType: AccountType; dataScope: string };
export type LoginTransaction = { state: string; nonce: string; verifier: string };

export interface AuthStore {
  ready(): Promise<boolean>;
  createTransaction(handleHash: string, contextHash: string, transaction: LoginTransaction, sessionHash: string | null, priorTransactionHash: string | null): Promise<void>;
  consumeTransaction(handleHash: string, contextHash: string, submittedState: string): Promise<LoginTransaction | null>;
  createSession(handleHash: string, contextHash: string, identity: CustomerIdentity, transactionHash: string, previousHash: string | null): Promise<void>;
  readSession(handleHash: string, contextHash: string): Promise<CustomerIdentity | null>;
  logout(sessionHash: string | null, transactionHash: string | null): Promise<void>;
}

type Family = { family_hash: string; generation: number };
type StoreLimits = { families: number; transactions: number; sessions: number };
const DEFAULT_LIMITS: StoreLimits = { families: 2048, transactions: 4096, sessions: 8192 };

/** The optional pool config is for isolated socket-only tests; runtime supplies a verified TLS URL. */
export function createPostgresStore(config: PoolConfig, testLimits: Partial<StoreLimits> = {}): AuthStore & { close(): Promise<void> } {
  const limits = { ...DEFAULT_LIMITS, ...testLimits };
  for (const name of ["families", "transactions", "sessions"] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > DEFAULT_LIMITS[name]) throw new Error("Invalid authentication storage limit");
  }
  const pool = new Pool({
    ...config,
    max: 3,
    connectionTimeoutMillis: 2_500,
    query_timeout: 2_500,
    statement_timeout: 2_500,
    idleTimeoutMillis: 10_000,
  });
  // A disconnected idle client must not emit unhandled errors or sensitive logs.
  pool.on("error", () => {});

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let discardClient = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discardClient = true; }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  return {
    async ready() {
      try {
        await pool.query("SELECT family_hash, context_hash, generation, expires_at FROM paypal_markets_auth.session_families WHERE false");
        await pool.query("SELECT handle_hash, context_hash, family_hash, family_generation, initial_session_hash, status, state, nonce, verifier, expires_at FROM paypal_markets_auth.login_transactions WHERE false");
        await pool.query("SELECT handle_hash, context_hash, family_hash, family_generation, revoked, account_type, data_scope, expires_at FROM paypal_markets_auth.sessions WHERE false");
        const result = await pool.query<{ allowed: boolean }>(`
          SELECT bool_and(has_table_privilege(current_user, t.table_name, p.privilege)) AS allowed
          FROM unnest(ARRAY['paypal_markets_auth.session_families','paypal_markets_auth.login_transactions','paypal_markets_auth.sessions']) AS t(table_name)
          CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
        `);
        return result.rows[0]?.allowed === true;
      } catch {
        return false;
      }
    },
    async createTransaction(handleHash, contextHash, login, sessionHash, priorTransactionHash) {
      // Cleanup commits before family locks are acquired. Keeping a deleted
      // child row locked while waiting for a family can deadlock with logout.
      // Recheck the target row after a lock wait: another transaction may
      // have extended an initially expired row while cleanup was waiting.
      await pool.query(`DELETE FROM paypal_markets_auth.login_transactions WHERE expires_at<=clock_timestamp() AND handle_hash IN
        (SELECT handle_hash FROM paypal_markets_auth.login_transactions WHERE expires_at <= now() LIMIT 100)`);
      await pool.query(`DELETE FROM paypal_markets_auth.session_families WHERE expires_at<=clock_timestamp() AND family_hash IN
        (SELECT family_hash FROM paypal_markets_auth.session_families WHERE expires_at <= now() LIMIT 100)`);
      await transaction(async (client) => {
        // Serialize the global capacity check across app instances.
        await client.query("SELECT pg_advisory_xact_lock(1347437612, 1096111176)");
        // Keep old session aliases until their family expires: a delayed logout
        // must still reach any later descendant, even across multiple rotations.
        const count = await client.query<{ families: string; transactions: string }>(`SELECT
          (SELECT count(*) FROM paypal_markets_auth.session_families) AS families,
          (SELECT count(*) FROM paypal_markets_auth.login_transactions) AS transactions`);
        if (Number(count.rows[0]?.transactions) >= limits.transactions) throw new Error("Sign-in capacity reached");

        let familyHash: string | null = null;
        if (sessionHash) {
          const result = await client.query<{ family_hash: string }>(`
            SELECT family_hash FROM paypal_markets_auth.sessions
            WHERE handle_hash=$1 AND context_hash=$2 AND revoked=false AND expires_at>clock_timestamp()
          `, [sessionHash, contextHash]);
          if (!result.rows[0]) throw new Error("Initiating session is unavailable");
          familyHash = result.rows[0].family_hash;
        } else if (priorTransactionHash) {
          const result = await client.query<{ family_hash: string }>(`
            SELECT family_hash FROM paypal_markets_auth.login_transactions
            WHERE handle_hash=$1 AND context_hash=$2 AND expires_at>clock_timestamp()
          `, [priorTransactionHash, contextHash]);
          // A supplied earlier cookie must not silently become a new family:
          // logout or expiry could otherwise be crossed while this start waits.
          if (!result.rows[0]) throw new Error("Previous login is unavailable");
          familyHash = result.rows[0].family_hash;
        }

        let family: Family;
        if (familyHash) {
          const result = await client.query<Family>(`
            SELECT family_hash, generation FROM paypal_markets_auth.session_families
            WHERE family_hash=$1 AND context_hash=$2 FOR UPDATE
          `, [familyHash, contextHash]);
          if (!result.rows[0]) throw new Error("Login family is unavailable");
          family = result.rows[0];
          if (sessionHash) {
            const valid = await client.query(`SELECT 1 FROM paypal_markets_auth.sessions
              WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 AND family_generation=$4 AND revoked=false FOR UPDATE`,
            [sessionHash, contextHash, family.family_hash, family.generation]);
            if (!valid.rowCount) throw new Error("Initiating session is unavailable");
          } else if (priorTransactionHash) {
            const valid = await client.query(`SELECT 1 FROM paypal_markets_auth.login_transactions
              WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 AND family_generation=$4 FOR UPDATE`,
            [priorTransactionHash, contextHash, family.family_hash, family.generation]);
            if (!valid.rowCount) throw new Error("Previous login is unavailable");
          }
        } else {
          if (Number(count.rows[0]?.families) >= limits.families) throw new Error("Sign-in capacity reached");
          family = { family_hash: handleHash, generation: 0 };
          await client.query(`INSERT INTO paypal_markets_auth.session_families (family_hash, context_hash, generation, expires_at)
            VALUES ($1,$2,0,clock_timestamp()+interval '35 minutes')`, [family.family_hash, contextHash]);
        }

        // Family and initiating rows may have been live before a lock wait
        // but expired while waiting. Check their advancing-clock expiry only
        // after all relevant locks are held, and again after the insert.
        const assertFresh = async () => {
          if (!familyHash) return;
          const valid = await client.query(`
            SELECT 1 FROM paypal_markets_auth.session_families f
            WHERE f.family_hash=$1 AND f.context_hash=$2 AND f.generation=$3
              AND f.expires_at>clock_timestamp()
              AND (($4::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM paypal_markets_auth.sessions s
                WHERE s.handle_hash=$4 AND s.context_hash=$2 AND s.family_hash=$1
                  AND s.family_generation=$3 AND s.revoked=false AND s.expires_at>clock_timestamp()
              )) OR ($4::text IS NULL AND $5::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM paypal_markets_auth.login_transactions t
                WHERE t.handle_hash=$5 AND t.context_hash=$2 AND t.family_hash=$1
                  AND t.family_generation=$3 AND t.expires_at>clock_timestamp()
              )))
          `, [family.family_hash, contextHash, family.generation, sessionHash, priorTransactionHash]);
          if (!valid.rowCount) throw new Error("Login family is unavailable");
        };
        await assertFresh();
        await client.query(`INSERT INTO paypal_markets_auth.login_transactions
          (handle_hash, context_hash, family_hash, family_generation, initial_session_hash, status, state, nonce, verifier, expires_at)
          VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,clock_timestamp()+interval '5 minutes')`,
        [handleHash, contextHash, family.family_hash, family.generation, sessionHash, login.state, login.nonce, login.verifier]);
        await assertFresh();
      });
    },
    async consumeTransaction(handleHash, contextHash, submittedState) {
      return transaction(async (client) => {
        // Take the row lock before checking state, context or time: each may
        // change while another callback or logout holds the row.
        const locked = await client.query<LoginTransaction>(`
          SELECT state, nonce, verifier FROM paypal_markets_auth.login_transactions
          WHERE handle_hash=$1 AND status='pending' FOR UPDATE
        `, [handleHash]);
        const original = locked.rows[0];
        if (!original) return null;

        // The existing schema requires non-NULL values while processing.
        // Empty markers retain that compatibility without retaining OAuth
        // transaction secrets after the claim commits.
        const claimed = await client.query(`UPDATE paypal_markets_auth.login_transactions
          SET status='processing', state='', nonce='', verifier=''
          WHERE handle_hash=$1 AND context_hash=$2 AND status='pending'
            AND state=$3 AND expires_at>clock_timestamp()`, [handleHash, contextHash, submittedState]);
        if (claimed.rowCount) {
          // An UPDATE can itself wait after its predicate was evaluated. Do
          // not hand values to the provider if the claim expired meanwhile.
          const fresh = await client.query(`SELECT 1 FROM paypal_markets_auth.login_transactions
            WHERE handle_hash=$1 AND context_hash=$2 AND status='processing'
              AND state='' AND nonce='' AND verifier='' AND expires_at>clock_timestamp()`, [handleHash, contextHash]);
          if (fresh.rowCount) return original;
          await client.query(`UPDATE paypal_markets_auth.login_transactions SET status='completed', state=NULL, nonce=NULL, verifier=NULL
            WHERE handle_hash=$1 AND context_hash=$2 AND status='processing'`, [handleHash, contextHash]);
          return null;
        }

        // Preserve a live same-context attempt on a wrong state. Expired or
        // cross-context attempts are completed atomically with their cleanup.
        await client.query(`UPDATE paypal_markets_auth.login_transactions SET status='completed', state=NULL, nonce=NULL, verifier=NULL
          WHERE handle_hash=$1 AND status='pending' AND (context_hash<>$2 OR expires_at<=clock_timestamp())`, [handleHash, contextHash]);
        return null;
      });
    },
    async createSession(handleHash, contextHash, identity, transactionHash, previousHash) {
      await transaction(async (client) => {
        // The same shared lock serializes retained-record quotas across instances.
        await client.query("SELECT pg_advisory_xact_lock(1347437612, 1096111176)");
        const count = await client.query<{ count: string }>("SELECT count(*) AS count FROM paypal_markets_auth.sessions");
        if (Number(count.rows[0]?.count) >= limits.sessions) throw new Error("Session capacity reached");
        const lookup = await client.query<{ family_hash: string }>("SELECT family_hash FROM paypal_markets_auth.login_transactions WHERE handle_hash=$1", [transactionHash]);
        if (!lookup.rows[0]) throw new Error("Login transaction is unavailable");
        const locked = await client.query<Family>(`
          SELECT family_hash, generation FROM paypal_markets_auth.session_families
          WHERE family_hash=$1 AND context_hash=$2 FOR UPDATE
        `, [lookup.rows[0].family_hash, contextHash]);
        const family = locked.rows[0];
        if (!family) throw new Error("Login family is unavailable");
        const pending = await client.query<{ initial_session_hash: string | null }>(`
          SELECT initial_session_hash FROM paypal_markets_auth.login_transactions
          WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 AND family_generation=$4
            AND status='processing' FOR UPDATE
        `, [transactionHash, contextHash, family.family_hash, family.generation]);
        if (!pending.rows[0] || pending.rows[0].initial_session_hash !== previousHash) throw new Error("Login transaction is unavailable");
        if (previousHash) {
          const previous = await client.query(`SELECT 1 FROM paypal_markets_auth.sessions
            WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 AND family_generation=$4 AND revoked=false FOR UPDATE`,
          [previousHash, contextHash, family.family_hash, family.generation]);
          if (!previous.rowCount) throw new Error("Initiating session is unavailable");
        }
        // A transaction-start timestamp and a predicate evaluated while taking
        // a row lock can both be stale after a wait. Recheck all authorities in
        // a separate statement once their rows are locked, and again after the
        // insert, which can itself wait on a uniqueness conflict.
        const assertFresh = async () => {
          const valid = await client.query(`
            SELECT 1 FROM paypal_markets_auth.session_families f
            JOIN paypal_markets_auth.login_transactions t ON t.family_hash=f.family_hash
            WHERE f.family_hash=$1 AND f.context_hash=$2 AND f.generation=$3
              AND f.expires_at>clock_timestamp()
              AND t.handle_hash=$4 AND t.context_hash=$2 AND t.family_generation=$3
              AND t.status='processing' AND t.initial_session_hash IS NOT DISTINCT FROM $5::text
              AND t.expires_at>clock_timestamp()
              AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM paypal_markets_auth.sessions s
                WHERE s.handle_hash=$5 AND s.context_hash=$2 AND s.family_hash=$1
                  AND s.family_generation=$3 AND s.revoked=false AND s.expires_at>clock_timestamp()
              ))
          `, [family.family_hash, contextHash, family.generation, transactionHash, previousHash]);
          if (!valid.rowCount) throw new Error("Login transaction is unavailable");
        };
        await assertFresh();
        await client.query(`INSERT INTO paypal_markets_auth.sessions
          (handle_hash, context_hash, family_hash, family_generation, revoked, account_type, data_scope, expires_at)
          VALUES ($1,$2,$3,$4,false,$5,$6,clock_timestamp()+interval '30 minutes')`,
        [handleHash, contextHash, family.family_hash, family.generation, identity.accountType, identity.dataScope]);
        await assertFresh();
        if (previousHash) {
          const revoked = await client.query(`UPDATE paypal_markets_auth.sessions SET revoked=true
            WHERE handle_hash=$1 AND context_hash=$2 AND family_hash=$3 AND family_generation=$4
              AND revoked=false AND expires_at>clock_timestamp()`,
          [previousHash, contextHash, family.family_hash, family.generation]);
          if (!revoked.rowCount) throw new Error("Initiating session is unavailable");
        }
        const completed = await client.query(`UPDATE paypal_markets_auth.login_transactions SET status='completed', state=NULL, nonce=NULL, verifier=NULL
          WHERE handle_hash=$1 AND status='processing' AND expires_at>clock_timestamp()`, [transactionHash]);
        if (!completed.rowCount) throw new Error("Login transaction is unavailable");
        // Treat this final guarded update as the issuance authorization point:
        // all relevant rows are locked, and rollback removes the new session
        // if any authority expired during the preceding statements.
        const extended = await client.query(`UPDATE paypal_markets_auth.session_families f
          SET expires_at=GREATEST(expires_at,clock_timestamp()+interval '35 minutes')
          WHERE f.family_hash=$1 AND f.context_hash=$2 AND f.generation=$3 AND f.expires_at>clock_timestamp()
            AND EXISTS (
              SELECT 1 FROM paypal_markets_auth.login_transactions t
              WHERE t.handle_hash=$4 AND t.context_hash=$2 AND t.family_hash=$1
                AND t.family_generation=$3 AND t.status='completed'
                AND t.initial_session_hash IS NOT DISTINCT FROM $5::text AND t.expires_at>clock_timestamp()
            )
            AND ($5::text IS NULL OR EXISTS (
              SELECT 1 FROM paypal_markets_auth.sessions s
              WHERE s.handle_hash=$5 AND s.context_hash=$2 AND s.family_hash=$1
                AND s.family_generation=$3 AND s.revoked=true AND s.expires_at>clock_timestamp()
            ))`, [family.family_hash, contextHash, family.generation, transactionHash, previousHash]);
        if (!extended.rowCount) throw new Error("Login family is unavailable");
      });
    },
    async readSession(handleHash, contextHash) {
      const result = await pool.query<{ account_type: AccountType; data_scope: string }>(`
        SELECT s.account_type, s.data_scope FROM paypal_markets_auth.sessions s
        JOIN paypal_markets_auth.session_families f ON f.family_hash=s.family_hash
        WHERE s.handle_hash=$1 AND s.context_hash=$2 AND f.context_hash=$2 AND s.revoked=false
          AND s.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp() AND s.family_generation=f.generation
      `, [handleHash, contextHash]);
      const row = result.rows[0];
      if (!row) return null;
      if (!["personal", "business", "unknown"].includes(row.account_type) || !/^v1_[A-Za-z0-9_-]{43}$/.test(row.data_scope)) {
        throw new Error("Stored session is invalid");
      }
      return { accountType: row.account_type, dataScope: row.data_scope };
    },
    async logout(sessionHash, transactionHash) {
      await transaction(async (client) => {
        // Look up tombstones too: a delayed logout must still invalidate a rotated successor.
        const result = await client.query<{ family_hash: string }>(`
          SELECT family_hash FROM paypal_markets_auth.sessions WHERE handle_hash=$1
          UNION SELECT family_hash FROM paypal_markets_auth.login_transactions WHERE handle_hash=$2
        `, [sessionHash, transactionHash]);
        const families = [...new Set(result.rows.map((row) => row.family_hash))].sort();
        if (!families.length) return;
        await client.query(`SELECT family_hash FROM paypal_markets_auth.session_families
          WHERE family_hash=ANY($1::text[]) ORDER BY family_hash FOR UPDATE`, [families]);
        await client.query(`UPDATE paypal_markets_auth.session_families SET generation=generation+1 WHERE family_hash=ANY($1::text[])`, [families]);
        await client.query(`UPDATE paypal_markets_auth.sessions SET revoked=true WHERE family_hash=ANY($1::text[])`, [families]);
        await client.query(`UPDATE paypal_markets_auth.login_transactions SET status='completed', state=NULL, nonce=NULL, verifier=NULL
          WHERE family_hash=ANY($1::text[]) AND status!='completed'`, [families]);
      });
    },
    async close() { await pool.end(); },
  };
}
