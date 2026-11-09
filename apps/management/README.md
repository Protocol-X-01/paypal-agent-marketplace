# PayPal Operations — separate management concept

A standalone local reporting app for an internal customer-operations audience. It does not share routes, customer account state, imports or credentials with the customer website or Android app.

It opens **disconnected**. “Show fictional preview” explicitly reveals invented aggregate figures; the source, fixed fixture timestamp, population and completeness remain visible. Operations and Leadership change the presentation, not staff permissions. Nothing is persisted in browser storage.

## Run locally

Use the dependencies already installed at the repository root. No install or environment file is needed:

```sh
cd /home/protocol-x/Downloads/paypal-agent-marketplace/apps/management
npm run dev
```

The default address is **http://127.0.0.1:3002**. Customer Next.js on 3000 and Metro on 8081 are separate. The scripts call the root Next.js 16.4.3/React 19.3.0 toolchain directly and select Webpack. No dependency symlink is required.

```sh
npm test
npm run lint
npm run typecheck
```

`npm run build` builds this app only; `npm start` serves that build on the same loopback address and port. Coordinate a build with other project work before running it.

## Read the fictional example

- The 7-day current period is 26 October–1 November 2026; its previous period is 19–25 October. The 30-day current period is 3 October–1 November; its previous period is 3 September–2 October. Boundaries are midnight UTC, end-exclusive.
- The two fixtures have independently invented unique-account populations. Each has 12 non-overlapping cohorts: Personal or Business, existing or new, and US, UK or Other market. Market attribution is fixed within the fixture.
- Active means at least one included completed payment event. Existing accounts opened before the current period; new accounts opened during it. Retained accounts were active in both periods. Reactivated accounts were inactive in the previous period. Retention divides retained by previous active; new cohorts have no denominator.
- Current active = retained + reactivated + newly active. Previous active = retained + no-longer-active. Event counts are not unique customers. Daily fictional event counts reconcile to the selected aggregate totals.
- Gross volume uses fictional USD amounts before fees and refunds. It is not revenue, customer funds or a balance. “Complete” means complete **within the fixture**, not real PayPal coverage. The fixed fixture timestamp is not a live refresh time.
- Period, account type and market filters apply to the entire report. Table search only narrows the table. Sorting keeps unavailable retention values last. Cohort selection explains its denominator.
- Aggregate activity compares completed events divided by included attempts in each period. Rates use the combined event counts for the selected population, and their difference is shown in percentage points. A zero denominator makes that period's rate and the comparison unavailable. “Not completed” is the difference between attempts and completed events; it does not establish a cause.

## Gates before a real connection

There is no staff authentication or authorization, connected reporting feed, individual customer record, live alert or operational action. An optional local-only AI endpoint explains explicitly selected fictional report figures through the configured OpenAI provider; it is disabled in production and does not connect real PayPal data. This scaffold is not ready for production or real customer data.

Staff setup describes the remaining decisions: authorized staff SSO and report permissions; an approved aggregate source and owner; metric/market definitions; freshness and completeness rules; small-group suppression; purpose and data-use authority; retention and audit review. Real access enforcement must be designed before wiring a source. Do not copy the customer app’s `.env`, AG Grid key or provider credentials here.

The first pass deliberately uses an accessible HTML aggregate table and inline SVG/CSS charts. It needs no Enterprise license, external fonts or third-party services. Browser and hosted acceptance are separate from local source checks.

Local validation on 6 November 2026 after the completion comparison: 17 focused tests, scoped ESLint and TypeScript passed. An earlier version passed a guarded production build, with evidence under `.checks/build-20261106T115505Z.log`; that build does not verify the completion comparison. No new build, browser acceptance or deployment was performed for this change.
