import { marketplaceImages, safeMarketplaceUrl } from "./marketplace-safety";
import { readSavedStorefront } from "./storefront-storage";

export const MAX_COLLECTIONS = 12;
export const MAX_ITEMS = 40;

export type Offer = {
  max_commission_rate?: number | null;
  url: string | null;
  domain: string;
  availability: "InStock" | "OutOfStock";
  price: { price: number; compare_at_price: number | null; currency: string };
};
export type Product = {
  id: string;
  title: string;
  description: string | null;
  // Existing saved images remain inert JSON until validated for display.
  images: unknown;
  offers: Offer[];
};
export type SavedItem = { product: Product; retrievedAt: string; savedAt: string; storefront: string | null };
export type ShoppingCollection = { id: string; name: string; createdAt: string; items: SavedItem[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProduct(value: unknown, expectedCurrency?: string, preserveSavedImages = false): Product | null {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || !value.title) return null;
  const offers: Offer[] = Array.isArray(value.offers) ? value.offers.slice(0, 30).flatMap((offer) => {
    if (!record(offer) || !record(offer.price)) return [];
    const url = safeMarketplaceUrl(offer.url);
    const host = url ? new URL(url).hostname.replace(/^www\./, "").replace(/\.$/, "") : null;
    const suppliedDomain = typeof offer.domain === "string" && /^[a-z0-9.-]{1,253}$/i.test(offer.domain) && safeMarketplaceUrl(`https://${offer.domain}`)
      ? offer.domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
      : null;
    // Display metadata never authorizes a URL or identifies an exact offer.
    const domain = suppliedDomain ?? host;
    const price = offer.price.price;
    const currency = offer.price.currency;
    if (!domain || typeof price !== "number" || !Number.isFinite(price) || price < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || (expectedCurrency && currency !== expectedCurrency)) return [];
    if (offer.availability !== "InStock" && offer.availability !== "OutOfStock") return [];
    return [{ url, domain, availability: offer.availability, max_commission_rate: typeof offer.max_commission_rate === 'number' && Number.isFinite(offer.max_commission_rate) && offer.max_commission_rate >= 0 && offer.max_commission_rate <= 1 ? offer.max_commission_rate : null, price: { price, currency, compare_at_price: null } }];
  }) : [];
  const images = preserveSavedImages && Object.prototype.hasOwnProperty.call(value, "images")
    ? value.images
    : marketplaceImages(value.images);
  return { id: value.id.slice(0, 300), title: value.title.slice(0, 300), description: typeof value.description === "string" ? value.description.slice(0, 1000) : null, images, offers };
}

export function snapshotProduct(product: Product): Product {
  return { ...product, offers: product.offers.map((offer) => ({ ...offer, url: null, max_commission_rate: null })) };
}

export function readCollections(raw: string | null): ShoppingCollection[] {
  if (!raw) return [];
  if (raw.length > 3_000_000) throw new Error("Stored collections are too large to load.");
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.collections)) throw new Error("Saved collections use an unsupported format.");
  const seen = new Set<string>();
  return parsed.collections.slice(0, MAX_COLLECTIONS).flatMap((list) => {
    if (!record(list) || typeof list.id !== "string" || seen.has(list.id) || typeof list.name !== "string" || !list.name.trim() || !Array.isArray(list.items)) return [];
    seen.add(list.id);
    const productIds = new Set<string>();
    const items: SavedItem[] = list.items.slice(0, MAX_ITEMS).flatMap((item) => {
      if (!record(item)) return [];
      const product = parseProduct(item.product, undefined, true);
      if (!product || productIds.has(product.id)) return [];
      productIds.add(product.id);
      return [{ product: snapshotProduct(product), retrievedAt: typeof item.retrievedAt === "string" ? item.retrievedAt : "", savedAt: typeof item.savedAt === "string" ? item.savedAt : "", storefront: readSavedStorefront(item.storefront) }];
    });
    return [{ id: list.id.slice(0, 120), name: list.name.trim().slice(0, 40), createdAt: typeof list.createdAt === "string" ? list.createdAt : "", items }];
  });
}
