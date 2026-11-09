# Customer web sign-in

This is a separate, opt-in server-side Log in with PayPal integration for the
customer website. The default is disabled. It does not connect the internal
management concept, implement the mobile handoff, enable payment actions, or
grant merchant reporting permissions. No provider credentials are sent to the
browser. The server does not persist PayPal access tokens, refresh tokens, raw
provider subjects, or user profiles.

The API contract is `postman/specs/customer-web-auth.yaml`. The generated local
collection defaults to an unreachable loopback port and contains only safe
negative checks; provide the URL of a deliberately isolated test service when
running it. Neither artifact is published to a workspace by this change.

## Configuration and prerequisites

Set these values through the deployment's approved secret/configuration
mechanism. Do not put secrets in client code, logs, screenshots, or source.
Nothing in this change edits an environment file or provisions a database.

| Variable | Purpose |
| --- | --- |
| `PAYPAL_LOGIN_ENABLED` | Exactly `true` enables the feature; otherwise it is disabled. |
| `PAYPAL_ENV` | Explicitly `sandbox` or `live`; there is no implicit environment fallback. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Credentials for the matching PayPal app, with Log in with PayPal enabled. The secret remains server-side. Existing webhook credentials do not by themselves establish login eligibility. |
| `AUTH_PUBLIC_ORIGIN` | Canonical HTTPS origin without a trailing slash or path. Register its exact `/api/auth/paypal/callback` URL with the PayPal app. |
| `AUTH_SESSION_DATABASE_URL` | Connection URL for a dedicated PostgreSQL database. A TLS connection with server-certificate verification is required; query-string connection options are rejected so they cannot weaken that setting. |
| `AUTH_SUBJECT_HMAC_KEY` | Stable, cryptographically random 32–64-byte secret encoded as unpadded base64url. Generate it with a trusted secret manager. Do not rotate it without a planned data-scope migration. |
| `PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES` | Optional `true` requests PayPal's account-attributes scope in addition to `openid`; default is off. Enable only when that scope and its intended use have been confirmed and consented. |

Provision an isolated database and explicitly apply `customer-auth-schema.sql`
using an authorized database administration workflow. The application never
runs the migration automatically or reuses the legacy marketplace SQLite
database. Its database role needs schema usage and `SELECT`, `INSERT`, `UPDATE`
and `DELETE` on all three auth tables. Configure PostgreSQL certificate trust
and scheduled cleanup of expired login transactions and expired session
families. Deleting a family cascades to its session aliases; do not delete an
alias while its family remains active. Application cleanup is deliberately
bounded and only occurs on new sign-ins. Backups and database access controls
must protect the short-lived login-transaction verifier and state values.

