import AsyncStorage from '@react-native-async-storage/async-storage';

import { CHANNEL3_CURATED_SECTIONS, CHANNEL3_CURATED_RETAILERS } from './channel3-shelves';
import { createCustomerStorageFence } from './customer-storage-scope';
import { safeChannel3Url, selectChannel3Image } from './channel3-url';
import { getApiBaseUrl } from './market';
import { isShopStorefront, SHOP_STOREFRONTS, type ShopStorefront } from './shop-storefront';

export const CHANNEL3_COLLECTIONS_KEY = 'paypal-markets.mobile.channel3-collections.v1';
export const MAX_COLLECTIONS = 12;
export const MAX_PRODUCTS_PER_COLLECTION = 30;
export const MAX_COLLECTION_NAME_LENGTH = 40;

const MAX_COLLECTIONS_BYTES = 500_000;

export interface Channel3Offer {
  url: string;
  domain: string;
  price: number;
  currency: string;
  availability: 'InStock' | 'OutOfStock' | 'unknown';
  maxCommissionRate: number | null;
}

export interface Channel3Product {
  id: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  offers: Channel3Offer[];
  retrievedAt: string;
}

export interface Channel3PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

export interface Channel3Search {
  query: string;
  storefront: ShopStorefront;
  currency: 'GBP' | 'USD';
  priceRange: Channel3PriceRange | null;
  retrievedAt: string;
  products: Channel3Product[];
  nextPageToken: string | null;
}

export type Channel3CatalogSection = (typeof CHANNEL3_CURATED_SECTIONS)[number]['id'];
export type Channel3CatalogRetailer = (typeof CHANNEL3_CURATED_RETAILERS)[number]['id'];

export interface Channel3Catalog {
  section: Channel3CatalogSection | null;
  retailer: Channel3CatalogRetailer | null;
  nextPageToken: string | null;
  limit: number;
  title: string;
  storefront: ShopStorefront;
  currency: 'GBP' | 'USD';
  retrievedAt: string;
  products: Channel3Product[];
}

export interface SavedProduct {
  id: string;
  title: string;
  brand: string | null;
  savedAt: string;
  storefront?: ShopStorefront;
  lastSeenPrice?: {
    amount: number;
    currency: 'GBP' | 'USD';
    observedAt: string;
  };
}

export interface ShoppingCollection {
  id: string;
  name: string;
  items: SavedProduct[];
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProductId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function parseOffer(value: unknown, expectedCurrency: 'GBP' | 'USD'): Channel3Offer | null {
  if (!isRecord(value) || !isRecord(value.price)) return null;
  const url = safeChannel3Url(value.url);
  const price = value.price.price;
  const currency = typeof value.price.currency === 'string' ? value.price.currency.toUpperCase() : '';
  if (!url || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || currency !== expectedCurrency) return null;

  // Bind the displayed retailer to the destination host. The Channel3 affiliate
  // host is the only supported case where the advertised retailer may differ.
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const supplied = typeof value.domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(value.domain)
    && safeChannel3Url(`https://${value.domain}`)
    ? value.domain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : null;
  const domain = supplied && (supplied === host || host === 'buy.trychannel3.com') ? supplied : host;

  const availability = value.availability === 'InStock' || value.availability === 'OutOfStock'
    ? value.availability
    : 'unknown';
  return { url, domain, price, currency, availability, maxCommissionRate: typeof value.max_commission_rate === 'number' && Number.isFinite(value.max_commission_rate) && value.max_commission_rate >= 0 && value.max_commission_rate <= 1 ? value.max_commission_rate : null };
}

function parseProduct(value: unknown, expectedCurrency: 'GBP' | 'USD', retrievedAt: string): Channel3Product | null {
  if (!isRecord(value) || !safeProductId(value.id) || typeof value.title !== 'string') return null;
  const title = value.title.trim().slice(0, 200);
  if (!title) return null;

  const brand = Array.isArray(value.brands)
    ? value.brands.find((item) => isRecord(item) && typeof item.name === 'string' && item.name.trim())
    : undefined;
  const offers = Array.isArray(value.offers)
    ? value.offers.slice(0, 12).flatMap((item) => {
        const offer = parseOffer(item, expectedCurrency);
        return offer ? [offer] : [];
      })
    : [];

  return {
    id: value.id,
    title,
    brand: brand && isRecord(brand) && typeof brand.name === 'string' ? brand.name.trim().slice(0, 80) : null,
    imageUrl: selectChannel3Image(value.images),
    offers,
    retrievedAt,
  };
}

function apiError(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.error === 'string') return payload.error.slice(0, 180);
  return fallback;
}

