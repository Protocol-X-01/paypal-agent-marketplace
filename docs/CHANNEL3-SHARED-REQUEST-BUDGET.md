# Channel3 shared request budget

Production Channel3 requests use a durable, deployment-wide counter before the provider request is made. Search, catalog browse, similar-product lookup, and exact-product refresh each reserve one request. A paginated continuation reserves again. Timeouts and provider errors still use the reservation because the request may have reached Channel3.

The store reserves a global fixed minute window and a UTC-day window in one PostgreSQL transaction. Both reset on UTC epoch-aligned boundaries; they are not rolling windows. A full limit can be consumed just before a boundary and another full limit just after it, allowing nearly twice the configured quota inside a rolling minute or 24-hour period. Before production quotas are set, verify that Channel3 uses compatible reset semantics. If its actual allowance is rolling or otherwise differs, use a verified conservative cap that accounts for this boundary burst, or change the implementation to match the confirmed provider window. Do not enable production calls until that match or conservative cap is established.

The transaction locks the day row and then the minute row in the same order, reads `clock_timestamp()` after both locks, validates the configured quotas and stored counters, then increments both or neither. A denial updates neither counter. Missing or null quota, missing migration/row, invalid state, timeout, or database error fails closed with HTTP 503. Exhaustion returns HTTP 429 and `Retry-After`; the delay reflects the latest reset among exhausted windows. The per-IP in-memory limiter remains as a local fairness backstop, but it is not the shared budget.

This counter covers the app's Channel3 API requests only. Product image/CDN downloads and requests made after opening a retailer page are outside the counter and any quota configured here.

## Provider allowance is an operator decision

The migration intentionally creates the `day` and `minute` quota rows with `request_limit = NULL`. Production Channel3 calls stay unavailable until an operator verifies the current account plan, provider allowance, and cost terms, then explicitly sets both values in one administrator transaction. The application has no guessed default or environment-variable override. Reduce a live limit only after reviewing the current counters; if usage is already above the new limit, requests remain denied until the affected window resets.

The public [Channel3 Publisher Terms](https://trychannel3.com/terms/publishers) require compliance with applicable rate and call-volume limits and describe usage-based fees. The public [developer page](https://trychannel3.com/developers) does not publish an account-specific numerical request allowance. Do not infer one from the existing per-IP limit or from example requests.

## Database and runtime setup

This can use the existing dedicated Render PostgreSQL instance; it does not require a new paid database. The schema contains only two aggregate counters and two administrator-set quota rows, with no customer identifiers, addresses, search terms, or product data.

1. A database administrator applies [the forward-only migration](channel3-request-budget-migration.sql) through the separately reviewed migration workflow. It creates separate non-login owner/runtime roles, a Channel3 schema, two fixed counter rows, two initially unconfigured quota rows, and a narrowly scoped `SECURITY DEFINER` reservation function. The migration is not automatic and is not part of application startup.
2. After checking the Channel3 account allowance, the administrator sets positive integer limits for both periods in one transaction. Leave either row `NULL` until its value has been reviewed; production stays fail-closed.
3. The operator provisions the dedicated role's login credential outside source control and adds `CHANNEL3_BUDGET_DATABASE_URL` to Render. It must use verified TLS and a PostgreSQL URL without query parameters or fragments. Never store the value in `.env.example`, a Postman collection, logs, or a checked-in environment file.
4. The runtime role receives only schema usage and `EXECUTE` on `reserve_request()`. It cannot read or directly update quota/counter tables, reset counters, create/delete rows, alter quotas, or access customer-auth schemas. The function owner is a separate `NOLOGIN`, non-superuser role with a fixed `search_path`; its table references are schema-qualified, and `PUBLIC` execution is revoked. PostgreSQL retains `ADMIN OPTION` on the owner role for the migration administrator that creates it; that administrator can grant itself owner-role membership and change the budget objects, so it remains a trusted privileged database account. The app runtime role has no owner-role membership. The operator credential remains separate from both runtime roles.
5. Deploy the API change only after the approved database configuration is ready, then verify status handling and quota enforcement against the exact deployed commit. A missing setting or migration intentionally makes the Channel3 routes return 503 rather than calling the provider.

`render.yaml` declares the database URL with `sync: false`; an existing Render service requires a separately reviewed manual setting change. This repository change does not apply the SQL, create a role/credential, set quota values, connect Render, or deploy.

## Test and extension boundary

The isolated PostgreSQL test exercises multiple independent pools, atomic minute/day admission, denial without partial consumption, UTC window expiry, inability to alter quota/counter rows or access the auth schema, missing/unconfigured data, invalid window state, lock/database failures, and pool recovery. It does not call Channel3 or establish the live account allowance or hosted configuration.

This implementation is Channel3-specific. A later OpenAI explanation budget can reuse the transaction pattern, but it needs an independent provider quota, configuration, counter scope, and least-privilege decision. Do not charge OpenAI requests against the Channel3 allowance.
