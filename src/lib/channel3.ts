import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { channel3StorefrontDomainPriority, isChannel3DomainForStorefront, storefrontCurrency, type Storefront } from "@/lib/channel3-storefront";
import { safeMarketplaceOfferUrl } from "@/lib/marketplace-safety";
import type { MarketplacePriceRange } from "@/lib/marketplace-price-range";
import { reserveChannel3ProviderRequest } from "@/lib/channel3-request-budget";
export { Channel3BudgetExceededError } from "@/lib/channel3-request-budget";

const DEFAULT_BASE = "https://api.trychannel3.com";
// App-owned response ceiling, not a Channel3 provider limit. Fetch exposes
// decoded bytes; transport and decompression can still buffer outside this cap.
const MAX_CHANNEL3_RESPONSE_BYTES = 2 * 1024 * 1024;
const CHANNEL3_REQUEST_TIMEOUT_MS = 8_000;
const CHANNEL3_SEARCH_TIMEOUT_MS = 12_000;
const CHANNEL3_AGENTIC_SEARCH_TIMEOUT_MS = 20_000;

export class Channel3TimeoutError extends Error {
  constructor() {
    super("Channel3 request timed out");
    this.name = "Channel3TimeoutError";
  }
}

interface C3Price {
  price: number;
  compare_at_price: number | null;
  currency: string;
}

export interface C3Offer {
  /** Advertised maximum affiliate fraction, not customer cashback or guaranteed earnings. */
  max_commission_rate?: number | null;
  url: string;
  domain: string;
  price: C3Price;
  availability: "InStock" | "OutOfStock";
  condition: "new" | "used" | null;
}

export interface C3Product {
  id: string;
  title: string;
  description: string | null;
  brands: Array<{ id: string; name: string }>;
  images: Array<{ url: string; cleaned_url: string | null; is_main_image: boolean }>;
  category: { slug: string; title: string } | null;
  colors: Array<{ hex: string; percentage: number }>;
  offers: C3Offer[];
  structured_attributes: Record<string, string[]>;
  ratings: { value: number; count: number; source_count: number } | null;
}

export interface C3SearchResponse {
  products: C3Product[];
  next_page_token?: string | null;
}

export function lowestOffer(products: C3Product[]): C3Offer | null {
  const offers = products.flatMap((p) => p.offers).filter((o) => o.availability === "InStock");
  if (!offers.length) return null;
  return offers.reduce((a, b) => (b.price.price < a.price.price ? b : a));
}

export function medianNewPrice(products: C3Product[]): number | null {
  const prices = products
    .flatMap((p) => p.offers)
    .filter((o) => o.condition !== "used" && o.availability === "InStock")
    .map((o) => o.price.price)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return (prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid]) * 100;
}

interface SearchOpts {
  query?: string;
  imageUrl?: string;
  base64Image?: string;
  limit?: number;
  includeUsed?: boolean;
  mode?: "default" | "keyword" | "agentic";
  pageToken?: string;
  locale?: Channel3Locale;
  priceRange?: MarketplacePriceRange;
  retailerWebsiteId?: string;
  retailerDomain?: string;
}

export type Channel3Locale = { country: string; currency: string; language: string };

export interface RequestedChannel3Retailer {
  id: "target" | "cvs" | "walmart" | "bestbuy";
  title: string;
  websiteId: string;
  domain: string;
  storefront: "US";
}

