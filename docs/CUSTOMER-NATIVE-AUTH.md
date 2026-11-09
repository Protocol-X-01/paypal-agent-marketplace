# Native customer sign-in — local server prototype, disabled by default

The local server prototype now has protocol/configuration helpers, a native PostgreSQL store, controller and route wrappers. Sign-in remains disabled by default; this is not a claim that the phone can sign in. The explicit SQL migration has only been applied inside an isolated test fixture, never to a real account database. Native session/UI wiring is now present locally; verified app-link configuration and device acceptance remain outstanding. SDK-compatible browser and cryptography dependencies are installed locally; this does not update an installed phone binary. The proposed OpenAPI contract is [customer-native-auth.yaml](../postman/specs/customer-native-auth.yaml); its server is intentionally unreachable. Do not generate a live collection against production or expose a working sign-in button until the implementation and prerequisites below are verified.

## Relationship to the existing web flow

Reuse verified PayPal discovery, authorization-code validation, nonce, S256 PKCE, signed ID-token checks, userinfo subject binding and identity mapping from `src/lib/customer-auth/provider.ts`. The existing `CustomerIdentity` is `{ accountType: personal | business | unknown, dataScope }`. Missing, unfamiliar and PREMIER remain unknown. A Business label chooses an initial screen; it grants no merchant reporting, payment, staff or wallet permissions.

Native app sessions are distinct from browser cookies and PayPal tokens. Do not weaken the web controller's exact same-origin POST requirement, read its HttpOnly cookie from the app, or add a client-controlled return URL. Use a separate native callback and cookie namespace. Reuse the stable subject HMAC derivation, so web and native can name the same verified owner locally, without implying cross-device data synchronization.

## Native expiry checks — local-only

Session reads, handoff transitions and code exchanges must use the advancing database clock after the shared store lock is acquired. When issuing or rotating an authority, lock and recheck the relevant family, handoff, code and initiating session after potentially blocking row or uniqueness waits. An expiry at the final authorization check fails generically and rolls back issuance, rotation and supersession. The check is a defined point before commit; it cannot guarantee the wall clock will not advance before commit finishes. Expired aliases and handoff proofs must still support the existing cancellation and logout recovery rules. Cleanup remains separately committed and may remove eligible expired records even if a later issuance attempt fails.

The isolated PostgreSQL fixture passed expiry and rollback cases, including a
wait after prior-session revocation, in `/home/protocol-x/Downloads/paypal-native-final-guard-pg-185gqtx8/`.
These results do not establish provider consent, a hosted rollout, or installed-device behavior.

## Native handoff retention — local-only

Each authorization POST now generates a separate random claim tag. While a
handoff is `claimed`, the tag's hash occupies the existing `reservation_hash` field;
provider reservation replaces it with a different reservation hash. If the
claim or redirect construction throws, the controller makes a best-effort abort
that matches the handoff, context, browser and claim tag. It cancels and clears
only that still-claimed, unissued row; it preserves its cancellation proof and
does not revoke a prior session. A competing POST with a different tag cannot
abort the winner, even if their provider values match. Cleanup failure leaves
the original generic response unchanged.

On a later handoff-creation attempt, separately committed maintenance passes
also looks for expired unissued claimed/processing handoffs and expired ready
codes in live, non-revoked families. It clears provider, browser, reservation,
code and account fields while retaining the row, challenge and family proof.
Issued aliases and live attempts are not swept by this pass. Each pass scans up
to 40 eligible candidates and changes at most 20, independently of the existing
expired-family deletion quota. The scrub commits before expired-family deletion
begins. A process-local cursor advances only after the scrub commits, with same-instance passes queued; row locks
are taken family first with `SKIP LOCKED`. Other processes have their own cursors.
Expired-family deletion separately scans up to 40 families and deletes at most
100 child or family rows per pass. It locks and rechecks each family first, skips
locked children, and deletes a family only after both child tables are empty.
Its separate cursor is published only after that deletion transaction commits.
Database writers must not revive an already expired family after obtaining its
lock; arbitrary direct SQL that violates that invariant is outside this guarantee.

