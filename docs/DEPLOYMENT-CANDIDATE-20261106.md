# Website deployment candidate — 6 November 2026

This is a review checklist for the current local working tree, not a frozen commit, approved release, or claim about the current hosted service. It covers the customer Next.js website/API. The separate Operations app and Expo clients have distinct artifacts and acceptance gates. No deployment or provider configuration was performed by preparing this document.

## Candidate boundaries

- Deploy public market references, manual local portfolio tools, regional Channel3 discovery and customer-local lists. No payment, trade, connected balance, merchant reporting feed or staff access is enabled.
- Keep `PAYPAL_LOGIN_ENABLED=false` and `PAYPAL_NATIVE_LOGIN_ENABLED=false`. Missing auth database/provider configuration is not a boot blocker for this disabled candidate; handlers must remain fail-closed.
- Hosted AI stays unavailable. The current AI implementation explicitly requires development mode and a loopback origin and rejects Render/other hosted markers. Supplying an OpenAI key does not make it a supported hosted feature.
- The webhook acknowledges verified events with `received:true, processed:false`; it has no durable event inbox or payment processing. Do not describe it as a completed payment integration.

## Local configuration review

The tracked `.node-version` pins **24.22.1**. The local build runtime reported **24.21.0**. The version pin exists. The later clean-install verification below used the pinned24.22.1 release and resolves the local runtime-version gap.

`render.yaml` currently specifies Frankfurt free Node compute, `npm ci --include=dev && npm run build && npm prune --omit=dev`, `npm run start`, and `/api/health`. It auto-deploys commits: a push can trigger deployment and needs its own concrete review/authorization.

The local Blueprint now includes the shared catalog identifier `01M6RXV6KZC4ZPRAE6SNQ6EB96` and explicit false web/native auth flags. Root reported validation against Render's current public JSON schema passed; the Blueprint was not applied. Schema validation does not verify service credentials, provider behavior, available compute or a successful deployment.

| Capability | Configuration/runtime requirement | Effect when unavailable |
| --- | --- | --- |
| Next.js startup | Lockfile installation, compatible pinned Node/native dependencies, successful production build, correct Render port binding | Build/start blocker |
| CoinGecko market references | Server `COINGECKO_DEMO_API_KEY`; outbound access to the fixed Demo host | Market routes unavailable; not an application boot blocker |
| Channel3 discovery | Server `CHANNEL3_API_KEY`; HTTPS base; valid locale; new `CHANNEL3_COLLECTION_ID` | Shop provider functionality unavailable; not a boot blocker |
| AG Grid licensed UI | Build-time `NEXT_PUBLIC_AG_GRID_LICENSE`, according to license terms | Licensed configuration needs separate acceptance; public bundle value, not a server secret |
| Sandbox webhook | `PAYPAL_ENV=sandbox`, matching client ID/secret and registered `PAYPAL_WEBHOOK_ID` | Receiver returns configuration/error response; not a boot blocker |
| Elastic | Optional HTTPS OTLP base URL and API key on production, non-preview Render | Export disabled; not a boot blocker |
| Customer login | Explicitly disabled for this candidate | No real login claim; database setup deferred |
| AI explanations | Local-only implementation, intentionally unavailable on Render | Not a hosted feature or boot blocker |

`sync:false` entries prompt on new Blueprint creation; they do not populate an existing service on later sync. Review existing-service values through an approved configuration channel without exposing secrets. Local `.env` updates do not establish Render values. Explicit GB/GBP and US/USD storefront requests override the Blueprint's US/USD legacy default.

## Evidence and limits

- Current collection readback matched all 100 clauses after only the provider's null-to-empty exclusion-list normalization, plus exact metadata. Local binding and six local catalog requests were verified. Account-level brand/publisher approval remains unverified; collection membership or advertised commission rates do not prove enrollment or payable attribution. See the expanded Shop section of [local acceptance](LOCAL-UPGRADE-ACCEPTANCE-20261106.md).
- Native terminal recovery has isolated PostgreSQL, controller and mobile checks; it is source validation, not a real database migration or provider/device login.
- `/api/health` reports process health only. A 200 does not establish CoinGecko, Channel3, webhook signature verification, database readiness or telemetry export.
- Free compute may sleep and has ephemeral local storage. Durable auth/payment/event processing needs a separate database and operational plan. In-process provider/webhook concurrency limits are not shared across service instances.
- The production builds below use existing installed dependencies and do not prove the Blueprint's clean install/prune sequence or pinned Node runtime.

