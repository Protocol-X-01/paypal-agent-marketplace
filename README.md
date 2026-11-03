# PayPal Markets

PayPal Markets is a public website and mobile-first dashboard concept for customers who already use Venmo for wallet and payment activity. It adds clear cryptocurrency prices, market context, charts, a device-local manual holdings estimate, and Channel3 product discovery.

## What works in this build

- A public homepage with live CoinGecko market snapshots and a link into the dashboard.
- Live Bitcoin, Ethereum, Solana, Chainlink, Litecoin, Bitcoin Cash, and PayPal USD market metrics from CoinGecko.
- Price history charts for 1 day, 1 week, 1 month, 3 months, and 1 year.
- A locally stored watchlist and manual crypto quantities. These do not connect to or read from Venmo or another wallet.
- Channel3 product search with retailer offers, price comparison, and device-local named collections. Search runs only after the customer submits a query; checkout remains with the retailer.
- A Business monitoring workspace for teams and leaders, currently shown as an honest empty state until a consented merchant data source is connected.
- AG Charts metric history and an AG Grid Business view; the grid has no fixture rows or live merchant data yet.
- Data settings to export or reset locally saved holdings, watchlists, and product collections.
- A standalone web app manifest and layouts tuned for phone screens.
- Local Postman collections for Channel3 product APIs and the app's market endpoints.
- Baseline response headers and an app liveness endpoint for Render health checks.

Tracked assets follow PayPal's published U.S. supported-crypto help page; actual PayPal availability varies by region and account type. Market prices are reference data and may differ from prices offered by a payment provider or exchange. PayPal USD (PYUSD) is shown as its own USD-pegged stablecoin, with a $1.00 chart reference; USD remains the quote currency. CoinGecko data is not a PayPal or Venmo execution price. The CoinGecko public API can be used without a key subject to its public rate limits; `COINGECKO_DEMO_API_KEY` is optional.

## Start locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000` for the public homepage or `http://localhost:3000/dashboard` for the market workspace. A product query such as `/dashboard?q=headphones` opens Discover with the phrase filled in; it does not run the search automatically. Set `CHANNEL3_API_KEY` in `.env.local` to enable product search. Provider credentials are read only on the server and are not included in the browser bundle. Add `COINGECKO_DEMO_API_KEY` only if you have a CoinGecko Demo key.

The app reads Channel3 locale settings from `CHANNEL3_LANGUAGE`, `CHANNEL3_COUNTRY`, and `CHANNEL3_CURRENCY`. Product search checks the request origin, uses a process-local limit of eight searches per minute, and does not cache provider results. The current limiter is per process and still needs a trusted client address and shared store before multi-instance production use.

## Postman collections

- `postman/collections/Channel3 Marketplace` covers product search, retailer/brand/category browsing, similar products, product details, URL lookup, and product price history.
- `postman/collections/PayPal Market APIs` covers the local crypto market, Channel3 search, and service health endpoint.
- `postman/environments/Channel3.environment.yaml` has an empty secret field. Add the Channel3 key locally in Postman; do not commit it. The app's `.env.local` does not automatically populate Postman.

OpenAPI contracts are in `postman/specs/`. These files and collections are local; they have not been pushed to a Postman cloud workspace.

## Providers and boundaries

- CoinGecko supplies broad market metrics and historical price series.
- Channel3 supplies product discovery and retailer offers. It does not replace Venmo and its public developer page currently marks programmatic checkout as coming soon.
- Product collections are currently stored only in the customer's browser; a Channel3-hosted list or cross-device sync is not implemented.
- Venmo remains the customer wallet/payment surface. This prototype does not import wallet balances or initiate crypto trades.
- The legacy agent chat, wallet, and checkout routes are retired. The PayPal webhook verifies deliveries and acknowledges them without crediting balances or issuing payouts. Payment flows should remain disabled until they have authenticated ownership, durable order mapping, and idempotent event processing.
- Zapier MCP onboarding has run in read-only mode with Google Calendar and GitHub; calendar writes, AI payments, subscriptions, and other agent actions remain deferred.
- A Render Blueprint is prepared, but no cloud service or public URL exists yet. Elastic Observability and the separate restricted Kernel agent account are not integrated.

`CHANNEL3_COLLECTION_ID` is app-specific configuration. Channel3's public browse API accepts brand, category, or retailer filters instead of a generic collection ID; the Postman collection documents those supported requests.

## Render and PayPal webhooks

The Render Blueprint is in `render.yaml`. After deployment, set the PayPal webhook URL to `https://<service-host>/api/webhooks/paypal` and add PayPal's webhook ID to the Render service environment. The endpoint verifies and acknowledges valid deliveries; it does not process payments. The free Render plan is for previews only because services can sleep and local files are ephemeral.

## Commands

```bash
npm run lint
npx tsc --noEmit
```

The Bryntum Scheduler trial bundle is kept outside the app's compile and lint inputs until its license and intended integration are settled. AG Grid Enterprise and AG Charts are installed; set `NEXT_PUBLIC_AG_GRID_LICENSE` for the Business workspace at build time.