This is opportunistic maintenance, not a guaranteed deletion deadline: no pass
runs while there are no new handoff attempts, and failures, process loss or a
response lost after the handler returns can still leave a claim. The 40/20
limits bound candidate and update counts, not the database scan or total elapsed
time; individual statement timeouts do not establish a whole-pass latency bound.
Older running versions do not write claim tags, though new reservation accepts
their untagged claimed rows. Logical updates do not erase PostgreSQL history,
WAL or backups. A separately reviewed reliable cleanup and retention policy is
still required before enabling sign-in.

Isolated local PostgreSQL tests passed with both owner and restricted runtime
roles. They cover expiration batches, locked-row progress, cancellation
proofs, claim-tag mismatches, a prior session, rollback and a delayed delivery
of a committed maintenance acknowledgement. Evidence is recorded in
`/home/protocol-x/Downloads/paypal-native-family-retention-five-pg-gsx_e8ky/`,
`/home/protocol-x/Downloads/paypal-native-family-extension-after-q9f_t1a6/`
and `/home/protocol-x/Downloads/paypal-native-lock-order-pg-vu23k621/`.
The acknowledgement delay is injected after a real local COMMIT; the separate
controller's claim-acknowledgement failure uses an in-memory store, not a
real interrupted PostgreSQL connection.

## Proposed flow