## Before an authorized deployment

- [ ] Identify the exact reviewed source commit/artifact and included changes; preserve unrelated working-tree edits and exclude secrets/local evidence backups.
- [ ] Validate clean lockfile install, production build, prune and start using the intended Node version and Render resource limits, including `better-sqlite3` native compatibility.
- [ ] Review build-time public values separately from server secrets; confirm the AG Grid licensed build if included.
- [ ] Review existing Render provider variables and new collection binding without printing their values; keep both auth flags false and hosted AI disabled.
- [ ] Confirm the intended preview compute plan and receiver-only webhook scope; do not add customer data persistence implicitly.
- [ ] Obtain authorization for the concrete push/deployment/configuration changes. This checklist is not that authorization.

## After an authorized deployment

- [ ] Capture actual deployed revision, build result, runtime version and health.
- [ ] Verify current quote/history and candle routes, supported interval/asset boundaries and visible source/quote labels.
- [ ] Verify GB and US Shop category/retailer results, required retailer filters, pagination and the new collection binding; inspect empty/error behavior.
- [ ] Confirm disabled auth/AI responses and security headers; stale credentials must not reveal private state.
- [ ] Exercise an explicitly approved signed sandbox webhook delivery and inspect receiver acknowledgement. Provider event creation alone is insufficient evidence of delivery/signature verification.
- [ ] If Elastic is intentionally enabled, verify sanitized spans at the intended collector; synthetic local receiver tests do not establish live export.
- [ ] Visually review the deployed website at phone/tablet/desktop sizes. A separate signed native build/device pass is still required for Expo.

## Separate future enablement gates

Web login requires approved exact origin/OAuth callbacks/scopes, stable subject HMAC secret, verified-TLS PostgreSQL and explicit schema migration, plus real authentication/ownership checks. Native additionally requires verified Android/iOS associations, corresponding return URLs, reviewed edge controls, compatible signed builds and device acceptance. Flags acknowledging these prerequisites are not evidence they occurred.

Payment processing requires durable event/order records, replay handling, idempotency, ownership/consent, shared capacity controls and a reviewed operational model. Internal Operations needs independent staff authentication/authorization and approved aggregate data. These are outside the disabled customer-site candidate.

## Current local build results

Build-owner evidence, 6 November 2026:

| Artifact | Result | Evidence directory | Scope |
| --- | --- | --- | --- |
| Customer website, actual Turbopack | Passed; 17.59 seconds; sampled peak 1,571.14 MiB; six processes; 28 static pages | `/home/protocol-x/Downloads/paypal-current-website-production-omcjaheq/` | 143 source files; build ID `d2_PrZIekzjrqNEjX43Er` |
| Separate Operations | Passed; 17.76 seconds; sampled peak 591.10 MiB; five processes; four static pages | `/home/protocol-x/Downloads/paypal-current-operations-production-xdt2axbg/` | 18 source files; build ID `riwsfhPucxmUvUPGGmNAy` |

Each directory contains `metrics.json`, `build.log`, `command.json` and `provenance.json`. Website source-manifest SHA256: `81155f0fad510a29add59d4d6f966421305770b4b56c5a833d1ee151c4e8053a`; Operations: `cbd653b3772c03397f1e3b7e184a415bb742eaaf9cfd1b8eab49bd8e2240cf50`. Live source stayed unchanged. The website snapshot's Next-generated `next-env.d.ts` changed its `.next/dev/types` reference to `.next/types`; Operations snapshot sources stayed unchanged.

Both used existing read-only root dependencies, a cleared environment and private network isolation. No install, provider/runtime interaction or deployment occurred. These are compilation artifacts, not frozen release commits.

