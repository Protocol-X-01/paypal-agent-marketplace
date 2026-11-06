# Customer login setup — prepared 6 November 2026

This checklist describes the current code's prerequisites. Both login flags remain false. No database was provisioned or migrated, no provider-console setting was changed, and no real login occurred while preparing it. Existing PayPal REST/webhook credentials alone do not establish **Log in with PayPal** eligibility. This login does not authorize payments, merchant reports, wallet access or internal staff access.

## Inputs still requiring confirmation

- [ ] Intended first environment: sandbox testing, before any live activation.
- [ ] Exact HTTPS customer origin. Candidate: `https://paypal-markets-companion.onrender.com`, only after deploying the reviewed auth routes there. This is not a current-host readiness claim.
- [ ] Matching PayPal app has Log in with PayPal enabled and the required return URLs/scopes configured.
- [ ] Authorized PostgreSQL database/role and verified TLS trust. An existing suitable database or an eligible free option may be used; no paid plan is assumed or selected.
- [ ] Stable subject-HMAC secret stored through the approved secret/configuration channel, never in chat.
- [ ] Privacy-policy and user-agreement URLs, plus real provider approval before live use.
- [ ] Trusted edge rate/abuse controls and callback log redaction verified on the chosen host.
- [ ] For native: approved HTTPS return paths, signed application/domain associations and compatible device builds.

## PayPal console and scopes

In Developer Dashboard → **Apps & Credentials** → the matching app → **Other features** → **Log in with PayPal** → **Advanced Settings**, configure return URLs and minimum necessary user information. Supply privacy-policy and user-agreement URLs. Sandbox configuration does not require live app review; live activation and scopes require PayPal approval. Saving a live configuration can submit it for review, so treat that as a separate deliberate action. [Official integration guide](https://developer.paypal.com/log-in/build/), checked 6 November 2026.

Current code requests `openid` by default. With `PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES=true`, it requests exactly `openid https://uri.paypal.com/services/paypalattributes`. Confirm app eligibility and intended consent before enabling this optional scope. No email/profile/address scope is requested by this implementation. Unrecognized or missing account type stays `unknown`; login must not invent Business entitlement.

The implementation additionally requires compatible discovery metadata, signed ID tokens, nonce, S256 PKCE and matching userinfo subject. Synthetic tests do not prove this specific app/environment supplies those responses. Verify them through an approved sandbox flow before claiming working login; do not weaken validation to accommodate an unexpected response.

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