1. On an explicit sign-in action, the app creates independent cryptographically random 32-byte state and verifier. It persists the pending state/verifier only in device SecureStore. S256 means SHA-256 over the ASCII verifier, encoded canonical unpadded base64url. The app sends only state, challenge, method and android/ios platform to `POST /api/auth/native/handoffs`. A supplied prior native bearer must be valid; an invalid bearer never starts a guest flow accidentally.
2. The server returns a five-minute opaque handoff and an authorization URL on its exact canonical HTTPS origin and fixed `/api/auth/native/authorize` path. It accepts no user-supplied callback, scheme, host, account type or data scope. The app validates this returned URL before opening the system browser. The platform field selects an already configured return-link profile; it is not app attestation or proof of package ownership.
3. Browser GET shows a minimal confirmation page, never starts authorization. A fresh native-only HttpOnly/Secure/SameSite=Lax host-only binding cookie and anti-CSRF form token protect its explicit Continue POST. The same-origin POST claims the handoff atomically with independently generated provider state, nonce and PKCE verifier. A second browser claim fails. The app handoff verifier is never reused as the provider verifier.
4. PayPal returns to the separately registered `/api/auth/native/paypal/callback`. Consume the browser-bound provider transaction once, perform the existing provider checks, then recheck cancellation, configuration and family generation under lock. Generate a random one-use handoff code with lifetime at most sixty seconds and no later than the original handoff expiry. Redirect only to the configured verified HTTPS app link with `code` and the original app `state`. Do not include identity, dataScope, an app session, provider tokens or errors. Failure uses a fixed local failure page.
5. The app handles only the exact allowed HTTPS host/path and exactly one canonical `code` and `state`. Reject unknown/duplicate query parameters, fragments, oversized links and unmatched state. `POST /api/auth/native/exchange` sends code, handoff, state and the saved verifier over HTTPS. The server atomically validates and consumes the code and creates or rotates an opaque native session. One concurrent exchange can succeed. No replay response returns the token again.
The [PayPal button guide](https://developer.paypal.com/log-in/build-button/) illustrates a successful callback with a `scope` parameter. The local native callback accepts one bounded RFC 6749 scope string on a code response, discards it before provider completion, and never treats it as authority. A bounded `iss` is forwarded to the OpenID verifier; when discovery advertises issuer-response support, the verifier requires a matching value. Within the 4 KiB query limit, unrecognized response extensions are ignored and never forwarded or reflected. Duplicate recognized parameters, malformed scope or issuer values, conflicting code/error parameters, and unsupported hybrid, JARM and token response fields fail closed. Standard error-description fields are discarded on an error response. The fixed app-link destination still contains only the one-use app code and app state. This local behavior does not prove the actual sandbox flow, metadata, scopes, or customer consent.

6. Store the opaque native session only in SecureStore, with device-only access where supported. Never put it in AsyncStorage, a deep link, clipboard, analytics or logs. Delete the pending verifier only after token persistence/read-back succeeds. If exchange succeeds but storage fails, use cancellation to revoke the issued family. If a response is lost, cancel before retrying a new sign-in; the original exchange is not idempotently replayable.
7. Fetch `GET /api/auth/native/session` with the bearer before private hydration and after foregrounding. The session has a fixed thirty-minute expiry and no refresh token. Account changes, expiry and sign-out clear in-memory private views immediately. `POST /api/auth/native/logout` revokes the native family and pending handoffs. Browser/PayPal sign-out is separate.

## Persistence and race invariants

Add separate native handoff/session tables and a reviewed migration; do not silently mutate the existing three-table web schema. Hash random handoff handles, codes, browser-binding handles and session bearers at rest. Store the handoff challenge, app state, expiry, provider transaction, status, configuration fingerprint, family link and generation. Provider PKCE material necessarily persists briefly and must be covered by database permissions/backups. Keep provider tokens, profiles and raw subjects out of storage, as in the current web flow.

Bind native configuration to the existing keyed context fingerprint plus native protocol version, exact registered callback and exact allowed return-link profile. A changed domain, environment, PayPal client, secret, HMAC key, scope or link policy invalidates old attempts and sessions. Do not trust request Host or forwarded headers to construct destinations.

Use a consistent transaction lock order across start, provider completion, exchange, cancel and logout. No lock spans a provider network request. Reserve a provider transaction atomically before that request, and finalize only if the reservation is still current and not cancelled. No callback can resurrect a cancelled or superseded attempt. At most one pending handoff per established native family; a new attempt supersedes its predecessor. Separately initiated guest attempts cannot be reliably identified as the same device and must not claim that guarantee.

Cancellation requires handoff plus the original verifier. A URL observer cannot cancel without the verifier. Keep challenge and issued-family linkage until the issued family's expiry, or original handoff expiry if never issued. Cancel and exchange share a lock: cancel-first prevents issuance; exchange-first is followed by revocation of that issued family and descendants. A failed reauthentication cancelled before exchange does not revoke the pre-existing session; cancellation after successful replacement revokes the resulting family. Logout may revoke successors through retained revoked or superseded aliases until family expiry, even when the original session has expired; retain those aliases until family expiry rather than deleting them on rotation. A canonical alias truly absent from the authoritative store returns204 under the shared lock, as does a retained expired family. Lookup must precede context filtering: an existing foreign-context alias remains401. The same absence rule applies to cancellation; an existing handoff with a wrong verifier remains401. This relies on retaining every alias/handoff while a descendant can live and never intentionally reusing handles; no schema error, filtered absence or failed query is terminal proof. Retention preserves revocation authority only: an expired, revoked or superseded alias must not authorize session reads, new handoffs or other authenticated actions. Repeated known cancel/logout returns 204 only after the store confirms the state. A store outage returns503 and never claims sign-out succeeded.

Client logout hides all private UI immediately. If server revocation cannot be confirmed, retain a separate owner-only revocation-retry record, never usable for normal authenticated requests, until confirmation or known server expiry. Do not describe this as global PayPal sign-out. Revalidation errors enter a privacy hold, not guest hydration over a possibly signed-in workspace.

## Limits before enablement

- Require a separately configured explicit native-enable flag, default off. Disabled handlers make no provider calls: availability returns `{ loginAvailable: false }`, the callback redirects to a fixed local failure path, and the remaining handlers return 503. Local disabled-state route checks establish these responses; successful real provider/device use remains unverified.
- Canonical base64url handles decode to exactly32bytes; reject noncanonical encodings. JSON/form bodies at most2KiB, callback query4KiB, app return link512bytes. Reject duplicate/unknown fields and parameters except for unrecognized provider-callback extensions handled as described above. Body read deadline3seconds. Session/error responses at most2KiB; confirmation HTML16KiB with no third-party assets. Provider bounds remain at least as strict as existing web validation.
- Native store quotas: at most2,048 retained families,4,096 retained handoffs/provider transactions combined,8,192 retained session aliases. Count completed/cancelled/revoked rows too. Separate native counters do not exempt the deployment from an overall database-capacity review. Bounded cleanup removes at most100 eligible expired rows per action; never delete family/alias/cancel evidence while it can revoke an active descendant. Quota exhaustion returns429 with bounded Retry-After.
- Proposed per-process concurrent handlers: handoff/start/callback/exchange8 each, session16, cancellation/logout4 each. These are concurrency bounds, not effective shared rate limits. Require trusted-edge shared abuse limits before public enablement, including guest handoff issuance; do not trust caller IP headers, Origin, platform strings or app version as identity.
- Use verified TLS and a dedicated PostgreSQL role. All responses `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; auth pages have restrictive CSP, no framing and only exact PayPal form destinations. Native bearer routes do not use cookies or permissive credentialed CORS. Browser form CSRF checks remain separate from native bearer authentication.
- Configure and verify redaction in the actual hosting edge/access logs before enabling callback/app-link URLs. Codes, handoffs, state, cookies and Authorization headers must not appear in telemetry, crash reports, logs or captures. The app-link landing page has no analytics or third-party scripts and offers no custom-scheme fallback.

## Native integration files and guest preservation

Introduce a session provider/client outside Expo Router's route directory, then wrap private consumers in `apps/mobile/src/app/_layout.tsx`. Keep public market caches independent. Scope native holdings in `data-context.tsx`, contacts in `venmo-contacts.ts`, and Shop saved collections by verified dataScope and a storage format version. Existing global guest keys remain untouched and separately selectable when signed out. Never rename/copy guest data into the signed-in namespace automatically. Ownership migration is a later explicit choice, not part of sign-in.

Fence all asynchronous reads and queued writes with a session generation and destination namespace captured at initiation. Recheck that generation before committing, publishing or clearing data. Unmount/reset Personal Lite, report imports, contact forms and payment-note drafts on identity transition; preserve only public chart selection and harmless presentation preferences. A delayed guest write must not become an authenticated user's record, and a delayed signed-in read must not reappear after logout. The existing portfolio recovery/verification protections must remain intact for every namespace.

Use the provider-verified account type to select the initial Personal or Business view in `business.tsx`. An unknown type remains explicit and may choose a preview; presentation controls remain clearly separate from actual permissions. Native web builds should use the web cookie model or explicitly disable native login, never persist native bearer tokens in web storage.

Expo is SDK57 in the current package. Before implementing native APIs, read its versioned AuthSession/WebBrowser/Linking/SecureStore documentation and inspect installed API signatures, per mobile AGENTS.md. Install any required package using Expo's compatible installer and create a new native build; Expo Go and the existing APK are not acceptance evidence. The current `paypalmarkets` custom scheme alone does not satisfy this verified-link design. Configure Android App Links and iOS Universal Links through app configuration/plugins and host the association documents for the actual signing identity. No app identifiers, signing fingerprints, Apple team IDs or domain association grants are invented here.

## Required acceptance, not yet performed

Local contract lint proves syntax only. Before enablement, implement and test synthetic signed provider completion, strict body/URL parsing, disabled/unconfigured behavior, challenge/state mismatch, expiry, replay, duplicate browser launch, consumed-code response loss, session-store failure, source/config changes, cancellation versus callback/exchange, logout versus rotation, and cross-process quota enforcement in isolated PostgreSQL. Exercise native cold start, foreground, cancellation, multiple taps, storage failures, delayed writes, guest preservation and account switching. Verify the exact Android/iOS verified link with real signed development builds on devices.

Finally, confirm PayPal login eligibility and separate callback registration, requested optional account attributes, privacy/user-agreement requirements, HTTPS origin, dedicated database/migration and trusted-edge limits. Run approved sandbox personal/business/unknown-claim cases and distinguish provider success from UI selection. No user decision is needed to implement these local contracts and tests; live configuration, verified links, deployment and device acceptance remain explicit prerequisites.

## Historical mobile client foundation checkpoint — 2026-11-06

The wiring limitations in this checkpoint are superseded by the native adapter and connected private workspace sections below.

The local mobile client validates exact HTTPS configuration and return links, bounded response bodies, state, account type, owner scope and expiry. Exchange results are provisional: server session validation is required before exposing private identity. Thirty-four synthetic client, link, cryptography, session-storage and storage-scope tests passed, including empty Expo response streams and interrupted sign-in recovery. These tests do not establish native transport behavior or real provider acceptance.

Expo-compatible `expo-web-browser` ~57.0.3 and `expo-crypto` ~57.0.4 were installed using the Expo installer; the browser configuration plugin was added. Secret generation uses asynchronous native randomness and S256, with no synchronous development fallback. At this checkpoint the module was not imported into the app UI, and secure-storage binding, session provider and private-data consumer wiring were unfinished. Those source integrations are now complete as described below; native transport behavior, verified links and a new device build remain acceptance gates.

The storage core uses an injected secure adapter and a single small envelope bound to the exact backend and return-link profile. It preserves pending cancellation material through token writes and read-back, rejects stale snapshots, and retains revocation-only retries. A persisted session is only a candidate: the app must revalidate it before private hydration. The browser must never open until the handoff has been persisted and read back; this permits safe recovery of an unbound attempt after restart. At this historical checkpoint the actual SecureStore adapter was not yet wired; the later adapter section supersedes that limitation.

Transport review of installed Expo source confirms streaming, redirect rejection and cookie omission, but native fetch does not propagate the JavaScript cache or referrer-policy options. Explicit request cache headers and server no-store responses are required; the response-size check bounds accepted JavaScript content, not native buffering before cancellation. Native transport and operating-system storage still require device acceptance.

## Native adapter and lifecycle implementation — 2026-11-06

The mobile adapter now binds the strict client to named `expo/fetch`, uses a singleton SecureStore adapter, and validates the fixed browser handoff and return link. iOS requires 17.4 or later for the verified HTTPS callback flow. iOS storage uses device-only, when-unlocked Keychain accessibility; Android uses Keystore encryption and does not gain an equivalent unlock gate from that option. Backup exclusion and signed app links still require build/device verification.

The pure session manager coordinates durable handoff storage before browser launch, server revalidation before identity publication, restart recovery, revocation retries, expiry and foreground/background handling. Cancellation releases the manager even when the browser promise remains pending; Android Custom Tabs cannot be programmatically dismissed by this adapter, so its browser lock remains until Expo reports completion. Late browser results cannot resume a cancelled exchange.

`customer-session-config.ts` accepts only explicit public sign-in configuration, with disabled sample flags in `apps/mobile/.env.example`. It never borrows the market API origin. When configuration is disabled or missing, a separate secure-record presence check is required before allowing guest mode; a missing key or canonical validated envelope with no session, pending attempt, or revocation retries permits guest mode. An empty envelope may belong to a previous configuration because it contains no authentication material. Nonempty, corrupt, noncanonical, or unreadable records cannot silently become guest sessions. This check never deletes the key or exposes stored values. The root provider and Account session panel now consume these modules. Sign-in remains disabled by the public sample flags and server prerequisites; no real sign-in has been verified.

Revocation recovery remains conservative: an old token's local expiry cannot prove the whole server family is gone, because rotation extends family lifetime. A 401 during retry does not automatically delete proof or claim successful sign-out. The terminal-state contract now permits recovery only after authoritative logout/cancel204 and confirmed local persistence. Typed session401 starts that revocation flow; other failures remain held. Local-only forgetting is not implemented and must never be described as server revocation.

## Historical portfolio consumer foundation

The later connected private workspace section supersedes this checkpoint’s unwired-provider status.

`DataProvider` gained `storageFence` and `storageRevision` inputs for the then-future session provider. Callers retained the guest default at that checkpoint; the root provider is now connected. Each private storage operation captures a fixed destination and checks the lease before and after awaiting storage; queued writes capture their writer instead of consulting a later account's writer. Owner operations never inspect or migrate guest legacy holdings. A render-time identity check masks holdings, drafts and recovery immediately when the current scope differs from the loaded scope. Public currency, overview and chart state remain independently mounted.

Five synthetic scope tests cover privacy holds, stale callbacks, owner-versus-guest isolation, late reads, issued/queued writes, guest recovery and public preference preservation. These prove the consumer boundary under injected identity changes, not actual account switching in the installed application. Contacts, Shop collections, private screen remounts and the root session provider are now connected locally, with sign-in still disabled pending configuration and device acceptance.

## Connected private workspace — 2026-11-06

The root session provider now feeds the portfolio fence and revision. Portfolio and Account private forms remount on identity revision and are omitted while a session is held. Account type from the verified session selects the initial Personal/Business view; unknown remains explicit, and preview selectors grant no permission. The session panel offers real manager actions only when runtime readiness permits them.

Contacts use a generation-bound repository with serialized mutations, exact destinations, baseline checks and deletion read-back. Shop collections use a generation-bound repository with load-before-save and exact read-back checks. The Shop screen masks private list state immediately while preserving public browsing/storefront selection; saved-product offer rechecks cannot publish or open retailers after an identity change.

Disabled builds import only the SecureStore presence helper, avoiding new browser/crypto module loading. Web remains native-login-disabled and uses its existing guest workspace. Backgrounding hides private information even when native login is disabled; foreground rechecks stored auth presence. A session retry revalidates an existing session rather than treating the retry button as sign-out. Actual operating-system background timing, screenshots and storage behavior remain device acceptance work.

## Native readiness follows cached provider discovery — local6November follow-on

Enabled availability now requires session-store readiness followed by the existing cached PayPal discovery helper. Either prerequisite failing returns200with loginAvailable:false. Disabled mode does not access store/provider; budget denial or budget-database failure retains429/503 without a provider probe. This is readiness metadata, not proof of client entitlement, consent or a successful provider login. Authenticated session reads and cancellation/logout remain independent of provider discovery, preserving recovery during an outage.

Local guarded verification:13native controller tests (including unavailable/recovered discovery, disabled/store-failure no-provider behavior, budget429/503 and session/recovery continuity), full root TypeScript and scoped zero-warning ESLint passed. Evidence: /home/protocol-x/Downloads/paypal-native-readiness-check-mi6j6lpn. Native OpenAPI and all10disabled collection requests linted clean; no collection requests or real provider calls were executed in this pass. This modifies local source only, not the prior immutable build artifact or hosted service.

## Disabled callback query removal — local follow-on

Disabled/incomplete native callbacks now return303with fixed relative Location /api/auth/native/failure, no-store/no-referrer and no cookies or backend/provider work, even with spoofed Host or request origin. The destination itself may remain503when disabled, but callback code/state is removed from the navigation URL. Disabled availability/session behavior is unchanged. This supersedes earlier generic statements that every disabled handler returns503; it does not claim upstream logs were redacted.
