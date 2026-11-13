/** Shopping storefront preference; separate from a portfolio display currency. */
export const STOREFRONT_STORAGE_KEY = "paypal-markets-storefront-v1";
export type Storefront = "GB" | "US";

export function isStorefront(value: unknown): value is Storefront {
  return value === "GB" || value === "US";
}

export function storefrontCurrency(storefront: Storefront): "GBP" | "USD" {
  return storefront === "GB" ? "GBP" : "USD";
}

const COUNTRY_DOMAIN_SUFFIXES: readonly { suffix: string; country: string }[] = [
  { suffix: "co.uk", country: "GB" }, { suffix: "uk", country: "GB" },
  { suffix: "us", country: "US" }, { suffix: "ca", country: "CA" },
  { suffix: "au", country: "AU" }, { suffix: "ie", country: "IE" },
  { suffix: "de", country: "DE" }, { suffix: "at", country: "AT" },
  { suffix: "fr", country: "FR" }, { suffix: "be", country: "BE" },
  { suffix: "it", country: "IT" }, { suffix: "es", country: "ES" },
  { suffix: "nl", country: "NL" }, { suffix: "se", country: "SE" },
  { suffix: "fi", country: "FI" }, { suffix: "pt", country: "PT" },
  { suffix: "cz", country: "CZ" }, { suffix: "gr", country: "GR" },
  { suffix: "ro", country: "RO" },
];

// Channel3 does not provide shipping-region metadata. These curated retailer
// hosts are explicitly US storefronts, so keep them out of the GB storefront.
const KNOWN_RETAILER_HOSTS: readonly { host: string; country: string }[] = [
  { host: "target.com", country: "US" },
  { host: "cvs.com", country: "US" },
  { host: "walmart.com", country: "US" },
  { host: "bestbuy.com", country: "US" },
];

// Official US retailer policy pages reviewed on 10 November 2026. This is a
// retailer-level signal only; Channel3 does not identify the final seller or
// item-level checkout eligibility. Target Plus and other order exceptions apply.
const US_PAYPAL_LISTED_RETAILERS = new Set([
  "abt.com", "bestbuy.com", "bhphotovideo.com", "campsaver.com", "crutchfield.com",
  "macys.com", "newegg.com", "publiclands.com", "scheels.com", "selfridges.com",
  "sweetwater.com", "target.com", "walmart.com", "worldwidestereo.com",
]);

/**
 * Hide offers whose recognized country-coded or explicitly mapped retailer
 * domain conflicts with the selected storefront. Other generic domains stay
 * unclassified because Channel3 supplies no merchant-region field.
 */
export function isChannel3DomainForStorefront(domain: unknown, storefront: string): boolean {
  if (typeof domain !== "string") return false;
  const host = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return false;
  const knownRetailer = KNOWN_RETAILER_HOSTS.find(({ host: retailerHost }) => host === retailerHost || host.endsWith(`.${retailerHost}`));
  if (knownRetailer) return knownRetailer.country === storefront;
  const match = COUNTRY_DOMAIN_SUFFIXES.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`));
  return !match || match.country === storefront;
}

/** True only where the US retailer's public policy lists PayPal for eligible orders. */
export function isPayPalListedAtRetailer(domain: unknown, storefront: string): boolean {
  if (storefront !== "US" || typeof domain !== "string") return false;
  const host = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return false;
  return [...US_PAYPAL_LISTED_RETAILERS].some((retailerHost) => host === retailerHost || host.endsWith(`.${retailerHost}`));
}

/**
 * Rank an eligible offer's domain by how strongly its host identifies the
 * requested storefront. Generic domains remain eligible but unclassified.
 */
export function channel3StorefrontDomainPriority(domain: unknown, storefront: string): number {
  if (typeof domain !== "string") return 0;
  const host = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return 0;
  const knownRetailer = KNOWN_RETAILER_HOSTS.find(({ host: retailerHost }) => host === retailerHost || host.endsWith(`.${retailerHost}`));
  if (knownRetailer) return knownRetailer.country === storefront ? 2 : 0;
  const match = COUNTRY_DOMAIN_SUFFIXES.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`));
  return match?.country === storefront ? 1 : 0;
}
