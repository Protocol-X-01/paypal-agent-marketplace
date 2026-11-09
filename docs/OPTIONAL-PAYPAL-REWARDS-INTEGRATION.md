# Optional PayPal rewards integration

PayPal+ is not part of the current customer navigation or Shop experience. The screenshots inform the product's visual direction; they do not imply account access or rewards support.

The parked guide components are presentation-only. They do not connect to PayPal, read balances, or redeem points. Keep them out of the customer flow unless PayPal approves the feature and supplies a supported integration path.

## Enable only after approval

1. Confirm an official PayPal API or partnership contract for the intended rewards data and environments.
2. Document the required OAuth scopes, consent screen, allowed regions, and exact data fields.
3. Implement a provider adapter on the server. Keep tokens out of the client and request only fields needed for the approved feature.
4. Gate the feature behind an explicit configuration flag and customer consent; default it off.
5. Reuse the parked guide components only after replacing their static copy with provider-backed states and clear unavailable/error handling.
6. Keep PayPal points, Channel3 affiliate commissions, and customer cashback clearly separate in labels and calculations.

No connection should be inferred from the current UI, PayPal credentials, webhook configuration, or a customer choosing a PayPal account type.