In PayPal Developer Dashboard, enable Log in with PayPal for the correct sandbox
app, select only the needed information, and register the exact callback. PayPal
requires a privacy-policy URL and user-agreement URL, and reviews live apps and
scopes before live activation. See the [PayPal integration guide](https://developer.paypal.com/log-in/build).
The local web and native runtimes now use PayPal's documented authorization-code
and user-info flow rather than relying on a discovery document or ID token.
This project's sandbox consent, token response and returned account-type claim
remain unverified. Keep login disabled until the complete sandbox flow and the
separate operational acceptance gates pass.

## Session and privacy model

The server creates a five-minute one-use login transaction and consumes its
state before exchanging the authorization code with the server-held client
secret. It then fetches OpenID user-info with the short-lived Bearer access
token and requires a bounded `sub`. PayPal's documented manual flow does not
specify PKCE or an ID token; the existing database nonce/verifier columns remain
for schema compatibility and are not sent to PayPal. Requests are restricted
to fixed PayPal hosts and paths, have five-second deadlines and bounded
responses, and fail on redirects. Access and refresh tokens are not persisted.
Browser cookies are host-only, Secure, HttpOnly and SameSite=Lax. The opaque
application session expires after 30 minutes, is stored only as a hash, and is
revoked on sign-out or rotated on a successful new sign-in. Login and sign-out
require an exact same-origin POST. A configured callback returns to the fixed
Account destination and does not put a code or token into its destination;
an unconfigured callback returns a fixed relative failure redirect.
Session reads check both the session and family against the advancing database
clock, including after waiting for a table lock.

Web and native callbacks share a 4 KiB response filter. It ignores unrecognized
extensions without forwarding or reflecting them, rejects duplicate recognized
parameters and unsupported hybrid/JARM/token fields, and keeps code and error
responses separate. A bounded `scope` is informational and discarded; a bounded
`iss`, when present, is checked against the configured PayPal environment.
Malformed responses fail before a web transaction is consumed. These local checks do not establish actual
PayPal sandbox metadata, consent, or successful customer sign-in.

The web store locks a pending transaction before checking its submitted state,
context and expiry. A late or incorrect state in the same unexpired context leaves
the attempt pending; matching states remain one-use. Once a matching claim commits,
the stored state, nonce and verifier have been logically replaced with empty
non-secret markers before the winning callback can begin provider work. Expired or
cross-context attempts are completed and their stored values cleared in the same
database transaction. This uses the existing schema; no migration is required.

The advancing-clock expiry check is repeated after the claim update to catch a
wait during that statement. Time can still pass during the later commit or its
acknowledgement; session issuance performs independent expiry checks. A claim
that commits but loses its acknowledgement has markers in the current row; one
that rolls back can remain pending with its original values. Pending attempts
and rows created by older running versions are not guaranteed to be scrubbed at
expiry without a reliable cleanup process. Logical updates do not erase older
PostgreSQL row versions, WAL or backups; retention and access remain separately
controlled.

Local validation on 7 November used isolated PostgreSQL owner and restricted
runtime-role fixtures, including duplicate claims, live and expired row-lock
waits, a delayed update and deferred commit failure. Evidence:
`/home/protocol-x/Downloads/paypal-claim-final-pg-rlb4u09r/metrics.json`.
The controller's acknowledgement-loss cases use a fictional in-memory store,
not an interrupted PostgreSQL network connection. No hosted database or real
provider was exercised by these checks.

Before issuing a session, the store also rechecks the pending transaction, its
session family, and any initiating session after the relevant locks have been
acquired, after the insert, and in the final guarded family update. An authority
that expires during those waits cannot create a new session. The final guarded
update is the authorization point; it cannot guarantee wall-clock validity at
the exact instant a later database commit completes.
When a browser starts another sign-in with an earlier transaction cookie and no
active session cookie, the earlier transaction must still be valid in this
context. An expired or unresolvable earlier transaction fails closed rather than
starting an unrelated family; the browser may need to wait for that short-lived
cookie to expire before retrying.

Bounded expiry cleanup rechecks each target's expiry after a row-lock wait, so
it does not delete a family that a concurrent transaction has extended. Cleanup
runs separately from the subsequent sign-in transaction and can commit even if
that sign-in later fails.

Login transactions and sessions are bound to a keyed fingerprint of the
canonical origin, selected environment and issuer, client ID and secret,
requested account-attributes setting, and subject HMAC key. Changing any of
these—including client-secret rotation—invalidates existing transactions and
sessions. Sign-out revokes the linked session family under a database lock;
rotated session aliases remain until that family expires, so an old sign-out
can still invalidate a later session. A callback does not clear the short-lived
transaction cookie, since a delayed response could otherwise erase a newer
sign-in cookie. Sign-out clears both cookies. Independently started guest flows
without a common established session or transaction cookie are separate
families; signing out one cannot cancel another unknown family.

The session response contains only `authenticated`, `loginAvailable`, and,
when signed in, `accountType` and `dataScope`. `loginAvailable` is a store and
metadata preflight, not proof that the provider has approved credentials,
scopes or consent. Missing or unfamiliar account types remain `unknown`.
PayPal's `PREMIER` type is also `unknown` until its meaning for this
application is established; it does not imply a Business entitlement.
`dataScope` is a stable, versioned HMAC of the verified subject and issuer,
bound to this app, environment and client ID. It is pseudonymous personal
data—not an anonymous value, authorization credential or automatic cross-device
sync. Changing the HMAC key or PayPal client can change the scope. Existing
shared guest holdings, contacts and reports must not silently be attributed to
the signed-in person; ownership/migration and local namespace handling are
separate work.

Application telemetry filters query strings, but deployment access logs,
reverse proxies and other instrumentation must also be configured and verified
to avoid retaining callback query strings, authorization codes, cookies and
tokens before enabling login. This repository does not control or verify every
external logging surface.

The customer dashboard and sign-in-start response allow form navigation only
to the application itself and the exact live and sandbox PayPal sign-in
origins. Authentication responses use `Referrer-Policy: no-referrer`. Verify
the effective headers and the redirect in the target browser and hosting
environment before enabling sign-in; local header checks do not prove a
successful PayPal authorization.

Before public enablement, put the login routes behind a verified trusted edge
with effective shared rate and abuse controls. Origin checking is a browser
CSRF defense, not proof of client identity: a non-browser caller can forge the
header and exhaust the transaction capacity or database connections. Shared
database quotas cap retained rows at 2,048 families, 4,096 transactions and
8,192 session aliases, including completed and revoked records. Capacity
exhaustion fails closed; bounded cleanup reclaims eligible rows on later
sign-in attempts. These quotas and per-process concurrency limits do not
provide rate limiting or prevent denial of service. This repository does not
provision or verify the required edge controls.

## Verification boundaries

Local tests use synthetic RSA-signed identity responses. An isolated,
socket-only PostgreSQL fixture is provided; check its execution result before
claiming the real store was tested. Neither can prove PayPal's actual response
or app approval. Before claiming a working integration, run the approved sandbox
flow with fictional personal and business test accounts, verify the exact
provider metadata and returned claims, and check browser cookies, sign-out,
expiry, account switching and the guest-data boundary. The native app requires
a separately reviewed, verified-link and one-use handoff design.

## Web-only new sign-in admission — local defense in depth

Both PAYPAL_WEB_EDGE_CONTROLS_VERIFIED and PAYPAL_WEB_CALLBACK_REDACTION_VERIFIED must be exactlytrue to admit new web start/callback operations. They defaultfalse in .env.example. They are operator acknowledgements, not automatic verification of edge protection, callback/access-log redaction, provider eligibility or consent. PAYPAL_LOGIN_ENABLED still controls the shared configured feature; these additional flags are intentionally outside readAuthConfig and the auth-context fingerprint. Native admission retains its independent existing gates.

When the web admission gate is closed, same-origin start returns503 before budget/store/provider work (foreign origin still403). Configured callbacks return the existing fixed clean303failure URL before budget or transaction consumption, without clearing cookies. Session reads still validate existing sessions but report loginAvailable:false and skip discovery. Logout remains unchanged. Closed admission does not revoke or invalidate existing sessions/families. Callback outer-concurrency redirection remains clean.

This is not an instantaneous distributed revocation switch: environment changes require deployment, older instances and already-running operations can finish, and checks around awaits are not atomic with database commits. It is defense in depth for new admission. Proxy/edge logging occurs before application redirects, so actual callback redaction must be independently verified. Existing frozen release candidates and hosted settings remain untouched by this local patch.

Local gate validation passed34tests across web controller/provider/native config, full root TypeScript and scoped zero-warning ESLint. Evidence: /home/protocol-x/Downloads/paypal-web-admission-check-jaz3i6ks. Web OpenAPI and four local collection request files linted clean; requests were not executed. Tests include pending callback rejection before consumption, exact missing/false flags, origin handling, existing session/logout continuity, no discovery while closed, and unchanged native/context behavior. No real provider/database/configuration/deployment action occurred.

Disabled/incomplete web callbacks now use303with fixed relative Location /dashboard?auth=failed#account, without request Host/origin interpolation, cookie clearing or backend/provider access. The configured case retains its existing trusted-origin redirect. This removes callback query data from subsequent navigation even without complete configuration; it cannot redact upstream logs. Disabled session responses are unchanged.

Disabled callback follow-on passed31web/native controller tests, root TypeScript and scoped zero-warning ESLint under resource guard. Both OpenAPI contracts and14local collection files linted clean; requests were not executed. Evidence: /home/protocol-x/Downloads/paypal-disabled-callback-check-2z5gjttt. Spoofed-host/secret-query tests confirm fixed relative destinations, empty bodies, privacy headers, no cookie clearing/backend calls and unchanged disabled session behavior. Existing frozen candidates remain untouched.
