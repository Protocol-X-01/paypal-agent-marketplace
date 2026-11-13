-- Forward-only migration. Apply through a reviewed database-admin workflow.
-- Quotas remain NULL until an operator reviews and configures the app-owned limits.
BEGIN;
CREATE ROLE paypal_channel3_budget_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE paypal_channel3_budget_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- The hosting database may revoke CONNECT from PUBLIC. Give the runtime role
-- only the ability to open a database session: no TEMP or CREATE privilege.
DO $connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO paypal_channel3_budget_runtime', current_database());
END
$connect$;

-- Temporarily grant SET membership so the owned objects and SECURITY DEFINER
-- function belong to a non-login, non-superuser role. PostgreSQL may retain the
-- CREATEROLE creator's ADMIN OPTION; keep the migration operator trusted.
GRANT paypal_channel3_budget_owner TO CURRENT_USER;
DO $grant$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO paypal_channel3_budget_owner', current_database());
END
$grant$;
SET ROLE paypal_channel3_budget_owner;
CREATE SCHEMA paypal_markets_channel3_budget;

CREATE TABLE paypal_markets_channel3_budget.limits (
  period text PRIMARY KEY CHECK (period IN ('second', 'minute', 'day')),
  request_limit integer CHECK (request_limit IS NULL OR request_limit BETWEEN 1 AND 2147483647)
);
CREATE TABLE paypal_markets_channel3_budget.counters (
  period text PRIMARY KEY CHECK (period IN ('second', 'minute', 'day')),
  window_start_ms bigint NOT NULL DEFAULT 0 CHECK (window_start_ms >= 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);
INSERT INTO paypal_markets_channel3_budget.limits (period, request_limit) VALUES
  ('second', NULL), ('minute', NULL), ('day', NULL);
INSERT INTO paypal_markets_channel3_budget.counters (period) VALUES
  ('second'), ('minute'), ('day');

CREATE FUNCTION paypal_markets_channel3_budget.reserve_request()
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, paypal_markets_channel3_budget
AS $reserve$
DECLARE
  v_day_start bigint;
  v_day_used integer;
  v_minute_start bigint;
  v_minute_used integer;
  v_second_start bigint;
  v_second_used integer;
  v_day_limit integer;
  v_minute_limit integer;
  v_second_limit integer;
  v_now_ms bigint;
  v_day_window_start bigint;
  v_minute_window_start bigint;
  v_second_window_start bigint;
  v_day_window_end bigint;
  v_minute_window_end bigint;
  v_second_window_end bigint;
  v_retry_after integer;
BEGIN
  -- All callers lock UTC-day, minute, then second rows in this fixed order.
  SELECT window_start_ms, used INTO v_day_start, v_day_used
    FROM paypal_markets_channel3_budget.counters WHERE period = 'day' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget day counter is missing'; END IF;
  SELECT window_start_ms, used INTO v_minute_start, v_minute_used
    FROM paypal_markets_channel3_budget.counters WHERE period = 'minute' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget minute counter is missing'; END IF;
  SELECT window_start_ms, used INTO v_second_start, v_second_used
    FROM paypal_markets_channel3_budget.counters WHERE period = 'second' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget second counter is missing'; END IF;

  SELECT request_limit INTO v_day_limit
    FROM paypal_markets_channel3_budget.limits WHERE period = 'day';
  IF NOT FOUND OR v_day_limit IS NULL OR v_day_limit < 1 THEN
    RAISE EXCEPTION 'Channel3 budget day limit is not configured';
  END IF;
  SELECT request_limit INTO v_minute_limit
    FROM paypal_markets_channel3_budget.limits WHERE period = 'minute';
  IF NOT FOUND OR v_minute_limit IS NULL OR v_minute_limit < 1 THEN
    RAISE EXCEPTION 'Channel3 budget minute limit is not configured';
  END IF;
  SELECT request_limit INTO v_second_limit
    FROM paypal_markets_channel3_budget.limits WHERE period = 'second';
  IF NOT FOUND OR v_second_limit IS NULL OR v_second_limit < 1 THEN
    RAISE EXCEPTION 'Channel3 budget second limit is not configured';
  END IF;

  -- Read database time only after all potentially contended counter locks.
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint INTO v_now_ms;
  v_day_window_start := floor(v_now_ms::numeric / 86400000)::bigint * 86400000;
  v_minute_window_start := floor(v_now_ms::numeric / 60000)::bigint * 60000;
  v_second_window_start := floor(v_now_ms::numeric / 1000)::bigint * 1000;
  v_day_window_end := v_day_window_start + 86400000;
  v_minute_window_end := v_minute_window_start + 60000;
  v_second_window_end := v_second_window_start + 1000;

  -- A backwards clock, future/misaligned window, or invalid zero sentinel fails closed.
  IF v_day_start > v_day_window_start OR
     (v_day_start <> 0 AND mod(v_day_start, 86400000) <> 0) OR
     (v_day_start = 0 AND v_day_used <> 0) OR
     v_minute_start > v_minute_window_start OR
     (v_minute_start <> 0 AND mod(v_minute_start, 60000) <> 0) OR
     (v_minute_start = 0 AND v_minute_used <> 0) OR
     v_second_start > v_second_window_start OR
     (v_second_start <> 0 AND mod(v_second_start, 1000) <> 0) OR
     (v_second_start = 0 AND v_second_used <> 0) THEN
    RAISE EXCEPTION 'Channel3 budget counter state is invalid';
  END IF;

  IF v_day_start < v_day_window_start THEN v_day_used := 0; END IF;
  IF v_minute_start < v_minute_window_start THEN v_minute_used := 0; END IF;
  IF v_second_start < v_second_window_start THEN v_second_used := 0; END IF;

  IF v_day_used >= v_day_limit OR
     v_minute_used >= v_minute_limit OR
     v_second_used >= v_second_limit THEN
    v_retry_after := greatest(1, least(86400, ceil(
      (greatest(
        CASE WHEN v_day_used >= v_day_limit THEN v_day_window_end ELSE v_now_ms END,
        CASE WHEN v_minute_used >= v_minute_limit THEN v_minute_window_end ELSE v_now_ms END,
        CASE WHEN v_second_used >= v_second_limit THEN v_second_window_end ELSE v_now_ms END
      ) - v_now_ms)::numeric / 1000
    )::integer));
    RETURN QUERY SELECT false, v_retry_after;
    RETURN;
  END IF;

  UPDATE paypal_markets_channel3_budget.counters
    SET window_start_ms = v_day_window_start, used = v_day_used + 1
    WHERE period = 'day';
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget day counter update failed'; END IF;
  UPDATE paypal_markets_channel3_budget.counters
    SET window_start_ms = v_minute_window_start, used = v_minute_used + 1
    WHERE period = 'minute';
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget minute counter update failed'; END IF;
  UPDATE paypal_markets_channel3_budget.counters
    SET window_start_ms = v_second_window_start, used = v_second_used + 1
    WHERE period = 'second';
  IF NOT FOUND THEN RAISE EXCEPTION 'Channel3 budget second counter update failed'; END IF;

  RETURN QUERY SELECT true, NULL::integer;
END
$reserve$;

REVOKE ALL ON SCHEMA paypal_markets_channel3_budget FROM PUBLIC;
REVOKE ALL ON paypal_markets_channel3_budget.limits FROM PUBLIC;
REVOKE ALL ON paypal_markets_channel3_budget.counters FROM PUBLIC;
REVOKE ALL ON FUNCTION paypal_markets_channel3_budget.reserve_request() FROM PUBLIC;
GRANT USAGE ON SCHEMA paypal_markets_channel3_budget TO paypal_channel3_budget_runtime;
GRANT EXECUTE ON FUNCTION paypal_markets_channel3_budget.reserve_request() TO paypal_channel3_budget_runtime;

RESET ROLE;
DO $revoke$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM paypal_channel3_budget_owner', current_database());
END
$revoke$;
REVOKE ADMIN OPTION FOR paypal_channel3_budget_owner FROM CURRENT_USER;
REVOKE paypal_channel3_budget_owner FROM CURRENT_USER;
COMMIT;
