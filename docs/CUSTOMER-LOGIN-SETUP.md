# Customer login setup — prepared 6 November 2026

This checklist describes the current code's prerequisites. Both login flags remain false. The dedicated Render database was created with user approval and verified available on 6 November 2026. The approved schema bootstrap and restricted runtime role passed hosted rollback validation. The runtime role subsequently received its approved login credential; the application connection and three settings are wired and verified on Render. The sandbox provider app and callbacks are configured; real sign-in validation remains unfinished. Existing PayPal REST/webhook credentials alone do not establish **Log in with PayPal** eligibility. This login does not authorize payments, merchant reports, wallet access or internal staff access.

## Inputs still requiring confirmation

- [x] First environment is the PayPal sandbox; live activation remains out of scope.
- [x] Exact HTTPS customer origin configured. Deployed candidate: `https://paypal-markets-companion.onrender.com`; website/API commit `ec25028c7651c59c199a5d58f53daf302a20d652` passed disabled-login checks. AUTH_PUBLIC_ORIGIN is now configured to that exact origin; deployment and storage readiness alone do not establish working PayPal sign-in.
- [x] In the existing sandbox Default Application, Log in with PayPal is enabled and the web and native provider callback URLs are saved; a previous return URL and other app features were retained. No optional customer attributes were added. The visible 21-character app client-ID prefix matched the local project credential; a separate in-process check confirmed the hosted and local client IDs match exactly. The local review branch now uses PayPal's documented manual OAuth flow; real consent-flow acceptance remains open.
- [x] Dedicated PostgreSQL database provisioned: `paypal-markets-auth-sandbox` (`dpg-dbn1ros9v7es73a0l4ug-a`), Frankfurt, PostgreSQL 18, 1 GB, approved `0.1c-256mb` paid plan. External access is restricted to `74.220.51.0/24` and `74.220.59.0/24`; no autoscaling or HA.
- [x] Separately approved schema bootstrap, restricted runtime role and observed Node TLS chain/hostname verification completed on Render. The role began as NOLOGIN and was subsequently enabled during the approved connection phase. Rollback-only validation passed; all six tables are empty.
- [x] Separately approved runtime credential provisioning, strict TLS authentication, both actual session-store readiness checks and three-setting application configuration completed. Existing source ec25028 was redeployed as dep-dbn2c0jncjis73dvagug and verified live. Application login remains disabled.
- [x] Stable subject-HMAC secret generated once and stored on the existing Render service through the approved configuration channel; never emitted in chat. The temporary recovery copy was removed after verification.
- [ ] Privacy-policy and user-agreement URLs, plus real provider approval before live use.
- [ ] Trusted edge rate/abuse controls and callback log redaction verified on the chosen host.
- [ ] For native: approved HTTPS return paths, signed application/domain associations and compatible device builds.

## PayPal console and scopes

