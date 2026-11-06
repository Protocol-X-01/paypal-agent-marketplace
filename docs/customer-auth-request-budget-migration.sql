-- Forward-only explicit migration. Never run automatically; NOT applied to hosted DB.
-- Requires reviewed migration owner, existing paypal_auth_runtime and empty new schema.
-- Fixed cardinality: runtime cannot INSERT/DELETE/TRUNCATE or create budget keys.
BEGIN;
CREATE SCHEMA paypal_markets_auth_budget;
CREATE TABLE paypal_markets_auth_budget.windows (
 operation text PRIMARY KEY CHECK(operation IN ('web.start','web.callback','web.session','native.availability','native.handoffs','native.authorizeGet','native.authorizePost','native.callback','native.exchange','native.session')),
 window_start_ms bigint NOT NULL DEFAULT 0 CHECK(window_start_ms>=0),
 used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 301)
);
INSERT INTO paypal_markets_auth_budget.windows(operation) VALUES
 ('web.start'),('web.callback'),('web.session'),
 ('native.availability'),('native.handoffs'),('native.authorizeGet'),('native.authorizePost'),
 ('native.callback'),('native.exchange'),('native.session');
REVOKE ALL ON SCHEMA paypal_markets_auth_budget FROM PUBLIC;
REVOKE ALL ON paypal_markets_auth_budget.windows FROM PUBLIC;
GRANT USAGE ON SCHEMA paypal_markets_auth_budget TO paypal_auth_runtime;
GRANT SELECT,UPDATE ON paypal_markets_auth_budget.windows TO paypal_auth_runtime;
COMMIT;
