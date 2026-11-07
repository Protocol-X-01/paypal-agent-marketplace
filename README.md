# PayPal Markets

<p align="center">
  <a href="publication-packs/README.md">
    <img src="publication-packs/releases/paypal-markets-CONCEPT-20261107-v4/artwork/concept-cover-wide.png" alt="PayPal Markets — independent concept cover for Markets, Portfolio and Discover" width="880" />
  </a>
</p>

<p align="center"><strong>INDEPENDENT CONCEPT · HACKATHON DESIGN STUDY</strong></p>
<p align="center">Market clarity · personal planning · everyday discovery</p>
<p align="center">
  <a href="publication-packs/README.md"><strong>Explore the publication pack</strong></a>
  &nbsp;·&nbsp;
  <a href="publication-packs/releases/paypal-markets-CONCEPT-20261107-v4.zip"><strong>Download edition v4</strong></a>
  &nbsp;·&nbsp;
  <a href="publication-packs/releases/paypal-markets-CONCEPT-20261107-v4/README.md">Read its scope and evidence</a>
</p>

> **Independent concept.** This project is not an official PayPal or Venmo product. No affiliation, endorsement or trademark licence is claimed.

PayPal Markets explores a clearer customer view of public cryptocurrency reference prices, locally calculated portfolio estimates and Channel3 product discovery, alongside a Venmo-first payment experience.

This branch contains the web application and the publication pack. The companion Expo app and separate internal Operations experience are not included as source here. Their historical preview captures are included in the pack and are labelled with their actual scope.

## Product overview

- **Markets:** CoinGecko reference prices and history for BTC, ETH, SOL, LINK, LTC, BCH and PYUSD, with chart controls and market context.
- **Portfolio:** customer-entered quantities and local estimates. These are not connected wallet balances or settlement values.
- **Discover:** Channel3 product search and curated browsing for GB and US storefronts. Current advertised commission appears only when the provider supplies it; it is not guaranteed earnings or customer cashback. Product purchases remain with the retailer.
- **Business:** a workspace for customer-provided aggregate reports and clearly labelled fictional examples. It does not connect to a PayPal Business account or provide PayPal-wide customer monitoring.
- **Operations concept:** the pack includes an explicitly fictional internal-management presentation. No PayPal staff identity or internal customer-data feed is connected.

## Important boundaries

Venmo remains the customer's wallet and payment surface. Contact payments are prepared as a draft for the customer to review and send in Venmo. This prototype does not hold keys, execute crypto trades or complete retailer checkout.

Market prices are reference data, not PayPal or Venmo execution quotes. Portfolio values come from manually entered quantities. Account sign-in is disabled by default; this branch does not establish connected balances or live business reporting. The AI market explanation is a local development demo and is unavailable on the hosted site. Elastic export is opt-in and disabled by default; no real telemetry is implied by the concept pack.

## Publication pack

The latest shared edition is **PayPal Markets — CONCEPT v4**. It contains the offline visual catalogue, two original concept illustrations, historical web and Expo Web captures, fictional Operations examples, asset provenance, source evidence and a submission-readiness checklist.

- [Open the pack index](publication-packs/README.md)
- [Download the v4 ZIP](publication-packs/releases/paypal-markets-CONCEPT-20261107-v4.zip)
- [Read the v4 overview](publication-packs/releases/paypal-markets-CONCEPT-20261107-v4/README.md)
- [Browse the v4 files](publication-packs/releases/paypal-markets-CONCEPT-20261107-v4/)

GitHub shows the offline `START-HERE.html` file as source. To view its catalogue, download and extract the ZIP, then open `START-HERE.html` in a browser. The pack is for private review and preparation; publication, submission and deployment are separate actions.

## Run the web app locally

Use Node from `.node-version`, then install dependencies and create a local environment file:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Add provider credentials to `.env.local` only when you have them; never commit secret values. CoinGecko market data requires `COINGECKO_DEMO_API_KEY`. Channel3 search requires `CHANNEL3_API_KEY`; curated browsing also requires the shared `CHANNEL3_COLLECTION_ID`. AI insights remain off unless the documented local-only settings are explicitly enabled.

## Project guide

- [Upgrade roadmap](docs/UPGRADE-ROADMAP.md)
- [Local acceptance record](docs/LOCAL-UPGRADE-ACCEPTANCE-20261106.md)
- [Deployment and hosted-check record](docs/DEPLOYMENT-CANDIDATE-20261106.md)
- [Local AI insight boundaries](docs/LOCAL-AI-INSIGHTS.md)
- [Intraday candle sources and limits](docs/INTRADAY-MARKET-DATA.md)
- [Business data scope](docs/PAYPAL-BUSINESS-DATA.md)
- [Zapier MCP readiness](docs/ZAPIER-READINESS.md)

Local Postman collections and OpenAPI contracts are under `postman/`. They have not been published to a Postman cloud workspace.

## Verification and release status

The roadmap and acceptance record distinguish source implementation, local browser checks, provider responses, native-device checks and hosted release evidence. The latest hosted revision and its bounded checks are recorded in the deployment document. A health response confirms liveness only; it does not prove every feature, provider consent, signed webhook delivery or production readiness.