const REQUESTABLE_RETAILERS: readonly (RequestedChannel3Retailer & { phrase: RegExp })[] = [
  { id: "target", title: "Target", websiteId: "QnTm", domain: "target.com", storefront: "US", phrase: /\b(?:from|at|via)\s+(?:the\s+)?target(?:\.com)?(?=$|[\s,.;!?])/iu },
  { id: "cvs", title: "CVS", websiteId: "oeWt", domain: "cvs.com", storefront: "US", phrase: /\b(?:from|at|via)\s+(?:the\s+)?cvs(?:\.com)?(?=$|[\s,.;!?])/iu },
  { id: "walmart", title: "Walmart", websiteId: "BsaX", domain: "walmart.com", storefront: "US", phrase: /\b(?:from|at|via)\s+(?:the\s+)?walmart(?:\.com)?(?=$|[\s,.;!?])/iu },
  { id: "bestbuy", title: "Best Buy", websiteId: "p1PB", domain: "bestbuy.com", storefront: "US", phrase: /\b(?:from|at|via)\s+(?:the\s+)?best[\s-]?buy(?:\.com)?(?=$|[\s,.;!?])/iu },
];

/** Restrict explicit supported retailer requests; plain brand/product mentions remain unfiltered. */
export function requestedChannel3Retailer(value: unknown): RequestedChannel3Retailer | null {
  if (typeof value !== "string") return null;
  const retailer = REQUESTABLE_RETAILERS.find(({ phrase }) => phrase.test(value));
  if (!retailer) return null;
  return { id: retailer.id, title: retailer.title, websiteId: retailer.websiteId, domain: retailer.domain, storefront: retailer.storefront };
}

const supportedCountries = new Set(["US", "GB", "EU", "AU", "CA", "IE", "DE", "AT", "FR", "BE", "IT", "ES", "NL", "SE", "FI", "PT", "CZ", "GR", "RO"]);
const supportedCurrencies = new Set(["USD", "CAD", "AUD", "GBP", "EUR", "SEK", "CZK", "RON"]);
const supportedLanguages = new Set(["en", "de", "fr", "it", "es", "nl", "sv", "fi", "pt", "cs", "el", "ro"]);

/** Explicit storefronts are canonical. Omitted ones retain supported configured defaults. */
export function getChannel3Locale(storefront?: Storefront): Channel3Locale {
  if (storefront) return { country: storefront, currency: storefrontCurrency(storefront), language: "en" };
  const locale = {
    language: process.env.CHANNEL3_LANGUAGE || "en",
    country: process.env.CHANNEL3_COUNTRY || "US",
    currency: process.env.CHANNEL3_CURRENCY || "USD",
  };
  if (!supportedLanguages.has(locale.language) || !supportedCountries.has(locale.country) || !supportedCurrencies.has(locale.currency)) {
    throw new Error("Channel3 default locale is not supported");
  }
  return locale;
}

/** Optional for text search; curated browse uses the required getter below. */
export function getChannel3CollectionId(): string | undefined {
  const value = process.env.CHANNEL3_COLLECTION_ID;
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Channel3 collection configuration is invalid");
  return value;
}
export function getRequiredChannel3CollectionId(): string {
  const value = getChannel3CollectionId();
  if (value === undefined) throw new Error("Channel3 curated collection is not configured");
  return value;
}
function collectionConfig() {
  const collection = getChannel3CollectionId();
  return collection === undefined ? {} : { collection_id: collection };
}
function requiredCollectionConfig() {
  return { collection_id: getRequiredChannel3CollectionId() };
}

async function readChannel3Json(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(length) || length > MAX_CHANNEL3_RESPONSE_BYTES) {
      // Content-Length can describe compressed bytes, so this is deliberately
      // conservative. The decoded stream is checked independently below.
      try { void response.body?.cancel().catch(() => undefined); } catch { /* Already unavailable. */ }
      throw new Error("Channel3 response exceeds the app limit or has an invalid length");
    }
  }
  if (!response.body) throw new Error("Channel3 response has no body");

  const reader = response.body.getReader();
  let finished = false;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Channel3TimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  const read = async (): Promise<unknown> => {
    let buffer = new Uint8Array(16 * 1024);
    let used = 0;
    while (true) {
      if (signal.aborted) throw new Channel3TimeoutError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Channel3TimeoutError();
      if (done) { finished = true; break; }
      if (value.byteLength > MAX_CHANNEL3_RESPONSE_BYTES - used) {
        throw new Error("Channel3 response exceeds the app limit");
      }
      const nextSize = used + value.byteLength;
      if (nextSize > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(MAX_CHANNEL3_RESPONSE_BYTES, Math.max(nextSize, buffer.byteLength * 2)));
        grown.set(buffer.subarray(0, used));
        buffer = grown;
      }
      buffer.set(value, used);
      used = nextSize;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
    return JSON.parse(text) as unknown;
  };

  try {
    // A single race covers the entire stream, including a stalled reader that
    // does not resolve on cancellation. Do not add one handler per chunk.
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!finished) {
      try { void reader.cancel().catch(() => undefined); } catch { /* Already unavailable. */ }
    }
    try { reader.releaseLock(); } catch { /* The platform may still be cancelling a pending read. */ }
  }
}

