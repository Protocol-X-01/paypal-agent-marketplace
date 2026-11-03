# PayPal Markets website and app roadmap

Updated 2026-11-03. This is the working scope for the PayPal hackathon concept. The project began as an agent marketplace prototype; the product direction now puts Venmo in the wallet role and adds market context, portfolio estimates, and Channel3 product discovery around it.

## Product boundaries

- Venmo remains the customer's wallet and payment surface. This concept does not connect to a Venmo account, hold keys, execute crypto trades, or complete retailer checkout.
- CoinGecko currently supplies broad market prices, metrics, and chart history. MetaMask Agent Wallet now documents separate `mm price spot` and `mm price history` commands keyed by CAIP-19 chain assets; evaluate them as a possible wallet-specific complement only after checking asset coverage, freshness, terms, and the actual account requirements. The PayPal/MetaMask on-ramp relationship alone does not establish a source for PayPal's consumer market metrics. Keep market data separate from Venmo's wallet role.
- Manual portfolio values are estimates calculated in the browser from customer-entered quantities and public prices. They are not balances or financial advice.
- Channel3 searches are customer initiated. Saved product collections stay in local browser storage until an authenticated account and sync model exist; saved offer snapshots do not retain retailer URLs, and retailer handoff refreshes the product first.
- The current work is a responsive website prototype. It does not prove that the separate Android or iOS application has been upgraded or accepted on a device.

## Delivered in this working tree

- A public homepage alongside the market dashboard, with links between market, portfolio, settings, and product discovery views.
- Live CoinGecko market snapshots on the homepage and richer market charts and metrics in the dashboard.
- Seven assets from PayPal's published U.S. supported-crypto help page are represented in market views: BTC, ETH, SOL, LINK, LTC, BCH, and PYUSD. Account availability can vary by region. PYUSD has a visible $1.00 reference and a chart scale that makes small peg deviations legible without exaggerating them.
- A mobile-first dashboard with watchlist controls, manual portfolio estimates, data export/reset, and local Channel3 shopping collections.
- Channel3 product search, offer comparison, retailer handoff, saved snapshots, and named collections in this browser.
- Offer results are fetched without a server-side cache. Retailer handoff refreshes the exact product through a current Channel3 search before opening the retailer; saved browser collections keep snapshots without reusable offer URLs.
- AG Charts powers the market history chart with selectable price, market-cap, and volume metrics. AG Grid is wired into the empty-state Business workspace; no merchant data or sample metrics are presented as live.
- The old agent purchase, wallet credit, and order paths were retired while authenticated identity, authorization, durable order records, and idempotent payment handling remain undefined.
- Local Postman collections and OpenAPI specifications document the current market and Channel3 APIs. They have not been published to a Postman workspace.

## Remaining scope

### 1. Mobile client and product flows

- Inspect the existing Android/iOS applications and map the website design and data behavior to their native navigation, accessibility, authentication, and release conventions.
- Make market charts and metric explanations usable on-device, including loading, stale-data, and provider outage states.
- Define the contact, payment, and portfolio flows around the existing Venmo experience. Do not build a substitute wallet or payment rail in this prototype.
- Decide which account, consent, and secure storage features are required before any portfolio data can sync across devices.

### 2. Identity, payments, and security

- Define an authenticated identity and ownership model before storing contacts, payment preferences, orders, or server-side portfolios.
- Preserve customer confirmation and provider-owned checkout. Any future payment implementation needs persisted order state, ownership checks, webhook replay protection, and idempotency.
- The PayPal webhook validates required headers and bounds body size and verification time; it acknowledges valid deliveries without processing payments. Add replay and idempotency controls before processing any payment event.
- Baseline response security headers are set in `next.config.ts`. Replace the in-memory Channel3 rate limit with a shared bounded limiter using a trusted deployment client address; the current endpoint trusts the first client-supplied `x-forwarded-for` value. Define a Content Security Policy after documenting the product-image and retailer-link origins.
- Add a focused threat model and operational review for each enabled integration and any new customer data flow.

### 3. Monitoring and observability

