/** Shopping storefront preference; separate from a portfolio display currency. */
export const STOREFRONT_STORAGE_KEY = "paypal-markets-storefront-v1";
export type Storefront = "GB" | "US";

export function isStorefront(value: unknown): value is Storefront {
  return value === "GB" || value === "US";
}

export function storefrontCurrency(storefront: Storefront): "GBP" | "USD" {
  return storefront === "GB" ? "GBP" : "USD";
}