## Fresh hosted route observation

Recorded 2026-11-06T17:35:39.905383+00:00 from root's immediately preceding read-only checks of `https://paypal-markets-companion.onrender.com`:

- `/api/health`: HTTP200, 1.49 seconds.
- `/api/marketplace/catalog` without query: HTTP404, 0.58 seconds.
- `/api/market/quotes?currency=INVALID`: HTTP404, 0.47 seconds.

These probes did not request provider product/market data. They establish that the current hosted service responds but lacks these newer routes; they do not identify its commit or verify any secret/configuration. Local build success must not be described as hosted rollout.

## Saved-artifact production startup checks

On 6 November both previously built artifacts passed bounded HTTP checks with production mode, a cleared environment, read-only artifact mounts and private network namespaces. Website:18 checks,3.93seconds,238.57MiB sampled peak; Operations:2 checks,3.52seconds,200.93MiB. Both temporary servers stopped and build hashes remained unchanged.

Website checks covered homepage/dashboard/health/font responses, signed-out web session, disabled native availability and eight disabled native handlers, unavailable AI and invalid intraday input. Operations served its default disconnected state without enabling fictional preview; AI remained unavailable. Evidence: `/home/protocol-x/Downloads/paypal-current-website-runtime-jyyotrhi/` and `/home/protocol-x/Downloads/paypal-current-operations-runtime-3xtlli0z/`. These checks do not establish enabled provider behavior, browser appearance, clean installation or the pinned runtime.

## Pinned-runtime clean-install check

Verified the official Node24.22.1 Linux x64 archive against its published SHA256, then extracted it privately without changing system Node. It reports npm11.19.1. A private cache contained434 integrity-verified eligible package archives;432 came from existing cache and two bounded registry downloads supplied missing archives. No credentials, user npm configuration or live node_modules were copied.

Initial offline installation failed because node-gyp attempted to download headers. That harness prerequisite was corrected by using the headers included in the verified Node distribution. Two fresh network-isolated runs then passed the exact `npm ci --include=dev` with lifecycle scripts enabled and432 installed packages. The application compile stage passed, but both full builds were terminated by the unchanged1,800MiB aggregate process-tree guard during TypeScript checking. The single bounded retry used a512MiB JavaScript heap cap and also crossed the aggregate guard. No typechecking was disabled and no further retry was made.

Evidence: `/home/protocol-x/Downloads/paypal-render-clean-node24-at421puy/` (missing-header failure), `/home/protocol-x/Downloads/paypal-render-clean-node24-headers-4ioqiw1m/` (first memory stop), `/home/protocol-x/Downloads/paypal-render-clean-node24-bounded-meucnc9y/` (bounded retry). Sampled peaks were1,802.69MiB and1,801.86MiB respectively, with9processes; source stayed unchanged and owned processes stopped. The completion peak is unknown. These local guard stops do not prove Render itself will fail.

**Historical result, superseded by the reviewed-budget pass below:** these two1,800MiB attempts did not reach prune/start/native-binding checks. Their failure evidence is retained; they do not establish an application failure.

## Reviewed-budget pinned-runtime pass

A read-only comparison found no unintended TypeScript inputs or dependency-version mismatch. The clean-install harness retained more wrapper processes than the earlier direct Next build. Three fresh resource samples showed over14GiB available RAM and12GiB disk. The local budget was explicitly reviewed to2,560MiB aggregate RSS, with10GiB available RAM required to start and an8GiB available-RAM stop threshold,12processes and600seconds. No typecheck was disabled or source narrowed.

The complete sequence passed under verified Node24.22.1/npm11.19.1: `npm ci --include=dev` (432packages,6.798seconds), `npm run build` (including TypeScript and28pages,18.978seconds), `npm prune --omit=dev` (324development packages removed from the isolated copy,0.700seconds), production dependency validation, a better-sqlite3 in-memory `SELECT1` check, and `npm start` followed by HTTP200 health. Total29.79seconds, peak2,221.38MiB/10processes, minimum available RAM12,406.6MiB; source unchanged and temporary server stopped. The512MiB JavaScript old-space limit remained in place; aggregate RSS includes other processes and native memory.

