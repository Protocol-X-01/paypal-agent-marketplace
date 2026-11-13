import { isUsableProductId, marketplaceImages, MAX_PRODUCT_ID_LENGTH, safeMarketplaceOfferUrl, safeMarketplaceUrl } from "./marketplace-safety";
import { readSavedStorefront } from "./storefront-storage";

export const MAX_COLLECTIONS = 12;
export const MAX_ITEMS = 40;
export const MAX_COLLECTION_NAME_LENGTH = 40;
const MAX_COLLECTION_ID_LENGTH = 120;

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
  brand: string | null;
  description: string | null;
  // Existing saved images remain inert JSON until validated for display.
  images: unknown;
  offers: Offer[];
};
export type SavedItem = { product: Product; retrievedAt: string; savedAt: string; storefront: string | null; identitySource?: "complete-id-v1" };
export type ShoppingCollection = { id: string; name: string; createdAt: string; items: SavedItem[] };

// Preserve each original saved item when lists are edited or moved. Its raw
// fields remain inert: the displayed product always uses the sanitized view.
const storedItemSnapshots = new WeakMap<SavedItem, unknown>();

export function needsSavedIdentityReview(item: SavedItem): boolean {
  return item.product.id.length === MAX_PRODUCT_ID_LENGTH && item.identitySource !== "complete-id-v1";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsableCollectionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_COLLECTION_ID_LENGTH && value.trim().length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value);
}

export function parseProduct(value: unknown, expectedCurrency?: string, preserveSavedImages = false): Product | null {
  if (!record(value) || !isUsableProductId(value.id) || typeof value.title !== "string" || !value.title) return null;
  const suppliedBrand = typeof value.brand === "string" ? value.brand : Array.isArray(value.brands)
    ? value.brands.slice(0, 12).find((item) => record(item) && typeof item.name === "string" && item.name.trim())?.name
    : null;
  const brand = typeof suppliedBrand === "string"
    ? suppliedBrand.trim().replace(/[\p{Cc}\p{Cs}]+/gu, " ").replace(/\s+/g, " ").slice(0, 80) || null
    : null;
  const offers: Offer[] = Array.isArray(value.offers) ? value.offers.slice(0, 30).flatMap((offer) => {
    if (!record(offer) || !record(offer.price)) return [];
    const candidateUrl = safeMarketplaceUrl(offer.url);
    const host = candidateUrl ? new URL(candidateUrl).hostname.replace(/^www\./, "").replace(/\.$/, "") : null;
    const suppliedDomain = typeof offer.domain === "string" && /^[a-z0-9.-]{1,253}$/i.test(offer.domain) && safeMarketplaceUrl(`https://${offer.domain}`)
      ? offer.domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
      : null;
    // Display metadata never authorizes a URL or identifies an exact offer.
    const domain = suppliedDomain ?? host;
    const price = offer.price.price;
    const currency = offer.price.currency;
    if (!domain || typeof price !== "number" || !Number.isFinite(price) || price < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || (expectedCurrency && currency !== expectedCurrency)) return [];
    if (offer.availability !== "InStock" && offer.availability !== "OutOfStock") return [];
    return [{ url: safeMarketplaceOfferUrl(candidateUrl, domain), domain, availability: offer.availability, max_commission_rate: typeof offer.max_commission_rate === 'number' && Number.isFinite(offer.max_commission_rate) && offer.max_commission_rate >= 0 && offer.max_commission_rate <= 1 ? offer.max_commission_rate : null, price: { price, currency, compare_at_price: null } }];
  }) : [];
  const images = preserveSavedImages && Object.prototype.hasOwnProperty.call(value, "images")
    ? value.images
    : marketplaceImages(value.images);
  return { id: value.id, title: value.title.slice(0, 300), brand, description: typeof value.description === "string" ? value.description.slice(0, 1000) : null, images, offers };
}

export function snapshotProduct(product: Product): Product {
  return { ...product, offers: product.offers.map((offer) => ({ ...offer, url: null, max_commission_rate: null })) };
}

export function readCollections(raw: string | null): ShoppingCollection[] {
  if (raw === null) return [];
  if (!raw) throw new Error("Saved collections need recovery.");
  if (raw.length > 3_000_000) throw new Error("Saved collections need recovery.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Saved collections need recovery."); }
  if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.collections)) throw new Error("Saved collections need recovery.");
  if (Object.keys(parsed).some((key) => key !== "version" && key !== "collections")) throw new Error("Saved collections need recovery.");
  // Inspect every stored row before materialization. A later edit must never
  // silently discard a hidden, malformed, duplicated, or oversized record.
  const storedListIds = new Set<string>();
  let needsRecovery = parsed.collections.length > MAX_COLLECTIONS;
  for (const [listIndex, list] of parsed.collections.entries()) {
    // Never collapse opaque list IDs to a common prefix or silently discard
    // duplicate IDs during a later edit, including entries outside the view.
    if (!record(list)) { needsRecovery = true; continue; }
    if (!isUsableCollectionId(list.id) || storedListIds.has(list.id)) {
      throw new Error("A saved collection identifier needs recovery.");
    }
    storedListIds.add(list.id);
    const validListName = typeof list.name === "string" && Boolean(list.name.trim()) && list.name.length <= MAX_COLLECTION_NAME_LENGTH;
    if (!validListName || (list.createdAt !== undefined && typeof list.createdAt !== "string") || !Array.isArray(list.items)) needsRecovery = true;
    if (!Array.isArray(list.items)) continue;
    if (list.items.length > MAX_ITEMS) needsRecovery = true;
    const visibleList = listIndex < MAX_COLLECTIONS && validListName;
    const storedProductIds = new Set<string>();
    for (const [itemIndex, item] of list.items.entries()) {
      if (!record(item) || !record(item.product)) { needsRecovery = true; continue; }
      const product = item.product;
      if (!isUsableProductId(product.id)) throw new Error("A saved product identifier needs recovery.");
      if (storedProductIds.has(product.id)) needsRecovery = true;
      storedProductIds.add(product.id);
      if (typeof product.title !== "string" || !product.title) needsRecovery = true;
      if (product.id.length === MAX_PRODUCT_ID_LENGTH && (
        !visibleList || itemIndex >= MAX_ITEMS || typeof product.title !== "string" || !product.title
      )) throw new Error("A saved product identifier needs recovery.");
    }
  }
  if (needsRecovery) throw new Error("Saved collections need recovery.");
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
      const saved: SavedItem = { product: snapshotProduct(product), retrievedAt: typeof item.retrievedAt === "string" ? item.retrievedAt : "", savedAt: typeof item.savedAt === "string" ? item.savedAt : "", storefront: readSavedStorefront(item.storefront), ...(item.identitySource === "complete-id-v1" ? { identitySource: "complete-id-v1" } : {}) };
      storedItemSnapshots.set(saved, item);
      return [saved];
    });
    return [{ ...list, id: list.id, name: list.name, createdAt: typeof list.createdAt === "string" ? list.createdAt : "", items }];
  });
}

export function serializeCollections(collections: ShoppingCollection[]): string {
  return JSON.stringify({ version: 1, collections: collections.map((list) => ({
    ...list,
    items: list.items.map((item) => storedItemSnapshots.get(item) ?? item),
  })) });
}