function parsePriceRange(value: unknown): Channel3PriceRange | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => key !== 'minPrice' && key !== 'maxPrice')) return undefined;
  const minPrice = value.minPrice;
  const maxPrice = value.maxPrice;
  if (minPrice !== undefined && (typeof minPrice !== 'number' || !Number.isFinite(minPrice) || minPrice < 0 || minPrice > 100_000_000)) return undefined;
  if (maxPrice !== undefined && (typeof maxPrice !== 'number' || !Number.isFinite(maxPrice) || maxPrice < 0 || maxPrice > 100_000_000)) return undefined;
  if (typeof minPrice === 'number' && typeof maxPrice === 'number' && minPrice > maxPrice) return undefined;
  return { ...(typeof minPrice === 'number' ? { minPrice } : {}), ...(typeof maxPrice === 'number' ? { maxPrice } : {}) };
}

export async function searchChannel3(queryValue: string, storefront: ShopStorefront, signal?: AbortSignal, options: { pageToken?: string; priceRange?: Channel3PriceRange } = {}): Promise<Channel3Search> {
  const query = queryValue.trim();
  if (query.length < 2 || query.length > 120) {
    throw new Error('Enter a search phrase between 2 and 120 characters.');
  }
  if (!isShopStorefront(storefront)) throw new Error('Choose a supported shop region.');
  if (options.pageToken !== undefined && (!options.pageToken || options.pageToken.length > 6144)) throw new Error('Restart this search to load more products.');

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/marketplace/search`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 24, storefront, ...(options.priceRange ? { priceRange: options.priceRange } : {}), ...(options.pageToken ? { pageToken: options.pageToken } : {}) }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 404) throw new Error('The shop service needs an update before regional search can load. Please try again later.');
    if (response.status === 429) throw new Error('Search is temporarily limited. Wait a minute, then try again.');
    if (response.status === 503) throw new Error('The product catalog is temporarily unavailable. Try again later.');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('The product catalog returned an unexpected response.');
    }

    if (!response.ok) {
      throw new Error(apiError(payload, 'The product catalog could not load this search.'));
    }

    if (isRecord(payload) && (payload.storefront === undefined || payload.currency === undefined)) {
      throw new Error('The shop service needs an update before regional search can load. Please try again later.');
    }

    const appliedPriceRange = isRecord(payload) && 'priceRange' in payload ? parsePriceRange(payload.priceRange) : undefined;
    if (
      !isRecord(payload) ||
      payload.provider !== 'Channel3' ||
      payload.query !== query ||
      payload.storefront !== storefront ||
      payload.currency !== SHOP_STOREFRONTS[storefront].currency ||
      typeof payload.retrievedAt !== 'string' || payload.retrievedAt.length > 64 || !Number.isFinite(Date.parse(payload.retrievedAt)) ||
      !Array.isArray(payload.products) ||
      appliedPriceRange === undefined ||
      (payload.nextPageToken !== undefined && payload.nextPageToken !== null && (typeof payload.nextPageToken !== 'string' || !payload.nextPageToken || payload.nextPageToken.length > 6144))
    ) {
      throw new Error('The product catalog returned an unexpected response.');
    }
    if (signal?.aborted) throw new Error('Product search cancelled.');

    return {
      query,
      storefront,
      currency: SHOP_STOREFRONTS[storefront].currency,
      priceRange: appliedPriceRange,
      retrievedAt: payload.retrievedAt,
      nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null,
      products: payload.products.slice(0, 24).flatMap((item) => {
        const product = parseProduct(item, SHOP_STOREFRONTS[storefront].currency, payload.retrievedAt as string);
        return product ? [product] : [];
      }),
    };
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error('Product search cancelled.');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The product search took too long. Check your connection and try again.');
    }
    if (error instanceof TypeError) throw new Error('Check your connection and try again.');
    throw error instanceof Error ? error : new Error('The product catalog is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchChannel3Catalog(section: Channel3CatalogSection | null, storefront: ShopStorefront, signal?: AbortSignal, options: { retailer?: Channel3CatalogRetailer | null; pageToken?: string } = {}): Promise<Channel3Catalog> {
  if (!isShopStorefront(storefront)) throw new Error('Choose a supported shop region.');
  const retailer = options.retailer ?? null;
  if ((!section && !retailer) || (section && !CHANNEL3_CURATED_SECTIONS.some(item => item.id === section)) || (retailer && !CHANNEL3_CURATED_RETAILERS.some(item => item.id === retailer))) throw new Error('Choose a category or retailer.');
  const params = new URLSearchParams({ storefront, limit: '24' });
  if (section) params.set('section', section);
  if (retailer) params.set('retailer', retailer);
  if (options.pageToken) params.set('pageToken', options.pageToken);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/marketplace/catalog?${params}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 404) {
      throw new Error('The shop service needs an update before curated picks can load. Please try again later.');
    }
    if (response.status === 429) throw new Error('Curated picks are temporarily limited. Wait a minute, then try again.');
    if (response.status === 503) throw new Error('Curated picks are temporarily unavailable. Try again later.');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('The curated catalog returned an unexpected response.');
    }

    if (!response.ok) {
      throw new Error(apiError(payload, 'The curated catalog could not load this section.'));
    }

    if (isRecord(payload) && (payload.storefront === undefined || payload.currency === undefined)) {
      throw new Error('The shop service needs an update before shopping regions can load. Please try again later.');
    }

    if (
      !isRecord(payload) ||
      payload.provider !== 'Channel3' ||
      payload.section !== section ||
      (payload.retailer ?? null) !== retailer ||
      (payload.limit !== undefined && payload.limit !== 24) ||
      (options.pageToken && (payload.retailer === undefined || payload.limit !== 24 || payload.nextPageToken === undefined)) ||
      (payload.nextPageToken !== undefined && payload.nextPageToken !== null && (typeof payload.nextPageToken !== 'string' || !payload.nextPageToken || payload.nextPageToken.length > 6144)) ||
      payload.storefront !== storefront ||
      payload.currency !== SHOP_STOREFRONTS[storefront].currency ||
      typeof payload.title !== 'string' ||
      !payload.title.trim() ||
      typeof payload.retrievedAt !== 'string' || payload.retrievedAt.length > 64 || !Number.isFinite(Date.parse(payload.retrievedAt)) ||
      !Array.isArray(payload.products)
    ) {
      throw new Error('The curated catalog returned an unexpected response.');
    }
    if (signal?.aborted) throw new Error('Curated catalog request cancelled.');

    return {
      section,
      retailer,
      limit: 24,
      nextPageToken: typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null,
      title: payload.title.trim().slice(0, 80),
      storefront,
      currency: SHOP_STOREFRONTS[storefront].currency,
      retrievedAt: payload.retrievedAt,
      products: payload.products.slice(0, 24).flatMap((item) => {
        const product = parseProduct(item, SHOP_STOREFRONTS[storefront].currency, payload.retrievedAt as string);
        return product ? [product] : [];
      }),
    };
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error('Curated catalog request cancelled.');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The curated catalog took too long to respond. Check your connection and try again.');
    }
    if (error instanceof TypeError) throw new Error('Check your connection and try again.');
    throw error instanceof Error ? error : new Error('Curated picks are temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function validateCollections(value: unknown): ShoppingCollection[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.collections) || value.collections.length > MAX_COLLECTIONS) {
    throw new Error('Saved collections use an unsupported format. Existing device data was left unchanged.');
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  return value.collections.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' || candidate.id.length < 1 || candidate.id.length > 64 ||
      typeof candidate.name !== 'string' || candidate.name.trim().length < 1 || candidate.name.length > MAX_COLLECTION_NAME_LENGTH ||
      !Array.isArray(candidate.items) || candidate.items.length > MAX_PRODUCTS_PER_COLLECTION ||
      typeof candidate.updatedAt !== 'string' || candidate.updatedAt.length > 64
    ) {
      throw new Error('Saved collections could not be read safely. Existing device data was left unchanged.');
    }

    const normalizedName = candidate.name.trim().toLocaleLowerCase();
    if (ids.has(candidate.id) || names.has(normalizedName)) {
      throw new Error('Saved collections contain duplicate names or IDs. Existing device data was left unchanged.');
    }
    ids.add(candidate.id);
    names.add(normalizedName);

    const itemIds = new Set<string>();
    const items = candidate.items.map((item): SavedProduct => {
      if (
        !isRecord(item) || !safeProductId(item.id) ||
        typeof item.title !== 'string' || item.title.trim().length < 1 || item.title.length > 200 ||
        (item.brand !== null && (typeof item.brand !== 'string' || item.brand.length > 80)) ||
        (item.storefront !== undefined && !isShopStorefront(item.storefront)) ||
        (item.lastSeenPrice !== undefined && (
          !isRecord(item.lastSeenPrice) ||
          typeof item.lastSeenPrice.amount !== 'number' || !Number.isFinite(item.lastSeenPrice.amount) || item.lastSeenPrice.amount < 0 || item.lastSeenPrice.amount > 100_000_000 ||
          (item.lastSeenPrice.currency !== 'GBP' && item.lastSeenPrice.currency !== 'USD') ||
          typeof item.lastSeenPrice.observedAt !== 'string' || item.lastSeenPrice.observedAt.length > 64 || !Number.isFinite(Date.parse(item.lastSeenPrice.observedAt)) ||
          (isShopStorefront(item.storefront) && item.lastSeenPrice.currency !== SHOP_STOREFRONTS[item.storefront].currency)
        )) ||
        typeof item.savedAt !== 'string' || item.savedAt.length > 64 || itemIds.has(item.id)
      ) {
        throw new Error('Saved products could not be read safely. Existing device data was left unchanged.');
      }
      itemIds.add(item.id);
      // Keep only a small price snapshot for display; retailer URLs and full offers never persist.
      return {
        id: item.id,
        title: item.title.trim(),
        brand: typeof item.brand === 'string' ? item.brand.slice(0, 80) : null,
        savedAt: item.savedAt,
        ...(isShopStorefront(item.storefront) ? { storefront: item.storefront } : {}),
        ...(isRecord(item.lastSeenPrice) ? {
          lastSeenPrice: {
            amount: item.lastSeenPrice.amount as number,
            currency: item.lastSeenPrice.currency as 'GBP' | 'USD',
            observedAt: item.lastSeenPrice.observedAt as string,
          },
        } : {}),
      };
    });

    return { id: candidate.id, name: candidate.name.trim(), items, updatedAt: candidate.updatedAt };
  });
}

function parseCollectionsSnapshot(raw: string | null): ShoppingCollection[] {
  if (raw === null) return [];
  if (raw.length > MAX_COLLECTIONS_BYTES) {
    throw new Error('Saved collections are too large to load. Existing device data was left unchanged.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved collections are damaged. Existing device data was left unchanged.');
  }
  return validateCollections(parsed);
}

function encodeCollections(collections: ShoppingCollection[]): string {
  if (collections.length > MAX_COLLECTIONS) throw new Error(`You can keep up to ${MAX_COLLECTIONS} collections on this device.`);
  const sanitized = validateCollections({ version: 1, collections });
  const snapshot = JSON.stringify({ version: 1, collections: sanitized });
  if (snapshot.length > MAX_COLLECTIONS_BYTES) throw new Error('These collections are too large to save on this device.');
  return snapshot;
}

// Serializes this JS runtime, including an already-issued write from a retired
// repository. AsyncStorage does not provide cross-runtime compare-and-swap.
let collectionsQueue: Promise<void> = Promise.resolve();
function enqueueCollections<T>(operation: () => Promise<T>): Promise<T> {
  const result = collectionsQueue.catch(() => undefined).then(operation);
  collectionsQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Recreate when the customer's storage revision changes. Never reuse a retired
 * repository. The caller must also check isCurrent() immediately before publishing
 * an awaited result into UI state, including errors and finally handlers.
 */
export function createCustomerCollectionsRepository(fence: ReturnType<typeof createCustomerStorageFence>) {
  const lease = fence.capture('channel3Collections');
  let baseline: string | null | undefined;
  let blocked = false;
  const isCurrent = () => fence.isCurrent(lease);
  const check = () => { if (!isCurrent()) throw new Error('Saved collections are unavailable while the account changes.'); };
  async function read(): Promise<string | null> {
    check();
    const raw = await AsyncStorage.getItem(lease!.key);
    check();
    return raw;
  }
  return {
    isCurrent,
    load(): Promise<ShoppingCollection[]> {
      return enqueueCollections(async () => {
        check();
        // A failed reload must never leave an earlier baseline writable.
        baseline = undefined;
        blocked = true;
        const raw = await read();
        check();
        const collections = parseCollectionsSnapshot(raw);
        baseline = raw;
        blocked = false;
        return collections;
      });
    },
    async save(collections: ShoppingCollection[]): Promise<void> {
      check();
      // Encode before enqueueing so caller edits cannot change an in-flight save.
      const snapshot = encodeCollections(collections);
      return enqueueCollections(async () => {
        check();
        if (blocked || baseline === undefined) throw new Error('Reload saved collections before saving changes.');
        try {
          const current = await read();
          check();
          if (current !== baseline) throw new Error('Saved collections changed. Reload them before saving changes.');
          if (current !== snapshot) {
            check();
            await AsyncStorage.setItem(lease!.key, snapshot);
            check();
            if (await read() !== snapshot) throw new Error('Saved collections could not be verified. Reload before trying again.');
          }
          check();
          baseline = snapshot;
        } catch (error) {
          blocked = true;
          throw error;
        }
      });
    },
  };
}

const guestCollectionsRepository = createCustomerCollectionsRepository(createCustomerStorageFence({ kind: 'guest' }));
let guestCollectionsLoaded = false;
export async function loadCollections(): Promise<ShoppingCollection[]> {
  const collections = await guestCollectionsRepository.load();
  guestCollectionsLoaded = true;
  return collections;
}
export async function saveCollections(collections: ShoppingCollection[]): Promise<void> {
  // Compatibility for existing guest callers that save before their first load.
  if (!guestCollectionsLoaded) await loadCollections();
  await guestCollectionsRepository.save(collections);
}

export function toSavedProduct(product: Channel3Product, storefront: ShopStorefront): SavedProduct {
  const currency = SHOP_STOREFRONTS[storefront].currency;
  const availabilityRank = { InStock: 0, unknown: 1, OutOfStock: 2 } as const;
  const lastSeenOffer = product.offers
    .filter((offer) => offer.currency === currency && Number.isFinite(offer.price) && offer.price >= 0 && offer.price <= 100_000_000)
    .sort((left, right) => availabilityRank[left.availability] - availabilityRank[right.availability] || left.price - right.price)[0];
  const hasObservedAt = product.retrievedAt.length <= 64 && Number.isFinite(Date.parse(product.retrievedAt));
  return {
    id: product.id,
    title: product.title.slice(0, 200),
    brand: product.brand?.slice(0, 80) ?? null,
    savedAt: new Date().toISOString(),
    storefront,
    ...(lastSeenOffer && hasObservedAt ? {
      lastSeenPrice: { amount: lastSeenOffer.price, currency, observedAt: product.retrievedAt },
    } : {}),
  };
}

export function newCollection(name: string): ShoppingCollection {
  const timestamp = new Date().toISOString();
  const id = `c3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return { id, name: name.trim().slice(0, MAX_COLLECTION_NAME_LENGTH), items: [], updatedAt: timestamp };
}

