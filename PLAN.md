# PayPal Agent Marketplace — Living Spec

## Current direction — 2026-11-03

The original agent-led commerce concept below is historical context. The current user direction is a mobile-first PayPal companion for clearer cryptocurrency prices, market metrics, charts, a manual portfolio estimate, and Channel3 product discovery. Venmo remains the customer's wallet and payment surface. Portfolio quantities are manually entered and stored on the device; this app does not connect to a wallet or execute crypto trades. Channel3 is used for discovery and retailer offers, with checkout remaining at the retailer. Elastic monitoring, a restricted Kernel agent account, Zapier MCP, and Render are not yet wired into this dashboard.

> PayPal AI Hackathon (deadline **Nov 12, 2026 12:00pm PST**) — $67,500 prize pool, ~26,400 participants.
> Requirement: meaningfully integrate **PayPal developer platform (sandbox)** + **AI**.

## One-liner

A PayPal-native consumer marketplace where humans sell, AI agents shop — agents are first-class customers that receive **allowances**, hold wallets, negotiate, manage subscriptions to things they use, and transact entirely on PayPal rails. eBay was PayPal's first parent; this is the consumer destination rebuilt for the agent era.

Judge line: **"PayPal built allowances for humans. We built allowances for agents."**

## Pillars

1. **Human sellers, list-by-photo** — seller uploads a photo; agent identifies the product via **Channel3** (search/comps against live retail data), auto-drafts listing (title, attributes, hero image) and suggests an asking price from real comps.
2. **Agent sellers** — AI storefronts with standing inventory, autonomous haggling, restock plans (Subscriptions).
3. **Agent buyers on allowances** — agents are the marketplace's most active customers: they get a recurring allowance (funded by a *real PayPal Subscription*), hold an in-app wallet, pay via real Orders v2 checkout, and can resell holdings.
4. **Approval gates** — spend policy per agent (autopilot under threshold, human approval above). Centerpiece UX beat.
5. **Trust fabric** — disputes via Disputes API, shipping via Tracking, all settlement ephemeral-sandbox-real.

## Rail mapping (sandbox, everything real)

| Capability | PayPal product (sandbox) | Notes |
|---|---|---|
| Allowance funding (recurring) | Subscriptions (Product → Plan → Subscription) | `PAYMENT.SALE.COMPLETED` / `BILLING.SUBSCRIPTION.*` webhooks credit agent wallet ledger. Verify exact event names at build time. |
| One-off top-up | Orders v2 + JS SDK checkout | buyer(person) → marketplace(merchant) |
| Agent purchase | Orders v2 (`ORDER_COMPLETE_ON_PAYMENT_APPROVAL`) | agent checkout w/ JS SDK |
| Seller payout | Payouts API (`/v1/payments/payouts`) | fires instantly in sandbox |
| Agent earns / sells | Payouts + Orders | |
| Buyer protection | Disputes API | demo beat: one scripted dispute |
| Shipping | Order Tracking | after capture |
| Merchant-side natural language | `@paypal/mcp` / agent-toolkit | orders, invoices, subscriptions, disputes, tracking, transactions |
| Product data | **Channel3 API/MCP** (promo `PAYPAL-HACKATHON-2026`, 20k credits) | listing enrichment + comps pricing + agent-buyer search |

Wallet = internal double-entry ledger (SQLite) keyed to real PayPal events; README documents this honesty-note.

## Demo — 3 beats, < 3 min video

1. **Allowance moment** — user creates $50/mo allowance subscription for their agent ("Nova"); webhook credits wallet live; policy screen: autopilot ≤ $25, ask above.
2. **The purchase** — Nova (agent buyer) searches via Channel3, haggles with an agent-seller's bot, crosses the approval threshold → paused with human tap-to-approve → pays → `PAYMENT.CAPTURE.COMPLETED` → seller agent auto-payout fires.
3. **Burn & budget cop** — Nova's dashboard shows burn vs allowance; catches a subscription price hike ($19→$24) on another plan, pauses it, sources cheaper replacement via Channel3. (Sells surplus listing to stay under allowance if time.)

## Special prizes targeted

- **Best Use of Agentic Commerce** ($5k) — agents transacting with wallets + approval gates.
- **Best Use of Channel3** ($1,500) — enrichment + comps at listing AND agent-buyer search. Must *call* API, not reference.
- Optional low-cost adds: Bryntum scheduler (agent restock calendar), AG Grid (ledger/burn dashboard), Render hosting credits.

## Sandbox setup checklist

1. developer.paypal.com → create app (client id/secret, sandbox).
2. Two personas minimum: `acct+buyer`, `acct+seller-agent` at sandbox.paypal.com.
3. Enable products in sandbox merchant: Orders, **Subscriptions** (Products & Plans → set up subscription products), Payouts, Disputes.
4. Sandbox webhooks registered (ngrok or similar listener): `PAYMENT.SALE.COMPLETED`, `BILLING.SUBSCRIPTION.*`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CHECKOUT.ORDER.APPROVED`.
5. JS SDK integration `<script src="https://www.paypal.com/sdk/js?client-id=...&components=buttons">` in env `sandbox`.
6. Channel3 key at trychannel3.com/developers + promo code; note rate/credits.
7. Install `@paypal/mcp` (`PAYPAL_ENVIRONMENT=SANDBOX`) — wire into agent runtime with constrained tool allowlist.

## Scope guard (cut after 3 beats; README roadmap only)

NO self-custody keys, NO on-chain flows in core demo, NO fiat off-ramp simulators, NO investment/portfolio features (corrected → allowances). Everything else: "roadmap" section.

## Timeline (11 days)

- D1: repo scaffold, sandbox+Channel3 accounts, webhooks plumbing.
- D2-3: Orders v2 checkout end-to-end + ledger.
- D4-5: Subscriptions allowance flow + webhook crediting + policy gate UI.
- D6: Agent runtime (OpenAI Agents SDK or Vercel AI SDK) + PayPal MCP + Channel3 tools.
- D7: Agent-seller inventory + haggle loop + Channel3 listing-by-photo enrichment.
- D8: Disputes/tracking sprinkle + burn dashboard.
- D9: Render deploy, seed data, demo hardening.
- D10: Video (<3min), README, license file.
- D11 (Nov 12): buffer + submit.

## Submission checklist (hard requirements)

- Public repo (GitHub/GitLab/Bitbucket) w/ license file visible in About.
- All source + run instructions, or hosted demo URL (judges must be able to run/interact).
- Tools list: which model/AI service and how used.
- Demo video < 3 min, YouTube public, linked in form.
- No third-party trademarks/copyrighted music.
- Meaningful PayPal integration + meaningful AI (non-negotiable judges' criteria).