async function call(path: string, body: Record<string, unknown>): Promise<C3SearchResponse>;
async function call(path: string, body: Record<string, unknown>, options: { timeoutMs?: number; notFoundAsNull?: false }): Promise<C3SearchResponse>;
async function call(path: string, body: Record<string, unknown>, options: { timeoutMs?: number; notFoundAsNull: true }): Promise<C3SearchResponse | null>;
async function call(path: string, body: Record<string, unknown>, options: { timeoutMs?: number; notFoundAsNull?: boolean } = {}): Promise<C3SearchResponse | null> {
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) throw new Error("Channel3 is not configured");

  const base = process.env.CHANNEL3_BASE_URL ?? DEFAULT_BASE;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new Error("Channel3 base URL is invalid");
  }
  if (baseUrl.protocol !== "https:") throw new Error("Channel3 base URL must use HTTPS");
  const endpoint = new URL(path.replace(/^\/+/, ""), `${baseUrl.toString().replace(/\/+$/, "")}/`);

  await reserveChannel3ProviderRequest();
  const deadline = AbortSignal.timeout(options.timeoutMs ?? CHANNEL3_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch (error) {
    if (deadline.aborted) throw new Channel3TimeoutError();
    throw error;
  }
  if (res.status === 404 && options?.notFoundAsNull) {
    try { void res.body?.cancel().catch(() => undefined); } catch { /* The body may already be unavailable. */ }
    return null;
  }
  if (!res.ok) {
    throw new Error(`Channel3 request failed (${res.status})`);
  }
  const payload = await readChannel3Json(res, deadline);
  if (
    !payload || typeof payload !== "object" ||
    !("products" in payload) || !Array.isArray(payload.products) ||
    !payload.products.every((product: unknown) => (
      !!product && typeof product === "object" && !Array.isArray(product) &&
      "id" in product && typeof product.id === "string" &&
      "title" in product && typeof product.title === "string"
    )) ||
    ("next_page_token" in payload && payload.next_page_token != null && typeof payload.next_page_token !== "string")
  ) {
    throw new Error("Channel3 response is invalid");
  }
  // Preserve each retailer's advertised rate independently. Missing/invalid is
  // unknown, never a fabricated zero or a percentage converted twice.
  return { ...payload, products: payload.products.map(normalizeProductCommission) } as C3SearchResponse;
}

function normalizeProductCommission(product: unknown): unknown {
  if (!product || typeof product !== "object" || Array.isArray(product)) return product;
  const record = product as Record<string, unknown>;
  if (!Array.isArray(record.offers)) return product;
  return { ...record, offers: record.offers.map((offer: unknown) => {
    if (!offer || typeof offer !== "object" || Array.isArray(offer)) return offer;
    if (!("max_commission_rate" in offer)) return offer;
    const rate = offer.max_commission_rate;
    return { ...offer, max_commission_rate: typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null };
  }) };
}

