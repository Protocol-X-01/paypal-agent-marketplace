# Kernel agent account policy

**Status:** design only; no Kernel account is connected to this application.
**Reviewed:** 9 November 2026

## Wallet and account boundary

Venmo remains the customer’s wallet and payment surface. The user clarified that any future Kernel smart account in this app is separate and agent-only; this app does not need a second customer-owned Kernel wallet or a MetaMask connection. PayPal Markets is currently a market-information and product-discovery companion; it does not trade crypto, move funds, or connect to a customer’s wallet.

If a future agent action needs an on-chain account, it must use a separate Kernel smart account owned for that agent capability. It must not be a mirror of the customer’s Venmo balance or a means of accessing customer-held assets. No customer-owned Kernel account is planned, connected or assumed.

The current codebase has no ZeroDev SDK integration or Kernel transaction route. The empty `KERNEL_API_KEY` example is a provider-credential placeholder, not a signer, wallet key, or permission grant. This document records an intended boundary; it does not prove a provider account, key, policy, or account has been created.

## Current allowed capability

The existing optional market-insight route accepts only a supported asset, display currency, and chart range, then derives bounded public CoinGecko OHLC facts for analysis. It does not require Kernel or include holdings, contacts, or merchant activity. The application does not connect or verify a Kernel signer/session key, account, permissions, or funded balance; provider-side account and funding state have not been inspected. Until a separate action is designed and approved, the application grants the agent:

- no connected signing key or session key;
- no connected Kernel account or on-chain permissions;
- no verified Kernel-funded balance;
- no permission to call contracts, transfer tokens, pay gas, or submit user operations;
- no access to Venmo, PayPal customer balances, contacts, or merchant transactions.

This is a deny-by-default design target, not an inspected live Kernel policy.

## Future PayPal merchant purchase direction

The user suggested considering PYUSD as the only agent payment asset and PayPal-supported merchants as the purchase destination, with Channel3 as a discovery source. Treat that as a candidate product boundary, not spending authorization or proof that any listed offer can be paid with PayPal or PYUSD. Channel3 supplies product discovery and affiliate-tracked retailer links; a catalog listing does not establish checkout eligibility, a PayPal payment API, merchant consent, or an agent purchase method.

Before adding a purchase action, verify the exact retailer and product, that retailer’s PayPal checkout and PYUSD availability for the selected region, the payment contract and network, quote and conversion fees, refund/cancellation behavior, and Channel3 attribution terms. Refresh the offer before presenting it, display the full amount and destination, require the user’s confirmation for every purchase, then record a durable order/action result. Do not authorize subscriptions, recurring charges, transfers, arbitrary token approvals, or another asset by implication.

## Future permission design

ZeroDev documents Kernel permissions as a signer combined with policies and an execution action. Its documented policy types include contract/function call limits, gas limits, rate limits, and validity windows. Any future agent permission must be expressed in the account’s enforced permissions, not only in application UI checks. See [Kernel permission plugins](https://docs.zerodev.app/smart-accounts/permissions/intro) and [ZeroDev session keys](https://docs.zerodev.app/smart-accounts/permissions/session-keys).

Before any agent transaction is considered, the design must define and independently enforce:

1. one named, narrow user-approved use case and the network it requires;
2. the exact contract, function selectors, asset, recipient rules, and calldata fields allowed;
3. explicit per-action, daily, and lifetime spend limits, all zero until chosen and approved; do not assume Kernel's per-call value bound or UserOperation-count rate limit is an aggregate daily or lifetime token budget;
4. a short permission validity window, UserOperation-rate limit, and bounded gas policy;
5. a human-readable preview of asset, amount, recipient, network, and effect, followed by explicit human confirmation before every transaction;
6. replay-safe operation IDs, durable action history, failure handling, and an owner-controlled revocation path;
7. separate user ownership and agent credentials, with no broad owner/sudo signer held by the service.

If the user later considers autonomous transactions without per-transaction confirmation, that is a separate product and security decision requiring explicit opt-in and its own narrowly defined action scope, aggregate limits, and review. No such autonomy is approved here.

The agent must not receive arbitrary contract execution, unrestricted delegate calls, token approvals, bridge access, open-ended subscriptions, or authority to change its own permissions. A denied, expired, ambiguous, or unverifiable action must fail closed without retrying a different transaction.

## Explicitly deferred

AI payments, subscription creation or cancellation, checkout, contact payments, automatic transfers, wallet funding, and any mainnet execution remain disabled until that work is scheduled and the concrete provider, account binding, and policy are approved. PYUSD-only is a suggested constraint, not a final asset/network selection. Zapier calendar or GitHub credentials do not grant Kernel authority.

## Readiness gates

Do not connect the provider or create an account until all of these are true:

- the exact agent action, owner, chain, asset, destination, and limits are approved;
- the current ZeroDev SDK version and official chain-specific documentation are reviewed;
- signing material has an approved custody and recovery design outside source control and chat;
- the deployed on-chain permission is inspected against the approved policy, including exact call/value bounds, gas and expiry controls, plus any separately implemented aggregate-budget enforcement;
- local policy tests and a test-network transaction review are complete;
- revocation, audit retention, monitoring, user consent, and incident ownership are documented;
- the user explicitly approves any funding or mainnet use.

Until then, leave `KERNEL_API_KEY` unused and keep Venmo as the human payment surface.