- Connect Elastic Observability to the deployed app for service health, API latency, provider failures, and actionable alerts after a deployment target and telemetry policy are chosen.
- The company view should serve two audiences: business teams reviewing aggregate customer activity, segment trends, and exceptions; and leaders reviewing a concise customer-health and retention snapshot.
- PayPal Transaction Search is a candidate first-party source for a merchant's own activity. It uses OAuth scope `https://uri.paypal.com/services/reporting/search/read`, supports at most 31 days per query, lists the previous three years, and may take up to three hours to show executed transactions ([API reference](https://developer.paypal.com/api/transaction-search/v1/search-get)). Label insights as PayPal-only and show freshness.
- Cross-merchant data requires a PayPal platform integration, merchant identity assertions, and each represented merchant's explicit consent ([request guidance](https://developer.paypal.com/api/make-api-requests)). Do not treat app credentials as authorization to read customer merchants' data; confirm partner eligibility before implementing that path.
- For U.S. users under the PayPal Developer Agreement, transaction history and certain other PayPal User Information must be deleted within 48 hours of receipt ([privacy terms](https://www.paypal.com/us/legalhub/paypal/xdeveloper-full?locale.x=en_US)). Review the applicable regional agreement and retention requirements before keeping historical customer-health or retention metrics; do not assume derived aggregates are exempt.
- Use consented first-party business data with account ownership checks. Do not show row-level customer PII by default or present sample metrics as live data.
- Elastic app telemetry can show this product's health; it does not provide merchant customer insights by itself.
- Establish data source, access roles, retention, redaction, and alert ownership before sending customer or request data to monitoring services.

### 4. Sponsor integrations

- **Channel3.ai:** Current search and local collection experience is implemented. Confirm the desired curated-list semantics, account sync, and any collection/list API before treating local collections as a shared Channel3 list.
- **Zapier MCP:** The onboarding skill was loaded and run with a read-only Calendar sample and a GitHub profile lookup. Google Calendar and GitHub are the connected defaults. Calendar event creation, AI payments, subscriptions, and other write actions are deferred for later this week and need their own account, approval, and idempotency boundaries.
- **Elastic:** Observability integration is planned; endpoint, environment, dashboards, and alert ownership are still to be set up.
- **Kernel:** Keep the human wallet and agent account separate. Add a restricted agent account only after its permitted actions, spend caps, approval requirements, and audit trail are defined.
- **Render:** Added a Git-backed Blueprint for the web app, with a production build, sandbox PayPal defaults, secret prompts, and `/api/health`. The cloud service and public URL are not created yet: this checkout has no Git remote, and the configured Render API key was rejected with HTTP 401. The Blueprint's free plan is preview-only; Render sleeps after 15 idle minutes and loses local filesystem changes, so use an always-on paid service and durable database before relying on live webhook delivery or storing customer data.
- **Postman:** Current API collections are local artifacts. Decide whether to publish them to the team's workspace and add monitors after environment ownership is confirmed.

### 5. Components and operational quality

- The Bryntum Scheduler license is still pending; the trial files already present in the repository were left untouched.
- The user confirmed the AG Grid license is available. AG Grid Enterprise and AG Charts are installed and integrated; the app reads `NEXT_PUBLIC_AG_GRID_LICENSE` at build time. The key value remains private and was not validated during this turn.
- Add documented API examples, provider outage behavior, accessibility review, and device-level visual review for the mobile clients.
- Keep external data provenance and retrieval times visible, and avoid presenting fixtures as live prices, offers, balances, or company alerts.

## Current delivery gates

1. Review the homepage and dashboard at desktop and mobile sizes, including a Channel3 search handoff and empty/error states.
2. Decide the native mobile app targets and account/contact/payment requirements.
3. Confirm provider credentials and operational ownership without exposing secrets.
4. Attach the Render Blueprint to the intended Git repository, restore a valid Render API key if API provisioning is desired, add provider secrets in Render, choose a paid always-on plan for production webhooks, then verify the exact hosted artifact and public flows.
5. Publish Postman assets and add any permitted Zapier or Kernel workflows only after their data and action boundaries are reviewed.
