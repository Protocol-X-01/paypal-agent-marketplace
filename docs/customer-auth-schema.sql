-- Apply explicitly to a dedicated PostgreSQL database before enabling
-- customer web sign-in. No migration runs automatically in the application.
CREATE SCHEMA IF NOT EXISTS paypal_markets_auth;

CREATE TABLE IF NOT EXISTS paypal_markets_auth.session_families (
  family_hash text PRIMARY KEY CHECK (family_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS session_families_expiry_idx
  ON paypal_markets_auth.session_families (expires_at);

CREATE TABLE IF NOT EXISTS paypal_markets_auth.login_transactions (
  handle_hash text PRIMARY KEY CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  family_hash text NOT NULL REFERENCES paypal_markets_auth.session_families (family_hash) ON DELETE CASCADE,
  family_generation integer NOT NULL CHECK (family_generation >= 0),
  initial_session_hash text CHECK (initial_session_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
  state text,
  nonce text,
  verifier text,
  expires_at timestamptz NOT NULL,
  CHECK ((status = 'completed' AND state IS NULL AND nonce IS NULL AND verifier IS NULL) OR
         (status IN ('pending', 'processing') AND state IS NOT NULL AND nonce IS NOT NULL AND verifier IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS login_transactions_expiry_idx
  ON paypal_markets_auth.login_transactions (expires_at);

CREATE TABLE IF NOT EXISTS paypal_markets_auth.sessions (
  handle_hash text PRIMARY KEY CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  family_hash text NOT NULL REFERENCES paypal_markets_auth.session_families (family_hash) ON DELETE CASCADE,
  family_generation integer NOT NULL CHECK (family_generation >= 0),
  revoked boolean NOT NULL DEFAULT false,
  account_type text NOT NULL CHECK (account_type IN ('personal', 'business', 'unknown')),
  data_scope text NOT NULL CHECK (data_scope ~ '^v1_[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx
  ON paypal_markets_auth.sessions (expires_at);
