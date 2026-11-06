-- Proposed native authentication storage. Apply explicitly only after review.
-- No application migration runs automatically. Separate from web cookie tables.
CREATE SCHEMA IF NOT EXISTS paypal_markets_native_auth;
CREATE TABLE IF NOT EXISTS paypal_markets_native_auth.families (
  family_hash text PRIMARY KEY CHECK (family_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  revoked boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_markets_native_auth.handoffs (
  handle_hash text PRIMARY KEY CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  family_hash text NOT NULL REFERENCES paypal_markets_native_auth.families(family_hash),
  family_generation integer NOT NULL CHECK (family_generation >= 0),
  initial_session_hash text CHECK (initial_session_hash ~ '^[0-9a-f]{64}$'),
  app_state text NOT NULL CHECK (app_state ~ '^[A-Za-z0-9_-]{43}$'),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  platform text NOT NULL CHECK (platform IN ('android','ios')),
  status text NOT NULL CHECK (status IN ('pending','claimed','processing','ready','exchanged','cancelled','superseded')),
  browser_hash text CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  provider_state text,
  provider_nonce text,
  provider_verifier text,
  reservation_hash text CHECK (reservation_hash ~ '^[0-9a-f]{64}$'),
  code_hash text UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  account_type text CHECK (account_type IN ('personal','business','unknown')),
  data_scope text CHECK (data_scope ~ '^v1_[A-Za-z0-9_-]{43}$'),
  issued boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  CHECK ((provider_state IS NULL AND provider_nonce IS NULL AND provider_verifier IS NULL) OR
         (provider_state IS NOT NULL AND provider_nonce IS NOT NULL AND provider_verifier IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS paypal_markets_native_auth.sessions (
  handle_hash text PRIMARY KEY CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  family_hash text NOT NULL REFERENCES paypal_markets_native_auth.families(family_hash),
  family_generation integer NOT NULL CHECK (family_generation >= 0),
  revoked boolean NOT NULL DEFAULT false,
  account_type text NOT NULL CHECK (account_type IN ('personal','business','unknown')),
  data_scope text NOT NULL CHECK (data_scope ~ '^v1_[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS native_families_expiry ON paypal_markets_native_auth.families(expires_at);
CREATE INDEX IF NOT EXISTS native_handoffs_family ON paypal_markets_native_auth.handoffs(family_hash);
CREATE INDEX IF NOT EXISTS native_sessions_family ON paypal_markets_native_auth.sessions(family_hash);