/** Build a local save without altering existing lists or retaining retailer URLs. */
export function planProductSave(collections: ShoppingCollection[], activeId: string | null, product: Channel3Product, storefront: ShopStorefront): {
  collections: ShoppingCollection[];
  activeId: string;
  createdFavourites: boolean;
} {
  if (!isShopStorefront(storefront)) throw new Error('Choose a supported shop region.');
  const target = collections.find((item) => item.id === activeId) ?? collections[0];
  if (!target) {
    const favourites = newCollection('Favourites');
    return {
      collections: [{ ...favourites, items: [toSavedProduct(product, storefront)] }],
      activeId: favourites.id,
      createdFavourites: true,
    };
  }
  if (target.items.some((item) => item.id === product.id)) {
    throw new Error('This product is already saved in the selected collection.');
  }
  if (target.items.length >= MAX_PRODUCTS_PER_COLLECTION) {
    throw new Error(`This collection is full. Remove a product or create another collection (maximum ${MAX_PRODUCTS_PER_COLLECTION} products each).`);
  }
  return {
    collections: collections.map((item) => item.id === target.id
      ? { ...item, items: [...item.items, toSavedProduct(product, storefront)], updatedAt: new Date().toISOString() }
      : item),
    activeId: target.id,
    createdFavourites: false,
  };
}