function filterProductToStorefront<T extends { offers?: unknown }>(product: T, storefront: string): T {
  const offers = Array.isArray(product.offers)
    ? product.offers.filter((offer: unknown) => (
      !!offer && typeof offer === "object" && !Array.isArray(offer) &&
      isChannel3DomainForStorefront((offer as { domain?: unknown }).domain, storefront)
    )).sort((left: unknown, right: unknown) => {
      const a = left as { availability?: unknown; domain?: unknown; price?: { currency?: unknown } };
      const b = right as { availability?: unknown; domain?: unknown; price?: { currency?: unknown } };
      const stockOrder = Number(b.availability === "InStock") - Number(a.availability === "InStock");
      if (stockOrder !== 0) return stockOrder;

      const currency = storefront === "US" ? "USD" : storefront === "GB" ? "GBP" : null;
      const currencyOrder = currency
        ? Number(b.price?.currency === currency) - Number(a.price?.currency === currency)
        : 0;
      if (currencyOrder !== 0) return currencyOrder;

      return channel3StorefrontDomainPriority(b.domain, storefront) - channel3StorefrontDomainPriority(a.domain, storefront);
    })
    : [];
  return { ...product, offers };
}

function filterResponseToStorefront(response: C3SearchResponse, storefront: string): C3SearchResponse {
  return {
    ...response,
    products: response.products.map((product) => {
      const regional = filterProductToStorefront(product, storefront);
      return { ...regional, offers: regional.offers.filter((offer) => safeMarketplaceOfferUrl(offer.url, offer.domain)) };
    }),
  };
}

/** Fresh Channel3 product details for a handoff; offer URLs are never cached. */
export async function retrieveProduct(productId: string, locale: Channel3Locale): Promise<C3Product | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(productId)) throw new Error("Channel3 product ID is invalid");
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) throw new Error("Channel3 is not configured");

  const base = process.env.CHANNEL3_BASE_URL ?? DEFAULT_BASE;
  let baseUrl: URL;
  try { baseUrl = new URL(base); }
  catch { throw new Error("Channel3 base URL is invalid"); }
  if (baseUrl.protocol !== "https:") throw new Error("Channel3 base URL must use HTTPS");

  const endpoint = new URL(`v1/products/${encodeURIComponent(productId)}`, `${baseUrl.toString().replace(/\/+$/, "")}/`);
  endpoint.search = new URLSearchParams(locale).toString();
  await reserveChannel3ProviderRequest();
  const deadline = AbortSignal.timeout(CHANNEL3_REQUEST_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { "x-api-key": apiKey },
    cache: "no-store",
    redirect: "error",
    signal: deadline,
  });
  if (response.status === 404) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* The body may already be unavailable. */ }
    return null;
  }
  if (!response.ok) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* The body may already be unavailable. */ }
    throw new Error(`Channel3 product request failed (${response.status})`);
  }

  const payload = await readChannel3Json(response, deadline);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
    !("id" in payload) || payload.id !== productId || !("title" in payload) || typeof payload.title !== "string") {
    throw new Error("Channel3 product response is invalid");
  }
  return filterProductToStorefront(normalizeProductCommission(payload) as C3Product, locale.country) as C3Product;
}

function filters(includeUsed?: boolean) {
  if (!includeUsed) return undefined;
  return {
    conditions: ["new", "used"],
    availability: ["InStock", "OutOfStock"],
  };
}