Evidence: `/home/protocol-x/Downloads/paypal-render-clean-node24-reviewed-ivps3x79/` (`BUDGET-REVIEW.md`, `results.json`, `metrics.json`, install/build/prune/runtime logs). This closes the local pinned-runtime clean-install/build/prune/start gate. It does not verify a licensed public build, enabled providers, the actual Render build machine, browser/device acceptance, or deployment. The original project dependencies, system Node and live previews were untouched.

## Current local production-runtime checks

The build owner subsequently ran namespace-local servers against the saved read-only builds with no credentials or external network. Website: **18 checks passed**, 3.93 seconds, sampled peak 238.57 MiB/four processes; evidence `/home/protocol-x/Downloads/paypal-current-website-runtime-jyyotrhi/`. Home/dashboard/health/fonts returned200, web session was signed out200, native availability false200, eight disabled native handlers503, AI503 and invalid intraday400. Operations: **two checks passed**, 3.52 seconds, 200.93 MiB/four processes; evidence `/home/protocol-x/Downloads/paypal-current-operations-runtime-3xtlli0z/`; homepage200 showed disconnected/default-preview-off state and AI503. Build hashes remained unchanged and both servers stopped. This adds local production-runtime evidence, not visual, provider, enabled-auth or hosted acceptance.

## Authorized read-only hosted configuration review

On 6 November the user confirmed My Workspace for read-only inspection. Render's connector returned service `srv-dbl51ll9fdbs739i6gdg`, the existing PayPal repository/main branch, Frankfurt free runtime plan and commit-triggered auto-deployment. Latest deployment remained live at `1329b80bc75ab0b8192010aa1a5983cd111ec6e0` (deployment `dep-dbmqnbrm8hqs73b6o0mg`). Build/start commands match the locally verified production sequence.

The connector lacked read-only environment access, so the documented Render API was used with the existing local management credential. Only boolean presence/equality results were emitted; no secret values were printed or saved. Direct service configuration has Channel3 key, PayPal client credentials, matching webhook ID and AG Grid license, each equal to the corresponding local value. CoinGecko Demo key, new Channel3 collection ID, both Elastic settings and explicit login flags are absent. Both login flags are therefore not enabled. A complete bounded workspace environment-group list returned zero groups, so no linked group fills these omissions. Presence/equality does not prove enabled provider behavior on the current deployed revision.

Proposed configuration delta for a later separately authorized candidate deployment: add the local CoinGecko Demo key, set the verified shared Channel3 collection ID, explicitly keep both login flags false, and preserve all other existing service values. Elastic remains deferred until the endpoint is supplied and its export is reviewed. No configuration update or deployment was performed during this read-only review.

API reference: https://api-docs.render.com/reference/get-env-vars-for-service and https://api-docs.render.com/reference/list-env-groups .

## Read-only hosted state refresh — 9 November 2026

The existing Render service `srv-dbl51ll9fdbs739i6gdg` remained live on deployment `dep-dbnoeboae00c738vvvq0`, commit `b40086ea418b4e002e2ba189968cd6920dc9b703` (`b40086e`, 7 November 2026). GitHub `main` is at `ca3bc037ba7d428338a6c9399e0368e7923e096a` (`ca3bc03`); that gallery-only commit is marked `[skip render]`, so it does not replace the deployed website revision.

Two public GET checks were made on 9 November: `/api/health` returned HTTP 200 with `status: ok`; `/api/auth/session` returned HTTP 200 with `authenticated: false` and `loginAvailable: false`. These checks confirm only process health and the signed-out/login-disabled state. They do not re-verify market, catalog, webhook, database, telemetry or visual behavior on the current deployment.

This was a read-only observation. No Render environment, database, service setting or deployment was changed. The local working copy was dirty and based on `1329b80` at the time, seven commits behind `main`; the source changes in that copy are separate from this hosted observation. GitHub visibility remains private and the existing Render demo remains publicly reachable.