In Developer Dashboard → **Apps & Credentials** → the matching app → **Other features** → **Log in with PayPal** → **Advanced Settings**, configure return URLs and minimum necessary user information. Supply privacy-policy and user-agreement URLs. Sandbox configuration does not require live app review; live activation and scopes require PayPal approval. Saving a live configuration can submit it for review, so treat that as a separate deliberate action. [Official integration guide](https://developer.paypal.com/log-in/build/), checked 6 November 2026.

Current code requests `openid` by default. With `PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES=true`, it requests exactly `openid https://uri.paypal.com/services/paypalattributes`. Confirm app eligibility and intended consent before enabling this optional scope. No email/profile/address scope is requested by this implementation. Unrecognized or missing account type stays `unknown`; login must not invent Business entitlement.

The local runtime now follows PayPal's documented authorization-code and user-info contract. Synthetic tests do not prove this specific app/environment accepts consent, returns the expected `openid` grant, or supplies a valid `sub` and `account_type`. Verify those claims through an approved sandbox flow before claiming working login; do not infer Business access when the account type is absent or unrecognized.

## Server configuration

| Variable | Required value/constraint |
| --- | --- |
| `PAYPAL_LOGIN_ENABLED` | Keep `false` until prerequisites pass; exactly `true` enables web auth. |
| `PAYPAL_ENV` | Explicit `sandbox` or `live`, matching app credentials. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Matching login-enabled app; secret server-side only. |
| `AUTH_PUBLIC_ORIGIN` | Canonical HTTPS origin, no trailing slash/path/query. |
| `AUTH_SESSION_DATABASE_URL` | `postgres:` or `postgresql:` URL with host, username and database path; no query string or fragment. |
| `AUTH_SUBJECT_HMAC_KEY` | Cryptographically random 32–64 bytes, canonical unpadded base64url; stable across restarts. |
| `PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES` | Optional `true`/`false`; default off. |

Register the exact web callback: `{AUTH_PUBLIC_ORIGIN}/api/auth/paypal/callback`. For the candidate Render origin this is `https://paypal-markets-companion.onrender.com/api/auth/paypal/callback`. Native uses a **separate provider callback**: `{AUTH_PUBLIC_ORIGIN}/api/auth/native/paypal/callback`. Neither callback is the PayPal webhook URL.

Both stores enforce `ssl: { rejectUnauthorized: true }`; the server must trust the database certificate chain. URL SSL options are rejected rather than allowing connection-string overrides. Never disable verification as a setup workaround. Apply [web schema](customer-auth-schema.sql), and [native schema](customer-native-auth-schema.sql) if enabling native, through a separately authorized database-admin workflow. Runtime roles need schema usage and table SELECT/INSERT/UPDATE/DELETE; the app does not auto-migrate. Keep these schemas separate from the legacy marketplace SQLite store and from Operations. Plan bounded cleanup/backups without deleting retained aliases while their family can still authorize descendants.

## Additional native configuration

Server flags `PAYPAL_NATIVE_LOGIN_ENABLED`, `PAYPAL_NATIVE_LINKS_VERIFIED`, and `PAYPAL_NATIVE_EDGE_CONTROLS_VERIFIED` must all equal `true`, and valid web auth configuration is also required. Supply `AUTH_NATIVE_ANDROID_RETURN_URL` and `AUTH_NATIVE_IOS_RETURN_URL`: fixed canonical HTTPS URLs on the same exact origin, with reviewed non-root paths and no query/fragment. These are app-return links, distinct from both provider callbacks. No path is chosen by this checklist.

The signed Expo build must contain matching public configuration:

- `EXPO_PUBLIC_CUSTOMER_LOGIN_ENABLED=true`
- `EXPO_PUBLIC_CUSTOMER_LINKS_VERIFIED=true`
- `EXPO_PUBLIC_CUSTOMER_AUTH_ORIGIN`
- `EXPO_PUBLIC_CUSTOMER_ANDROID_RETURN_URL`
- `EXPO_PUBLIC_CUSTOMER_IOS_RETURN_URL`

These values contain no secret. Verify Android app links and iOS Associated Domains using the actual signed app identity. The browser adapter requires iOS 17.4+ for HTTPS universal-link authentication and does not fall back to a custom scheme. A configuration acknowledgement is not proof of a deployed association. Build configuration changes do not update the installed phone automatically.

## Acceptance before enabling for customers

Use fictional sandbox personal/business test accounts to verify consent, account-type claims, exact callbacks, guest-data separation, logout/rotation, expiry recovery and cancellation. Confirm HTTPS cookies, effective headers and redaction across host/proxy logs. Verify durable database behavior and shared abuse controls. Then test signed native builds, SecureStore and foreground/background/browser-return behavior separately.

Relevant source: `src/lib/customer-auth/{config,provider,native-config,native-runtime}.ts`, `apps/mobile/src/lib/customer-session-config.ts`, and the [web](CUSTOMER-WEB-AUTH.md)/[native](CUSTOMER-NATIVE-AUTH.md) design documents. The [deployment candidate](DEPLOYMENT-CANDIDATE-20261106.md) intentionally keeps login disabled until these gates are complete.

## Provider compatibility checkpoint — 6 November 2026

An anonymous request to the exact configured sandbox discovery URL `https://www.sandbox.paypal.com/.well-known/openid-configuration` returned HTTP503/non-JSON during this pass. This does not prove permanent incompatibility or app entitlement. Public PayPal integration documentation describes authorization-code exchange and userinfo, but does not explicitly establish the current implementation's required S256 discovery metadata or signed-ID-token/nonce behavior. The button guide restriction on authorization response_type=id_token does not establish whether a code exchange returns an ID token; the app uses response_type=code.

Keep login disabled and existing validation intact until discovery succeeds and an approved configured sandbox consent flow establishes the actual token, nonce, PKCE and subject behavior. Account type remains unknown unless the provider explicitly returns the recognized attribute under granted scopes. No customer login or provider-console change was attempted. Evidence: `/home/protocol-x/Downloads/paypal-runtime-connection-review-20261106/paypal-public-discovery.json`; official references: https://developer.paypal.com/log-in/build/ , https://developer.paypal.com/log-in/build-button/ , https://developer.paypal.com/api/identity/v1/schema.json .

## Provider discovery recheck — 6 November 2026

The actual `discoverProvider` source accepted PayPal’s public live discovery metadata in a read-only check using fictional client configuration; it advertised the required issuer, S256 and RS256. No authorization, token or userinfo request was made. The configured sandbox discovery still failed; an earlier direct anonymous request returned HTTP503 and a separate candidate API-host request returned403. Neither result establishes a permanent provider incompatibility or proves this app’s entitlement. Do not substitute live metadata for sandbox metadata or relax validation. Evidence: `/home/protocol-x/Downloads/paypal-runtime-connection-review-20261106/discovery-source-check.json`; live metadata: https://www.paypal.com/.well-known/openid-configuration . The Developer Dashboard currently requires user sign-in before its sandbox app settings can be inspected.

## Approved sandbox app configuration — 6 November 2026

After the user signed in and explicitly approved the change, the matching sandbox Default Application was configured with Log in with PayPal enabled and both fixed provider callbacks: `https://paypal-markets-companion.onrender.com/api/auth/paypal/callback` and `https://paypal-markets-companion.onrender.com/api/auth/native/paypal/callback`. PayPal displayed a successful save. A reload confirmed the enabled feature, both callbacks, the retained pre-existing callback and no added optional identity attributes. No privacy/agreement placeholders were needed to save; those fields remain an independent live-launch requirement. The Developer Dashboard indicates changes may take up to three hours to take effect.

No unrelated feature settings were saved. The first attempted UI selection unexpectedly changed two unrelated draft checkboxes; the form was reloaded before saving and their original values verified. The subsequent selection, save and reload were checked against the original feature states. A screenshot is in `/home/protocol-x/Downloads/paypal-runtime-connection-review-20261106/paypal-sandbox-callbacks-verified.png`; values were independently verified in the accessible page state. No credentials are recorded in evidence.

After setup an anonymous request to sandbox discovery still returned HTTP503; evidence `/home/protocol-x/Downloads/paypal-runtime-connection-review-20261106/sandbox-discovery-after-setup.json`. Deployed `/api/auth/session` and `/api/auth/native/availability` both reported loginAvailable false; evidence `hosted-disabled-after-paypal-setup.json`. The checkbox and callbacks do not establish working sign-in, edge redaction, account consent or native links; the app’s web/mobile login switches remain off.

## Hosted hardening rollout — 6 November 2026

On 6 November 2026 at 20:33 UTC, the user-approved auth request-budget migration and website release completed. Dedicated Render PostgreSQL now contains the ten fixed operation counters with restricted runtime access; the exact migration, rollback-only verification and unchanged original auth-table counts passed. Private GitHub main and the public Render demo run commit `2d4336d047fbec586e8072a75ad2f6c6ce579e59`, deployment `dep-dbn3i10473hc738u9710`. Seven hosted checks passed, the repository remains private, and all 18 direct service settings matched pre-release fingerprints; web/native customer login remains disabled and web admission acknowledgements remain closed. The public market dashboard visibly shows CoinGecko’s asset-update time separately from retrieval time. Evidence: `/home/protocol-x/Downloads/paypal-v3-local-release-review-fx_jfifw/RELEASE-RESULT.md` and `/home/protocol-x/Downloads/paypal-auth-budget-migration-review-d7k3mlq1/execution-state.json`. These checks do not establish provider consent, real login, edge redaction or native-device acceptance.

## Disabled callback and log-coverage check — 6 November 2026

A single fictional request to the disabled hosted web callback at 20:37 UTC returned the fixed relative failure redirect with HTTP 303, no cookie, `no-store` and `no-referrer`. Two narrowly scoped Render request-log queries spanning the request returned no entries. This confirms the observed response behavior only: it does **not** establish that HTTP request logs were available or that callback query values are redacted at the edge or in other logs. Confirm log availability, all relevant destinations and actual redaction before acknowledging that prerequisite or enabling login. The native callback was not exercised in this check. Evidence: `/home/protocol-x/Downloads/paypal-callback-canary-zcFDfY/request.json` and `/home/protocol-x/Downloads/paypal-callback-canary-zcFDfY/log-coverage.json`.

## Sandbox provider discovery follow-up — 6 November 2026

At 20:48 UTC, one anonymous request to the configured sandbox discovery URL still returned HTTP 503. PayPal's public [integration guide](https://developer.paypal.com/log-in/build/) describes a sandbox authorization-code and userinfo flow, but does not by itself establish this implementation's exact discovery URL, issuer, S256 PKCE, and signed ID-token/nonce requirements. This is not proof of permanent incompatibility. Keep both login switches off and the existing validation intact until PayPal confirms the supported sandbox metadata and a properly authorized consent flow verifies the actual behavior.

## Local provider deadline hardening — 6 November 2026

A later anonymous, credential-free request to the same sandbox discovery URL again returned HTTP 503. Postman Orbit search for public login metadata returned HTTP 403; it did not supply integration guidance. The official PayPal documentation remains the reference for the documented authorization-code flow. Neither result establishes a permanent service failure or proves this app's eligibility.

The local provider adapter now applies its existing five-second request deadline to both the transport and response-body reading. Oversized responses, stalled reads and cancellation failures return without waiting indefinitely; a transport resolving after cancellation has its body canceled best-effort. Host/path restrictions, the 1 MiB body cap, PKCE/nonce/signature checks and disabled-by-default switches remain intact. Forty-nine synthetic auth tests and a source-matched Postman loopback simulation passed. The simulation used fictional metadata and observed valid discovery, an oversized response and a response stopped after approximately five seconds: `/home/protocol-x/Downloads/paypal-auth-provider-simulation-final-wiyo3opp/README.md`. It does not establish real provider TLS, consent or customer sign-in and is not deployed.

## Sandbox discovery recheck — 7 November 2026

At 02:53 UTC, an anonymous, credential-free GET to the configured sandbox discovery URL returned HTTP 503 with a JSON content type. A second anonymous diagnostic at 02:54 UTC also returned 503 and included a `Via` header; these checks cannot determine whether PayPal or an intermediary generated the response. No response body was recorded. The checks did not authorize a user, exchange a token, or change any PayPal or application setting. They do not establish permanent incompatibility or whether this account is eligible. Keep the login gates disabled until discovery and the other acceptance prerequisites above are verified. Sanitized evidence: `/home/protocol-x/Downloads/paypal-sandbox-discovery-recheck-ed4453uw/result.json` and `/home/protocol-x/Downloads/paypal-sandbox-discovery-origin-zg02_7lt/result.json`.

## PayPal login contract correction — 9 November 2026 (initial finding; superseded below)

The current [PayPal integration guide](https://developer.paypal.com/log-in/build/) (last updated 14 October 2026) documents a manual authorization-code flow: send the customer to `https://www.sandbox.paypal.com/connect` with `response_type=code`, `scope=openid`, the registered callback and `state`; exchange the code at `https://api-m.sandbox.paypal.com/v1/oauth2/token` using client Basic authentication and `grant_type=authorization_code`; then call `https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid` with the returned Bearer access token. The guide describes access/refresh tokens and a nonce response field, and its required steps do not specify discovery metadata, S256 PKCE, or an RS256 ID token. The official [Identity API response schema](https://developer.paypal.com/api/identity/v1/userinfo-get) includes `sub` and `account_type` claims.

At this checkpoint, the source at `0553e99` required a discovery document, S256 metadata, an ID token, and strict OIDC token validation, so it did not implement the published PayPal flow. An anonymous GET to the configured sandbox discovery URL returned HTTP 503 in this pass; unauthenticated GETs to the token and user-info routes returned HTTP 401 and 400 respectively. These responses showed only endpoint behavior without credentials and did not establish account eligibility, successful authorization, or consent. No authorization request, sandbox buyer consent, authorization-code exchange, user-info request with a user token, or PayPal/Render configuration change was made. The initial finding was superseded by the local adapter update below.

Orbit search found the PayPal OpenID Connect user-info resource `urn:orbit:endpoint:v1:aGr31FUGF2q0HFdAsdnYauxxWnGNE7aX:paypal:get-openid-connect-user`; its integration brief was only a partial fit because it did not cover authorization-code exchange. The Postman CLI reported a temporary unauthenticated session, so no Postman workspace resource was inspected. These are discovery coverage limits; the official PayPal guide remains the primary contract source.

At that stage, both customer-login switches remained disabled and the next code change was to adapt the server-side flow while preserving one-time server-side state, exact registered callbacks, trusted-host/path and response-size/deadline controls, and no token persistence or logging. The local implementation and remaining acceptance gates are recorded below. Do not infer a Business entitlement when `account_type` is missing or unrecognized.

## Local adapter update — 9 November 2026

The isolated review branch now has a PayPal-specific runtime adapter for both web and native authorization. It constructs fixed environment-specific `/connect`, `/v1/oauth2/token`, and `/v1/identity/openidconnect/userinfo` URLs; sends the registered callback, `openid` scope and one-time state; performs a server-side Basic-authenticated authorization-code exchange bound to that same callback; and fetches the profile using the returned Bearer token and `schema=openid`. The subject must be a bounded `sub`; missing or unrecognized `account_type` remains `unknown`. Access and refresh tokens are used only in the in-flight exchange and are not persisted or logged. Trusted PayPal hosts, fixed paths, five-second request/body deadlines, response size caps, no redirects, one-time state, and fixed callbacks remain enforced. Existing transaction storage fields are retained for the already provisioned schema, but their compatibility values are not sent to PayPal.

`next typegen`, TypeScript `--noEmit`, and targeted ESLint on the changed auth modules passed. Tests, a production build, a browser consent flow, a signed native flow, and deployment were not run. Both login switches remain off. The prior OIDC discovery helper remains only for existing synthetic OIDC fixture compatibility; the web and native production runtimes use the PayPal-specific adapter. Next, verify the documented code exchange and user-info response with a fictional sandbox buyer, then separately complete native handoff acceptance before considering login activation.