export async function search(opts: SearchOpts) {
  const { imageUrl, base64Image, pageToken, locale = getChannel3Locale(), priceRange, retailerWebsiteId, retailerDomain, ...rest } = opts;
  const price = priceRange ? {
    ...(priceRange.minPrice === undefined ? {} : { min_price: priceRange.minPrice }),
    ...(priceRange.maxPrice === undefined ? {} : { max_price: priceRange.maxPrice }),
  } : undefined;
  const result = await call("/v1/search", {
    query: rest.query,
    image_url: imageUrl,
    base64_image: base64Image,
    page_token: pageToken,
    limit: rest.limit,
    config: {
      mode: rest.mode ?? "default",
      ...locale,
      ...collectionConfig(),
    },
    ...((price || rest.includeUsed || retailerWebsiteId) ? { filters: { ...(price ? { price } : {}), ...(rest.includeUsed ? filters(true) : {}), ...(retailerWebsiteId ? { website_ids: [retailerWebsiteId] } : {}) } } : {}),
  }, { timeoutMs: rest.mode === "agentic" ? CHANNEL3_AGENTIC_SEARCH_TIMEOUT_MS : CHANNEL3_SEARCH_TIMEOUT_MS });
  const storefrontResult = filterResponseToStorefront(result, locale.country);
  if (!retailerDomain) return storefrontResult;
  const expectedDomain = retailerDomain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return {
    ...storefrontResult,
    products: storefrontResult.products.flatMap((product) => {
      const offers = product.offers.filter(({ domain }) => {
        const host = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
        return host === expectedDomain || host.endsWith(`.${expectedDomain}`);
      });
      return offers.length ? [{ ...product, offers }] : [];
    }),
  };
}

/** Provider-ranked same-storefront alternatives; source is a Channel3 product ID, not a text query. */
export async function findSimilarProducts(productId: string, locale = getChannel3Locale()) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(productId)) throw new Error("Channel3 product ID is invalid");
  const result = await call("/v1/similar", {
    product_id: productId,
    limit: 12,
    filters: { conditions: ["new"], availability: ["InStock"] },
    config: locale,
  }, { notFoundAsNull: true });
  return result === null ? null : filterResponseToStorefront(result, locale.country);
}

export async function browseCatalog(selection: { categoryId?: string; websiteId?: string }, limit = 24, locale = getChannel3Locale(), pageToken?: string) {
  if ((!selection.categoryId && !selection.websiteId) || ![12, 24].includes(limit)) throw new Error("Invalid catalog selection");
  const result = await call("/v1/browse", {
    filters: { ...(selection.categoryId ? { category_ids: [selection.categoryId] } : {}), ...(selection.websiteId ? { website_ids: [selection.websiteId] } : {}), conditions: ["new"], availability: ["InStock"] },
    limit, config: { ...locale, ...requiredCollectionConfig() }, ...(pageToken ? { page_token: pageToken } : {}),
  });
  return filterResponseToStorefront(result, locale.country);
}

export async function browseCategory(categoryId: string, limit = 8, locale = getChannel3Locale()) {
  const result = await call("/v1/browse", { filters: { category_ids: [categoryId], conditions: ["new"], availability: ["InStock"] }, limit, config: { ...locale, ...requiredCollectionConfig() } });
  return filterResponseToStorefront(result, locale.country);
}

function catalogMac(payload: string): string {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error("Channel3 is not configured");
  return createHmac("sha256", key).update("paypal-markets:catalog-cursor:v1\0").update(payload).digest("base64url");
}
/** Signed app continuation, not a URL, page number or provider credential. */
export function encodeCatalogPageToken(token: string, binding: string, now = Date.now()): string {
  if (!token || Buffer.byteLength(token, "utf8") > 4096) throw new Error("Invalid provider continuation");
  const payload = Buffer.from(JSON.stringify({ v: 1, binding, token, expiresAt: now + 900000 }), "utf8").toString("base64url");
  const cursor = `${payload}.${catalogMac(payload)}`;
  if (cursor.length > 6144) throw new Error("Provider continuation exceeds app limit");
  return cursor;
}
export function decodeCatalogPageToken(cursor: string, binding: string, now = Date.now()): string | null {
  if (cursor.length > 6144 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) return null;
  const [payload, signature] = cursor.split(".");
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(catalogMac(payload)))) return null;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "binding,expiresAt,token,v" || value.v !== 1 || value.binding !== binding || typeof value.token !== "string" || !value.token || Buffer.byteLength(value.token, "utf8") > 4096 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 900000) return null;
    return value.token;
  } catch { return null; }
}
