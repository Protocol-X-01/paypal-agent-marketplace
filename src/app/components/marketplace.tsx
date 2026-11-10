"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { isStorefront, storefrontCurrency, STOREFRONT_STORAGE_KEY, type Storefront } from "@/lib/channel3-storefront";
import { formatPriceRange, isMarketplacePriceRange, parsePriceRangeInputs, samePriceRange, type MarketplacePriceRange } from "@/lib/marketplace-price-range";
import { fetchMarketplaceJson, MarketplaceRequestTimeoutError } from "@/lib/marketplace-request";
import { fetchMarketplaceImage, matchCurrentOffer, primaryMarketplaceImage } from "@/lib/marketplace-safety";
import { MAX_COLLECTIONS, MAX_COLLECTION_NAME_LENGTH, MAX_ITEMS, needsSavedIdentityReview, parseProduct, readCollections, serializeCollections, snapshotProduct, type Offer, type Product, type SavedItem, type ShoppingCollection } from "@/lib/marketplace-storage";
import { CHANNEL3_CURATED_SECTIONS, CHANNEL3_CURATED_RETAILERS, getChannel3SeasonalEdit } from "@/lib/channel3-catalog";
import { collectionLocksAvailable, COLLECTIONS_CHANGED_EVENT, SHOPPING_LISTS_STORAGE_KEY, tryCollectionLock } from "@/lib/collection-lock";
import { LOCAL_DATA_RESET_SIGNAL } from "@/lib/portfolio-input";
import { MAX_RETAINED_COLLECTION_DRAFT_LENGTH } from "@/lib/customer-shopping-draft-memory";
import styles from "./marketplace.module.css";
import { usePrivateDataScope, useShoppingDraftMemory } from "./customer-session";

export { SHOPPING_LISTS_STORAGE_KEY } from "@/lib/collection-lock";
const DEFAULT_STOREFRONT: Storefront = "US";
const DISCOVERY_MODE_STORAGE_KEY = "paypal-markets.discovery-mode.v1";
type DiscoveryMode = "browse" | "search";
const SEARCH_PAGE_SIZE = 24;
const SEARCH_MAX_PAGES = 4;
const SEARCH_MAX_PRODUCTS = SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES;

type RetrievedProducts = {
  products: Product[];
  retrievedById: ReadonlyMap<string, string>;
  receivedAtById: ReadonlyMap<string, number>;
};
type SearchPagination = "more" | "end" | "limit" | "unavailable" | "none";
type SearchResults = RetrievedProducts & { query: string; retrievedAt: string; storefront: Storefront; priceRange: MarketplacePriceRange | null; nextPageToken: string | null; pagesLoaded: number; pagination: SearchPagination };
type Sort = "recommended" | "price-asc" | "price-desc";
type CatalogSectionId = (typeof CHANNEL3_CURATED_SECTIONS)[number]["id"];
type CatalogRetailerId = (typeof CHANNEL3_CURATED_RETAILERS)[number]["id"];
type CuratedCatalog = RetrievedProducts & { provider: "Channel3"; section: CatalogSectionId | null; retailer: CatalogRetailerId | null; nextPageToken: string | null; title: string; retrievedAt: string; storefront: Storefront; pagesLoaded: number };
type SimilarOfferSet = { products: Product[]; snapshot: RetrievedProducts & { storefront: Storefront }; visible: boolean; loading: boolean; error: string; unconfirmed?: boolean };

const SIMILAR_FAMILIES = [
  { query: "travel backpack", terms: ["bag", "bags", "backpack", "backpacks", "rucksack", "tote", "duffel", "luggage", "carryon"] },
  { query: "wireless headphones", terms: ["headphone", "headphones", "earbud", "earbuds", "earphone", "earphones", "headset"] },
  { query: "shoes", terms: ["shoe", "shoes", "sneaker", "sneakers", "boot", "boots"] },
  { query: "laptops", terms: ["laptop", "notebook", "computer"] },
  { query: "smartphones", terms: ["phone", "smartphone", "mobile"] },
  { query: "tablets", terms: ["tablet", "ipad"] },
  { query: "desk lamps", terms: ["lamp", "lighting", "light"] },
  { query: "coffee makers", terms: ["coffee", "coffeemaker", "espresso"] },
  { query: "cameras", terms: ["camera", "webcam"] },
  { query: "water bottles", terms: ["bottle", "flask", "tumbler"] },
  { query: "chairs", terms: ["chair", "stool", "desk"] },
  { query: "watches", terms: ["watch", "watches", "smartwatch", "wearable"] },
  { query: "monitors and televisions", terms: ["monitor", "television", "display", "screen"] },
  { query: "printers", terms: ["printer", "printers", "scanner"] },
  { query: "gaming accessories", terms: ["gaming", "console", "controller", "videogame"] },
  { query: "board games and toys", terms: ["toy", "toys", "puzzle", "boardgame", "boardgames"] },
  { query: "skin care and beauty", terms: ["skincare", "makeup", "cosmetics", "beauty"] },
  { query: "fitness equipment", terms: ["fitness", "exercise", "yoga", "weights", "dumbbell", "treadmill"] },
  { query: "pet supplies", terms: ["pet", "pets", "dog", "dogs", "cat", "cats"] },
  { query: "clothing", terms: ["shirt", "shirts", "dress", "jacket", "jeans", "clothing", "apparel"] },
  { query: "jewelry", terms: ["jewelry", "jewellery", "necklace", "ring", "bracelet"] },
  { query: "home and bedding", terms: ["bedding", "duvet", "pillow", "mattress", "decor"] },
  { query: "small appliances", terms: ["vacuum", "blender", "toaster", "appliance", "airfryer"] },
  { query: "pantry and snacks", terms: ["snack", "snacks", "pantry", "grocery", "food"] },
];
const SIMILAR_STOP_WORDS = new Set(["the", "and", "for", "with", "from", "new", "black", "white", "blue", "red", "green", "pink", "small", "large", "medium", "mens", "womens", "kids"]);
function productWords(value: string) { return new Set((value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !SIMILAR_STOP_WORDS.has(word))); }
function similarProductQuery(value: string) {
  const words = productWords(value);
  const family = SIMILAR_FAMILIES.find((item) => item.terms.some((term) => words.has(term)));
  if (family) return family.query;
  const fallback = [...words].slice(0, 5).join(" ").slice(0, 80).trim();
  return fallback.length >= 3 ? fallback : null;
}
function findSimilarInStockProducts(source: Product, candidates: readonly Product[]) {
  const sourceWords = productWords(`${source.brand ?? ""} ${source.title}`);
  const families = SIMILAR_FAMILIES.filter((family) => family.terms.some((term) => sourceWords.has(term)));
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (candidate.id === source.id || seen.has(candidate.id) || !candidate.offers.some((offer) => offer.url && offer.availability === "InStock")) return [];
    const candidateWords = productWords(`${candidate.brand ?? ""} ${candidate.title}`);
    const sharedWords = [...sourceWords].filter((word) => candidateWords.has(word)).length;
    const sharedFamily = families.some((family) => family.terms.some((term) => candidateWords.has(term)));
    if (!sharedFamily && sharedWords < 2) return [];
    seen.add(candidate.id);
    const sameBrand = Boolean(source.brand && candidate.brand && source.brand.toLowerCase() === candidate.brand.toLowerCase());
    return [{ product: candidate, score: sharedWords + (sharedFamily ? 4 : 0) + (sameBrand ? 2 : 0) }];
  }).sort((left, right) => right.score - left.score || left.product.title.localeCompare(right.product.title)).slice(0, 3).map(({ product }) => product);
}

function currentTimeMs() { return Date.now(); }

const CURATED_SECTIONS = CHANNEL3_CURATED_SECTIONS.map(section => ({ id: section.id, title: section.title, detail: section.description, glyph: section.id }));
const COMMISSION_LEGEND = "★ Retailer-advertised max rate; may change. We may earn a commission on qualifying purchases. Not cashback.";
function commissionLabel(rate: number | null | undefined) { return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? `★ ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(rate * 100)}%` : "★ —"; }
function commissionDescription(rate: number | null | undefined) {
  const label = commissionLabel(rate);
  return label === "★ —" ? "Advertised affiliate commission rate unavailable." : `Maximum advertised affiliate commission ${label.slice(2)}.`;
}
function commissionRate(rate: number | null | undefined) {
  return <span className={styles.commission} role="img" aria-label={commissionDescription(rate)}>{commissionLabel(rate)}</span>;
}
function isProductRefreshing(product: Product, key: string | null) {
  return key === `${product.id}:collection` || key === `${product.id}:similar` || product.offers.some((offer) => key === `${product.id}:${offer.domain}`);
}
function primaryOfferPrice(offer: Offer | undefined, updating: boolean, saved = false, unconfirmed = false) {
  return <div className={styles.primaryPrice}>{offer ? <><strong>{money(offer.price.price, offer.price.currency)}</strong><span>{offer.price.currency}</span>{updating ? <span role="status">{saved ? "Saved price · updating" : "Last shown · updating"}</span> : unconfirmed ? <span>Last shown · availability unconfirmed</span> : saved ? <span>Saved price · not checked now</span> : null}</> : <span>Price unavailable</span>}</div>;
}

function storefrontLabel(storefront: Storefront) { return `${storefront === "GB" ? "United Kingdom" : "United States"} · ${storefrontCurrency(storefront)}`; }
function productCountLabel(count: number) { return `${count} ${count === 1 ? "product" : "products"}`; }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marketplaceRequestError(error: unknown, fallback: string, timeoutMessage: string) {
  if (error instanceof MarketplaceRequestTimeoutError) return timeoutMessage;
  if (error instanceof TypeError || (error instanceof Error && /^(failed to fetch|load failed|network request failed)$/i.test(error.message.trim()))) {
    return "Check your connection and try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

/** Keep the first copy of each product and the time its own page was received. */
function mergeProductPage(previous: RetrievedProducts | null, page: Product[], retrievedAt: string): RetrievedProducts {
  const products = [...(previous?.products ?? [])];
  const retrievedById = new Map(previous?.retrievedById ?? []);
  const receivedAtById = new Map(previous?.receivedAtById ?? []);
  const receivedAt = currentTimeMs();
  const seen = new Set(products.map((product) => product.id));
  for (const product of page) {
    if (products.length >= SEARCH_MAX_PRODUCTS) break;
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    products.push(product);
    retrievedById.set(product.id, retrievedAt);
    receivedAtById.set(product.id, receivedAt);
  }
  return { products, retrievedById, receivedAtById };
}

function replaceProductSnapshot(previous: RetrievedProducts, product: Product, retrievedAt: string, receivedAt: number): RetrievedProducts {
  return {
    products: previous.products.map((item) => item.id === product.id ? product : item),
    retrievedById: new Map(previous.retrievedById).set(product.id, retrievedAt),
    receivedAtById: new Map(previous.receivedAtById).set(product.id, receivedAt),
  };
}

function parseSearchPage(value: unknown, query: string, storefront: Storefront): { products: Product[]; retrievedAt: string; priceRange: MarketplacePriceRange | null; nextPageToken: string | null; pagination: SearchPagination } | null {
  if (!record(value) || value.provider !== "Channel3" || value.query !== query || value.storefront !== storefront || value.currency !== storefrontCurrency(storefront) ||
    typeof value.retrievedAt !== "string" || !Array.isArray(value.products) || !("priceRange" in value) || !isMarketplacePriceRange(value.priceRange) ||
    (value.nextPageToken !== undefined && value.nextPageToken !== null && (typeof value.nextPageToken !== "string" || !value.nextPageToken || value.nextPageToken.length > 6144))) return null;
  return {
    products: value.products.slice(0, SEARCH_PAGE_SIZE).map((product) => parseProduct(product, storefrontCurrency(storefront))).filter((product): product is Product => product !== null),
    retrievedAt: value.retrievedAt,
    priceRange: value.priceRange,
    nextPageToken: typeof value.nextPageToken === "string" ? value.nextPageToken : null,
    pagination: typeof value.nextPageToken === "string" ? "more" : value.nextPageToken === null ? "end" : "unavailable",
  };
}

async function fetchSimilarProductsPage(title: string, storefront: Storefront, signal: AbortSignal) {
  const query = similarProductQuery(title);
  if (!query) return null;
  const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: SEARCH_PAGE_SIZE, storefront }),
  }, signal);
  if (!response.ok) throw new Error(response.status === 429 ? "Similar-item search is temporarily limited. Try again shortly." : "Similar items could not be refreshed right now.");
  const page = parseSearchPage(body, query, storefront);
  if (!page) throw new Error("Similar items did not match this storefront. Try again.");
  return page;
}

async function fetchCurrentMarketplaceProduct(productId: string, storefront: Storefront, signal: AbortSignal) {
  const params = new URLSearchParams({ storefront });
  const { response, body } = await fetchMarketplaceJson(`/api/marketplace/products/${encodeURIComponent(productId)}?${params}`, { method: "GET" }, signal);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 429 ? "Product checks are temporarily limited. Try again shortly." : "Current product offers could not be refreshed. Please try again shortly.");
  if (!record(body) || body.provider !== "Channel3" || body.storefront !== storefront || body.currency !== storefrontCurrency(storefront) ||
    typeof body.retrievedAt !== "string" || !Number.isFinite(Date.parse(body.retrievedAt)) || !record(body.product) || body.product.id !== productId) {
    throw new Error("Current product details did not match this item and storefront. Please try again.");
  }
  const product = parseProduct(body.product, storefrontCurrency(storefront));
  return product ? { product, retrievedAt: body.retrievedAt } : null;
}

function parseCuratedCatalog(value: unknown, section: CatalogSectionId | null, storefront: Storefront, retailer: CatalogRetailerId | null, paged = false): CuratedCatalog | null {
  if (
    !record(value) || value.provider !== "Channel3" || value.section !== section || (value.retailer ?? null) !== retailer ||
    (value.limit !== undefined && value.limit !== 24) ||
    (paged && (value.retailer === undefined || value.limit !== 24 || value.nextPageToken === undefined)) ||
    (value.nextPageToken !== undefined && value.nextPageToken !== null && (typeof value.nextPageToken !== "string" || !value.nextPageToken || value.nextPageToken.length > 6144)) ||
    value.storefront !== storefront || value.currency !== storefrontCurrency(storefront) ||
    typeof value.title !== "string" || !value.title.trim() ||
    typeof value.retrievedAt !== "string" || !Array.isArray(value.products)
  ) return null;

  const products = value.products.slice(0, 24).map((product) => parseProduct(product, storefrontCurrency(storefront))).filter((product): product is Product => product !== null);
  return {
    provider: "Channel3",
    section,
    retailer,
    nextPageToken: typeof value.nextPageToken === "string" ? value.nextPageToken : null,
    title: value.title.trim().slice(0, 120),
    retrievedAt: value.retrievedAt,
    storefront,
    ...mergeProductPage(null, products, value.retrievedAt),
    pagesLoaded: 1,
  };
}

function money(value: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}

function offerHandoffLabel(offer: Offer): string {
  return offer.domain;
}

function preferredRetailerOffer(offers: readonly Offer[]): Offer | null {
  return offers.find((offer) => offer.url && offer.availability === "InStock") ?? null;
}

function offerChoiceLabel(action: string, product: Product, offer: Offer, index: number) {
  return `${action} offer ${index + 1} for ${product.title}, ${offerHandoffLabel(offer)}, ${money(offer.price.price, offer.price.currency)} ${offer.price.currency}, ${offer.availability === "InStock" ? "reported in stock" : "reported out of stock"}, ${commissionLabel(offer.max_commission_rate)}`;
}

function dateLabel(value: string) {
  // These are app-generated UTC retrieval times, not local-time guesses.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return "date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return "date unavailable";
  return date.toISOString().replace("T", " ").replace(/\.000Z$/, "Z").replace("Z", " UTC");
}

function newCollection(name: string): ShoppingCollection {
  return { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), items: [] };
}

function BagIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z" stroke="currentColor" strokeWidth="1.5" /><path d="M8 9V6a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function CuratedGlyph({ kind }: { kind: string }) {
  if (kind === "audio") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 13v-1a8 8 0 0 1 16 0v1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M4 13v4a2 2 0 0 0 2 2h1v-7H6a2 2 0 0 0-2 2Zm16 0v4a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
  if (kind === "travel") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 9V6a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
  if (kind !== "workspace") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 10 3-6h3l3 7H8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m11 11-3 6m5-6 3 6M7 18h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

export default function Marketplace() {
  const privateData = usePrivateDataScope();
  const privateScopeGeneration = useRef(0);
  const renderedPrivateScopeGeneration = privateScopeGeneration.current;
  const { lease, shoppingDraft } = useShoppingDraftMemory();
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const [storefront, setStorefront] = useState<Storefront>(DEFAULT_STOREFRONT);
  // Public product discovery can use the default storefront while customer
  // session verification is pending. Saved preferences remain session-scoped.
  const [storefrontReady, setStorefrontReady] = useState(true);
  const [storefrontStorageNotice, setStorefrontStorageNotice] = useState("");
  const [storefrontChangeNotice, setStorefrontChangeNotice] = useState("");
  const [query, setQuery] = useState("");
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>("browse");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const resultsRef = useRef<SearchResults | null>(null);
  const replaceResults = useCallback((next: SearchResults | null) => { resultsRef.current = next; setResults(next); }, []);
  const [catalogSection, setCatalogSection] = useState<CatalogSectionId | null>(null);
  const [catalogRetailer, setCatalogRetailer] = useState<CatalogRetailerId | null>(null);
  const [catalogMoreLoading, setCatalogMoreLoading] = useState(false);
  const [catalogMoreError, setCatalogMoreError] = useState("");
  const [catalog, setCatalog] = useState<CuratedCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchMoreLoading, setSearchMoreLoading] = useState(false);
  const [searchMoreError, setSearchMoreError] = useState("");
  const [searchMoreStatus, setSearchMoreStatus] = useState("");
  const [collections, setCollections] = useState<ShoppingCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageReadable, setStorageReadable] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [collectionReloadRequired, setCollectionReloadRequired] = useState(false);
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [locksAvailable, setLocksAvailable] = useState<boolean | null>(null);
  const [collectionViewVersion, setCollectionViewVersion] = useState(0);
  const [retainedRenames, setRetainedRenames] = useState<Array<{ collection: string; value: string }>>([]);
  const [notice, setNotice] = useState("");
  const [collectionName, setCollectionName] = useState(() => shoppingDraft.read(lease) ?? "");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [moveDestinationByProduct, setMoveDestinationByProduct] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [retailer, setRetailer] = useState("all");
  const [currency, setCurrency] = useState("all");
  const [inStockOnly, setInStockOnly] = useState(true);
  const [sort, setSort] = useState<Sort>("recommended");
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [catalogFeedback, setCatalogFeedback] = useState<{ productId: string; message: string; error: boolean } | null>(null);
  const [similarOfferSets, setSimilarOfferSets] = useState<Record<string, SimilarOfferSet>>({});
  const request = useRef<AbortController | null>(null);
  const searchMoreRequest = useRef<AbortController | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const storefrontRef = useRef<Storefront>(DEFAULT_STOREFRONT);
  const queryRef = useRef("");
  const queryInput = useRef<HTMLInputElement>(null);
  const collectionBaseline = useRef<string | null | undefined>(undefined);
  const collectionVersion = useRef(0);
  const collectionScopeActive = useRef(false);
  const collectionBusyRef = useRef(false);
  const suppressCollectionNotice = useRef(false);
  const collectionNameRef = useRef(collectionName);
  const renameDraftRef = useRef("");
  const renameTargetId = useRef<string | null>(null);
  const deleteReview = useRef<{ id: string; baseline: string | null; version: number } | null>(null);
  const catalogSelectionRef = useRef<{ section: CatalogSectionId | null; retailer: CatalogRetailerId | null } | null>(null);
  const storefrontChangedBeforeSessionRef = useRef(false);
  const browseCuratedCatalogRef = useRef<(section: CatalogSectionId | null, retailer: CatalogRetailerId | null) => Promise<void>>(async () => {});

  const applyStorefront = useCallback((next: Storefront, announce: boolean, preserveCatalogSelection = false) => {
    if (storefrontRef.current === next) return;
    const catalogSelection = preserveCatalogSelection ? catalogSelectionRef.current : null;
    catalogSelectionRef.current = catalogSelection;
    storefrontRef.current = next;
    request.current?.abort();
    searchMoreRequest.current?.abort();
    catalogRequest.current?.abort();
    request.current = null;
    searchMoreRequest.current = null;
    catalogRequest.current = null;
    setStorefront(next);
    setMinimumPrice("");
    setMaximumPrice("");
    replaceResults(null);
    setCatalog(null);
    setCatalogSection(null);
    setCatalogRetailer(null);
    setCatalogMoreLoading(false);
    setCatalogMoreError("");
    setCatalogLoading(false);
    setLoading(false);
    setSearchMoreLoading(false);
    setSearchMoreError("");
    setSearchMoreStatus("");
    setRefreshingKey(null);
    setCatalogFeedback(null);
    setSimilarOfferSets({});
    setCatalogError("");
    setError("");
    setRetailer("all");
    setCurrency("all");
    setInStockOnly(true);
    setSort("recommended");
    if (announce) {
      setStorefrontChangeNotice(`Storefront changed to ${next === "GB" ? "United Kingdom" : "United States"}.${queryRef.current.trim() ? " Review your search text if it includes a budget in another currency." : " Search or choose a category to see current offers."}`);
      setNotice("");
    }
  }, [replaceResults]);

  useEffect(() => {
    let restoreTimer = 0;
    try {
      const saved = window.localStorage.getItem(DISCOVERY_MODE_STORAGE_KEY);
      if (saved === "browse" || saved === "search") restoreTimer = window.setTimeout(() => setDiscoveryMode(saved), 0);
    } catch { /* The mode remains available for this page visit. */ }
    return () => window.clearTimeout(restoreTimer);
  }, []);

  function chooseDiscoveryMode(mode: DiscoveryMode) {
    rememberDiscoveryMode(mode);
    if (mode === "browse" || (mode !== discoveryMode && refreshingKey !== null)) {
      request.current?.abort();
      request.current = null;
      setLoading(false);
      setRefreshingKey(null);
    }
    if (mode === "browse") {
      searchMoreRequest.current?.abort();
      searchMoreRequest.current = null;
      setSearchMoreLoading(false);
    } else {
      catalogRequest.current?.abort();
      catalogRequest.current = null;
      setCatalogLoading(false);
      setCatalogMoreLoading(false);
    }
  }

  function rememberDiscoveryMode(mode: DiscoveryMode) {
    setDiscoveryMode(mode);
    try { window.localStorage.setItem(DISCOVERY_MODE_STORAGE_KEY, mode); } catch { /* Keep the choice for this visit. */ }
  }

  useEffect(() => {
    if (!privateData.ready) return;
    function loadStorefront(raw: string | null, announce: boolean) {
      if (storefrontChangedBeforeSessionRef.current) {
        try {
          localStorage.setItem(STOREFRONT_STORAGE_KEY, JSON.stringify(storefrontRef.current));
          setStorefrontStorageNotice("");
        } catch {
          setStorefrontStorageNotice("Your storefront changed for this visit, but the browser could not save it.");
        }
        storefrontChangedBeforeSessionRef.current = false;
        setStorefrontReady(true);
        return;
      }
      if (raw === null) {
        const selection = catalogSelectionRef.current;
        const changed = storefrontRef.current !== DEFAULT_STOREFRONT;
        applyStorefront(DEFAULT_STOREFRONT, announce, selection !== null);
        if (changed && selection) void browseCuratedCatalogRef.current(selection.section, selection.retailer);
        setStorefrontStorageNotice("");
        return;
      }
      try {
        // An earlier retailer shortcut saved the US choice without JSON encoding.
        const saved: unknown = raw === "US" ? "US" : JSON.parse(raw);
        if (!isStorefront(saved)) throw new Error("Invalid storefront");
        const selection = catalogSelectionRef.current;
        const changed = storefrontRef.current !== saved;
        applyStorefront(saved, announce, selection !== null);
        if (changed && selection) void browseCuratedCatalogRef.current(selection.section, selection.retailer);
        setStorefrontStorageNotice("");
      } catch {
        setStorefrontStorageNotice("The saved storefront could not be read. Choose a storefront to replace it.");
      }
    }
    const timer = window.setTimeout(() => {
      try { loadStorefront(localStorage.getItem(STOREFRONT_STORAGE_KEY), false); }
      catch { setStorefrontStorageNotice("The storefront choice could not be loaded from this browser."); }
      setStorefrontReady(true);
    }, 0);
    function handleStorefrontStorage(event: StorageEvent) {
      if (event.key === STOREFRONT_STORAGE_KEY || event.key === null) {
        try { loadStorefront(localStorage.getItem(STOREFRONT_STORAGE_KEY), true); }
        catch { setStorefrontStorageNotice("The storefront choice could not be loaded from this browser."); }
      }
    }
    function handleReset() { loadStorefront(null, true); }
    privateEvents.addEventListener("storage", handleStorefrontStorage);
    privateEvents.addEventListener("paypal-markets-data-reset", handleReset);
    return () => {
      window.clearTimeout(timer);
      privateEvents.removeEventListener("storage", handleStorefrontStorage);
      privateEvents.removeEventListener("paypal-markets-data-reset", handleReset);
    };
  }, [applyStorefront, localStorage, privateData.ready, privateEvents]);

  function chooseStorefront(next: Storefront, preserveCatalogSelection = false) {
    if (!storefrontReady) return;
    const catalogSelection = preserveCatalogSelection ? catalogSelectionRef.current : null;
    applyStorefront(next, true, preserveCatalogSelection);
    if (catalogSelection) void browseCuratedCatalogRef.current(catalogSelection.section, catalogSelection.retailer);
    if (!privateData.ready) {
      storefrontChangedBeforeSessionRef.current = true;
      setStorefrontStorageNotice("Your storefront changed for this visit. It will be saved after your session is verified.");
      return;
    }
    try {
      localStorage.setItem(STOREFRONT_STORAGE_KEY, JSON.stringify(next));
      setStorefrontStorageNotice("");
    } catch {
      setStorefrontStorageNotice("Your storefront changed for this visit, but the browser could not save it.");
    }
  }

  useEffect(() => {
    if (!privateData.ready) return;
    let active = true;
    collectionScopeActive.current = true;
    function load() {
      try {
        const raw = localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY);
        const saved = readCollections(raw);
        if (!active) return;
        collectionBaseline.current = raw;
        collectionVersion.current += 1;
        setCollectionViewVersion(collectionVersion.current);
        setCollections(saved);
        setStorageError("");
        setStorageReadable(true);
        setCollectionReloadRequired(false);
      } catch (cause) {
        if (!active) return;
        collectionBaseline.current = undefined;
        collectionVersion.current += 1;
        setCollectionViewVersion(collectionVersion.current);
        const reason = cause instanceof Error ? cause.message : "";
        setStorageError(reason === "A saved product identifier needs recovery."
          ? "A saved product needs recovery. Your collections remain unchanged on this device. Export this local view in Settings to keep a copy; you can still search for products."
          : reason === "A saved collection identifier needs recovery."
            ? "A saved collection needs recovery. Your collections remain unchanged on this device. Export this local view in Settings to keep a copy; you can still search for products."
            : reason === "Saved collections need recovery."
              ? "Saved collections need recovery. Your data remains unchanged on this device. Export this local view in Settings to keep a copy; you can still search for products."
            : "Saved collections could not be loaded. Your existing browser data has not been changed.");
        setStorageReadable(false);
        setCollectionReloadRequired(true);
      }
      setLoaded(true);
    }
    const timer = window.setTimeout(() => {
      collectionBusyRef.current = false;
      setCollectionBusy(false);
      setLocksAvailable(collectionLocksAvailable());
      load();
      const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim();
      if (initialQuery && initialQuery.length <= 120) { queryRef.current = initialQuery; setQuery(initialQuery); }
    }, 0);
    function invalidate() {
      if (!active || suppressCollectionNotice.current) return;
      collectionBaseline.current = undefined;
      collectionVersion.current += 1;
      setCollectionViewVersion(collectionVersion.current);
      deleteReview.current = null;
      setDeletePending(false);
      setStorageReadable(false);
      setCollectionReloadRequired(true);
      setStorageError("Saved collections changed in another view. Your drafts remain here; reload the saved collections and review them before trying again.");
    }
    function handleStorage(event: StorageEvent) {
      if (event.key === SHOPPING_LISTS_STORAGE_KEY || event.key === LOCAL_DATA_RESET_SIGNAL || event.key === null) invalidate();
    }
    privateEvents.addEventListener("storage", handleStorage);
    privateEvents.addEventListener(COLLECTIONS_CHANGED_EVENT, invalidate);
    privateEvents.addEventListener("paypal-markets-data-reset", invalidate);
    return () => {
      active = false;
      privateScopeGeneration.current += 1;
      collectionScopeActive.current = false;
      collectionBusyRef.current = false;
      collectionBaseline.current = undefined;
      collectionVersion.current += 1;
      deleteReview.current = null;
      request.current?.abort();
      searchMoreRequest.current?.abort();
      catalogRequest.current?.abort();
      request.current = null;
      searchMoreRequest.current = null;
      catalogRequest.current = null;
      setLoading(false);
      setRefreshingKey(null);
      setSearchMoreLoading(false);
      setCatalogLoading(false);
      setCatalogMoreLoading(false);
      window.clearTimeout(timer);
      privateEvents.removeEventListener("storage", handleStorage);
      privateEvents.removeEventListener(COLLECTIONS_CHANGED_EVENT, invalidate);
      privateEvents.removeEventListener("paypal-markets-data-reset", invalidate);
    };
  }, [localStorage, privateData.ready, privateEvents]);

  useEffect(() => () => {
    request.current?.abort();
    searchMoreRequest.current?.abort();
    catalogRequest.current?.abort();
  }, []);

  const canMutateCollections = loaded && storageReadable && locksAvailable === true && !collectionBusy;

  function scopeIsCurrent() {
    if (!collectionScopeActive.current) return false;
    try { return privateEvents.dispatchEvent(new Event("paypal-markets-scope-liveness")); } catch { return false; }
  }

  function requireCollectionsReload(message: string) {
    collectionBaseline.current = undefined;
    collectionVersion.current += 1;
    setCollectionViewVersion(collectionVersion.current);
    deleteReview.current = null;
    setDeletePending(false);
    setStorageReadable(false);
    setCollectionReloadRequired(true);
    setStorageError(message);
  }

  async function persist(next: ShoppingCollection[], reviewed?: { baseline: string | null; version: number }, authorized: () => boolean = () => true) {
    if (!privateData.ready || !canMutateCollections || collectionBusyRef.current || collectionViewVersion !== collectionVersion.current) return false;
    const expected = reviewed ? reviewed.baseline : collectionBaseline.current;
    const version = reviewed?.version ?? collectionViewVersion;
    if (expected === undefined || version !== collectionVersion.current) return false;
    collectionBusyRef.current = true;
    setCollectionBusy(true);
    let attempted = false;
    const result = await tryCollectionLock(() => {
      if (!collectionScopeActive.current || collectionVersion.current !== version || !authorized()) return { kind: "changed" as const };
      try {
        const raw = localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY);
        if (raw !== expected) return { kind: "changed" as const };
        readCollections(raw);
        const encoded = serializeCollections(next);
        readCollections(encoded);
        if (!collectionScopeActive.current || collectionVersion.current !== version || !authorized()) return { kind: "changed" as const };
        if (raw !== encoded) {
          attempted = true;
          try { localStorage.setItem(SHOPPING_LISTS_STORAGE_KEY, encoded); }
          finally {
            // Native storage events do not notify other consumers in this document.
            suppressCollectionNotice.current = true;
            try { privateEvents.dispatchEvent(new Event(COLLECTIONS_CHANGED_EVENT)); } finally { suppressCollectionNotice.current = false; }
          }
          if (localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY) !== encoded) return { kind: "uncertain" as const };
        }
        return { kind: "saved" as const, raw: encoded };
      } catch {
        return { kind: attempted ? "uncertain" as const : "unavailable" as const };
      }
    });
    if (!scopeIsCurrent()) return false;
    collectionBusyRef.current = false;
    setCollectionBusy(false);
    if (collectionVersion.current !== version) {
      if (attempted) requireCollectionsReload("The last change may already have been saved. Reload and review your collections before trying again.");
      return false;
    }
    const outcome = result.kind === "acquired" ? result.value : result.kind === "unavailable" && attempted ? { kind: "uncertain" as const } : { kind: result.kind };
    if (outcome.kind === "saved") {
      try {
        if (localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY) !== outcome.raw) {
          requireCollectionsReload("Saved collections changed again. Your drafts remain here; reload and review them.");
          return false;
        }
      } catch {
        if (scopeIsCurrent()) requireCollectionsReload("The last change may already have been saved. Reload and review your collections.");
        return false;
      }
      collectionBaseline.current = outcome.raw;
      collectionVersion.current += 1;
      setCollectionViewVersion(collectionVersion.current);
      setCollections(next);
      setStorageError("");
      return true;
    }
    if (outcome.kind === "busy") setNotice("Another collection change is in progress. Nothing was saved; try again.");
    else if (outcome.kind === "unsupported") {
      setLocksAvailable(false);
      setStorageError("Saving collections requires a secure browser that supports coordination between tabs. You can still view and export them.");
    } else if (outcome.kind === "changed") requireCollectionsReload("Saved collections changed in another view. Your drafts remain here; reload and review them.");
    else requireCollectionsReload(outcome.kind === "uncertain"
      ? "The last change may already have been saved. Reload and review your collections before trying again."
      : "Saved collections could not be checked. Reload them before trying again; your drafts remain here.");
    return false;
  }

  function reloadSavedCollections() {
    if (!privateData.ready || collectionBusyRef.current || !scopeIsCurrent()) return;
    try {
      const raw = localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY);
      const saved = readCollections(raw);
      const selected = collections.find((item) => item.id === activeId);
      const reloadedSelected = selected && saved.find((item) => item.id === selected.id);
      if (renameOpen && selected && (!reloadedSelected || JSON.stringify(reloadedSelected) !== JSON.stringify(selected))) {
        const retained = { collection: selected.name, value: renameDraftRef.current };
        setRetainedRenames((drafts) => [...drafts, retained]);
        setRenameOpen(false);
        renameTargetId.current = null;
        setActiveId(null);
      }
      collectionBaseline.current = raw;
      collectionVersion.current += 1;
      setCollectionViewVersion(collectionVersion.current);
      deleteReview.current = null;
      setDeletePending(false);
      setCollections(saved);
      setLocksAvailable(collectionLocksAvailable());
      setStorageReadable(true);
      setCollectionReloadRequired(false);
      setStorageError("");
      setNotice("Saved collections reloaded. Review them before making changes.");
    } catch {
      setStorageError("Saved collections could not be read. Your existing data is unchanged; export this local view in Settings or try again.");
      setStorageReadable(false);
      setCollectionReloadRequired(true);
    }
  }

  function resetFilters() {
    setRetailer("all");
    setCurrency("all");
    setInStockOnly(true);
    setSort("recommended");
  }

  function selectCollection(id: string | null, version = collectionViewVersion) {
    if (version !== collectionVersion.current || !scopeIsCurrent()) return;
    const previous = collections.find((item) => item.id === activeId);
    if (renameOpen && previous && renameDraftRef.current !== previous.name) {
      const retained = { collection: previous.name, value: renameDraftRef.current };
      setRetainedRenames((drafts) => [...drafts, retained]);
    }
    collectionVersion.current += 1;
    setCollectionViewVersion(collectionVersion.current);
    deleteReview.current = null;
    setActiveId(id);
    setDeletePending(false);
    setRenameOpen(false);
    renameTargetId.current = null;
    setMoveDestinationByProduct({});
    setNotice("");
    resetFilters();
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (renderedPrivateScopeGeneration !== privateScopeGeneration.current) return;
    const searchQuery = query.trim();
    if (!storefrontReady || searchQuery.length < 2 || searchQuery.length > 120 || request.current) return;
    const priceFields = parsePriceRangeInputs(minimumPrice, maximumPrice);
    if (priceFields.error) { setError(priceFields.error); return; }
    const requestedStorefront = storefrontRef.current;
    rememberDiscoveryMode("search");
    setStorefrontChangeNotice("");
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    setCatalogLoading(false);
    setCatalogMoreLoading(false);
    searchMoreRequest.current?.abort();
    searchMoreRequest.current = null;
    setSearchMoreLoading(false);
    setSearchMoreError("");
    setSearchMoreStatus("");
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    replaceResults(null);
    setSimilarOfferSets({});
    selectCollection(null);
    try {
      const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: searchQuery, limit: SEARCH_PAGE_SIZE, storefront: requestedStorefront, ...(priceFields.range ? { priceRange: priceFields.range } : {}) }) }, controller.signal);
      if (controller.signal.aborted || request.current !== controller || storefrontRef.current !== requestedStorefront) return;
      if (!response.ok) throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Product search is unavailable right now. Please try again shortly.");
      const page = parseSearchPage(body, searchQuery, requestedStorefront);
      if (!page) throw new Error("The results did not match this storefront or search. Please try again.");
      replaceResults({ query: searchQuery, retrievedAt: page.retrievedAt, storefront: requestedStorefront, priceRange: page.priceRange, ...mergeProductPage(null, page.products, page.retrievedAt), nextPageToken: page.nextPageToken, pagesLoaded: 1, pagination: page.pagination });
    } catch (cause) {
      if (!controller.signal.aborted) setError(marketplaceRequestError(cause, "Product search is unavailable right now.", "Product search took too long. Check your connection and try again."));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  async function loadMoreSearchResults() {
    if (renderedPrivateScopeGeneration !== privateScopeGeneration.current || !storefrontReady || loading || refreshingKey !== null || searchMoreRequest.current || !results?.nextPageToken || resultsRef.current !== results || results.pagination !== "more" || results.storefront !== storefrontRef.current) return;
    const requestScopeGeneration = renderedPrivateScopeGeneration;
    const previous = results;
    const cursor = previous.nextPageToken;
    const controller = new AbortController();
    searchMoreRequest.current = controller;
    setSearchMoreLoading(true);
    setSearchMoreError("");
    setSearchMoreStatus("Loading more search results…");
    try {
      const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: previous.query, limit: SEARCH_PAGE_SIZE, storefront: previous.storefront, ...(previous.priceRange ? { priceRange: previous.priceRange } : {}), pageToken: cursor }),
      }, controller.signal);
      if (controller.signal.aborted || requestScopeGeneration !== privateScopeGeneration.current || storefrontRef.current !== previous.storefront || searchMoreRequest.current !== controller || resultsRef.current !== previous) return;
      if (!response.ok) throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : response.status === 400 ? "These search pages expired. Start the search again." : "More search results are unavailable. Try again.");
      const page = parseSearchPage(body, previous.query, previous.storefront);
      if (!page || !samePriceRange(page.priceRange, previous.priceRange)) throw new Error("The results did not match this storefront, search, or price range. Start the search again.");
      const merged = mergeProductPage(previous, page.products, page.retrievedAt);
      const pagesLoaded = previous.pagesLoaded + 1;
      const pagination = page.nextPageToken && (pagesLoaded >= SEARCH_MAX_PAGES || merged.products.length >= SEARCH_MAX_PRODUCTS)
        ? "limit" : page.nextPageToken === cursor ? "unavailable" : page.pagination;
      replaceResults({ ...previous, ...merged, retrievedAt: page.retrievedAt, pagesLoaded, pagination, nextPageToken: pagination === "more" ? page.nextPageToken : null });
      const added = merged.products.length - previous.products.length;
      setSearchMoreStatus(`${added} ${added === 1 ? "new product" : "new products"} loaded. ${merged.products.length} total.`);
    } catch (cause) {
      if (!controller.signal.aborted && searchMoreRequest.current === controller) {
        setSearchMoreStatus("");
        setSearchMoreError(marketplaceRequestError(cause, "More search results are unavailable. Try again.", "Loading more results took too long. Check your connection and try again."));
      }
    } finally {
      if (searchMoreRequest.current === controller) {
        searchMoreRequest.current = null;
        setSearchMoreLoading(false);
      }
    }
  }

  function clearCuratedSelection() {
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    catalogSelectionRef.current = null;
    setCatalog(null);
    setCatalogSection(null);
    setCatalogRetailer(null);
    setCatalogError("");
    setCatalogMoreError("");
    setCatalogFeedback(null);
    setCatalogLoading(false);
    setCatalogMoreLoading(false);
  }

  const browseCuratedCatalog = useCallback(async (section: CatalogSectionId | null, selectedRetailer: CatalogRetailerId | null = catalogRetailer, append = false) => {
    if ((!section && !selectedRetailer) || (append && (catalogMoreLoading || !catalog?.nextPageToken))) return;
    const previous = append ? catalog : null;
    if (!append) {
      catalogSelectionRef.current = { section, retailer: selectedRetailer };
    }
    const requestedStorefront = storefrontRef.current;
    catalogRequest.current?.abort();
    const controller = new AbortController(); catalogRequest.current = controller;
    setCatalogSection(section); setCatalogRetailer(selectedRetailer); setCatalogMoreError("");
    if (append) setCatalogMoreLoading(true);
    else { setCatalog(null); setCatalogError(""); setCatalogFeedback(null); setSimilarOfferSets({}); setCatalogLoading(true); setCatalogMoreLoading(false); }
    const params = new URLSearchParams({ storefront: requestedStorefront, limit: "24" });
    if (section) params.set("section", section);
    if (selectedRetailer) params.set("retailer", selectedRetailer);
    if (previous?.nextPageToken) params.set("pageToken", previous.nextPageToken);
    try {
      const { response, body } = await fetchMarketplaceJson(`/api/marketplace/catalog?${params}`, { headers: { Accept: "application/json" } }, controller.signal);
      if (controller.signal.aborted || storefrontRef.current !== requestedStorefront || catalogRequest.current !== controller) return;
      if (!response.ok) throw new Error(response.status === 429 ? "The curated catalog is busy. Wait a minute, then try again." : "This curated section is unavailable right now. Please try again shortly.");
      const parsed = parseCuratedCatalog(body, section, requestedStorefront, selectedRetailer, append);
      if (!parsed) throw new Error("The curated catalog returned an unexpected result.");
      const merged = mergeProductPage(previous, parsed.products, parsed.retrievedAt);
      setCatalog({ ...parsed, ...merged, pagesLoaded: (previous?.pagesLoaded ?? 0) + 1, nextPageToken: merged.products.length >= SEARCH_MAX_PRODUCTS || parsed.nextPageToken === previous?.nextPageToken ? null : parsed.nextPageToken });
    } catch (cause) {
      if (!controller.signal.aborted && catalogRequest.current === controller && storefrontRef.current === requestedStorefront) {
        const message = marketplaceRequestError(cause, "This curated section is unavailable right now.", "The curated catalog took too long. Check your connection and try again.");
        if (append) setCatalogMoreError(message); else setCatalogError(message);
      }
    } finally {
      if (catalogRequest.current === controller) { catalogRequest.current = null; setCatalogLoading(false); setCatalogMoreLoading(false); }
    }
  }, [catalog, catalogMoreLoading, catalogRetailer]);

  useEffect(() => {
    browseCuratedCatalogRef.current = browseCuratedCatalog;
  }, [browseCuratedCatalog]);

  async function refreshProductOffers(product: Product, retailerDomain?: string, source: "catalog" | "workspace" = "workspace", savedItem?: SavedItem, preferredUrl?: string, handoffWindow?: Window | null, allowAlternateInStock = false) {
    const closeHandoff = () => { if (handoffWindow && !handoffWindow.closed) handoffWindow.close(); };
    if (savedItem && needsSavedIdentityReview(savedItem)) {
      setNotice("This older saved item needs review. Search for it again and compare the results.");
      closeHandoff();
      return;
    }
    if (!storefrontReady || request.current || renderedPrivateScopeGeneration !== privateScopeGeneration.current) { closeHandoff(); return; }
    const requestedStorefront = storefrontRef.current;
    const requestedSelection = catalogSelectionRef.current;
    const savedRevision = savedItem ? collectionVersion.current : null;
    const searchQuery = product.title.trim().slice(0, 120);
    const key = `${product.id}:${retailerDomain ?? "collection"}`;
    const controller = new AbortController();
    searchMoreRequest.current?.abort();
    searchMoreRequest.current = null;
    setSearchMoreLoading(false);
    setSearchMoreError("");
    setSearchMoreStatus("");
    request.current = controller;
    setRefreshingKey(key);
    setError("");
    if (source === "catalog") setCatalogFeedback(null);
    else setNotice("");
    const requestIsCurrent = () => request.current === controller && !controller.signal.aborted &&
      storefrontRef.current === requestedStorefront &&
      (source !== "catalog" || catalogSelectionRef.current === requestedSelection) &&
      (savedRevision === null || collectionVersion.current === savedRevision);
    const feedback = (message: string, isError = false) => {
      if (source === "catalog") setCatalogFeedback({ productId: product.id, message, error: isError });
      else if (isError) { setError(message); setNotice(""); }
      else setNotice(message);
    };
    try {
      const exactResult = await fetchCurrentMarketplaceProduct(product.id, requestedStorefront, controller.signal);
      if (!requestIsCurrent()) { closeHandoff(); return; }
      const refreshed = exactResult?.product ?? null;
      const retrievedAt = exactResult?.retrievedAt ?? "";
      const checkedCandidates: Product[] = [];
      const match = refreshed
        ? matchCurrentOffer([refreshed], product.id, allowAlternateInStock ? undefined : retailerDomain, allowAlternateInStock ? undefined : preferredUrl, allowAlternateInStock)
        : { product: null, url: null };
      const currentUrl = match.url;
      if (!refreshed) {
        const receivedAt = currentTimeMs();
        let similarPage: Awaited<ReturnType<typeof fetchSimilarProductsPage>> = null;
        let suggestions = findSimilarInStockProducts(product, checkedCandidates);
        let similarError = "No similar in-stock items were found in the checked results.";
        if (!suggestions.length && similarProductQuery(product.title)) {
          try {
            similarPage = await fetchSimilarProductsPage(product.title, requestedStorefront, controller.signal);
            if (!requestIsCurrent()) { closeHandoff(); return; }
            if (similarPage) suggestions = findSimilarInStockProducts(product, similarPage.products);
          } catch (cause) {
            if (!requestIsCurrent()) { closeHandoff(); return; }
            similarError = marketplaceRequestError(cause, "Similar items could not be refreshed right now.", "Similar-item search took too long. Check your connection and try again.");
          }
        }
        let candidateSnapshot = mergeProductPage(null, checkedCandidates, retrievedAt || new Date(receivedAt).toISOString());
        if (similarPage) candidateSnapshot = mergeProductPage(candidateSnapshot, similarPage.products, similarPage.retrievedAt);
        setSimilarOfferSets((current) => ({ ...current, [product.id]: { products: suggestions, snapshot: { ...candidateSnapshot, storefront: requestedStorefront }, visible: true, loading: false, error: suggestions.length ? "" : similarError, unconfirmed: true } }));
        focusSimilarAlternatives(product.id);
        closeHandoff();
        feedback("Sorry, we couldn’t confirm this exact listing in the latest results. Similar options are shown below when available.");
        return;
      }

      const receivedAt = currentTimeMs();
      // Keep the complete fresh offer set for fallback decisions. A retailer
      // catalog view may intentionally display only its selected merchant.
      const currentOffers = refreshed.offers;
      const hasInStockLinks = refreshed.offers.some((offer) => offer.url && offer.availability === "InStock");
      const hasReportedInStockOffer = refreshed.offers.some((offer) => offer.availability === "InStock");
      const selectedRetailerOffers = retailerDomain ? currentOffers.filter((offer) => offer.domain === retailerDomain) : [];
      const selectedRetailerHasInStockLink = selectedRetailerOffers.some((offer) => offer.url && offer.availability === "InStock");
      const selectedRetailerUnavailable = Boolean(retailerDomain && !selectedRetailerHasInStockLink);
      const alternateExactOffer = selectedRetailerUnavailable
        ? preferredRetailerOffer(currentOffers.filter((offer) => offer.domain !== retailerDomain))
        : null;
      let updated = refreshed;
      if (source === "catalog") {
        if (requestedSelection?.retailer) {
          const listedRetailers = new Set(product.offers.map((offer) => offer.domain));
          // Expose fresh same-item offers after the selected retailer fails its
          // check, but let the customer choose which retailer to open.
          updated = { ...updated, offers: selectedRetailerUnavailable ? currentOffers : updated.offers.filter((offer) => listedRetailers.has(offer.domain)) };
        }
        setCatalog((current) => current?.storefront === requestedStorefront && current.retrievedById.has(product.id)
          ? { ...current, ...replaceProductSnapshot(current, updated, retrievedAt, receivedAt) }
          : current);
      } else if (savedItem) {
        queryRef.current = searchQuery;
        setQuery(searchQuery);
        replaceResults({ query: searchQuery, retrievedAt, storefront: requestedStorefront, priceRange: null, ...mergeProductPage(null, [updated], retrievedAt), nextPageToken: null, pagesLoaded: 1, pagination: "none" });
        selectCollection(null);
      } else {
        const current = resultsRef.current;
        if (current?.storefront === requestedStorefront && current.retrievedById.has(product.id)) {
          replaceResults({ ...current, ...replaceProductSnapshot(current, updated, retrievedAt, receivedAt) });
        }
      }
      const shouldShowSimilarOptions = !hasInStockLinks || selectedRetailerUnavailable;
      let similarPage: Awaited<ReturnType<typeof fetchSimilarProductsPage>> = null;
      let similarProducts = findSimilarInStockProducts(product, checkedCandidates);
      let similarError = "No similar in-stock items were found in the checked results.";
      if (shouldShowSimilarOptions && !similarProducts.length && similarProductQuery(product.title)) {
        try {
          similarPage = await fetchSimilarProductsPage(product.title, requestedStorefront, controller.signal);
          if (!requestIsCurrent()) { closeHandoff(); return; }
          if (similarPage) similarProducts = findSimilarInStockProducts(product, similarPage.products);
        } catch (cause) {
          if (!requestIsCurrent()) { closeHandoff(); return; }
          similarError = marketplaceRequestError(cause, "Similar items could not be refreshed right now.", "Similar-item search took too long. Check your connection and try again.");
        }
      }
      let candidateSnapshot = mergeProductPage(null, checkedCandidates, retrievedAt || new Date(receivedAt).toISOString());
      if (similarPage) candidateSnapshot = mergeProductPage(candidateSnapshot, similarPage.products, similarPage.retrievedAt);
      setSimilarOfferSets((current) => ({ ...current, [product.id]: {
        products: similarProducts,
        snapshot: { ...candidateSnapshot, storefront: requestedStorefront },
        visible: shouldShowSimilarOptions,
        loading: false,
        error: similarProducts.length ? "" : similarError,
        unconfirmed: false,
      } }));
      if (shouldShowSimilarOptions) focusSimilarAlternatives(product.id);
      if (handoffWindow) {
        const handoffUrl = currentUrl;
        if (handoffUrl && !handoffWindow.closed) {
          handoffWindow.opener = null;
          handoffWindow.location.replace(handoffUrl);
          feedback("Offers rechecked. Review the current price before visiting the retailer.");
        } else if (!currentUrl) {
          closeHandoff();
          feedback(alternateExactOffer
            ? `Sorry, ${retailerDomain} no longer reports this item in stock. The same item is reported in stock at ${alternateExactOffer.domain}; choose that offer below.`
            : retailerDomain
            ? selectedRetailerHasInStockLink ? `Sorry, we couldn’t confirm a safe current link at ${retailerDomain}. Review the refreshed offers below.` : "Sorry, we couldn’t confirm a current in-stock offer at that retailer. Similar options are below."
            : hasReportedInStockOffer ? "Sorry, a safe in-stock retailer link could not be confirmed. Similar options are below." : "Sorry, no in-stock retailer offers are available for this item. Similar options are below.");
        }
      } else if (alternateExactOffer) feedback(`Sorry, ${retailerDomain} no longer reports this item in stock. The same item is reported in stock at ${alternateExactOffer.domain}; choose that offer below.`);
      else if (!hasInStockLinks) feedback(hasReportedInStockOffer ? "Sorry, a safe in-stock retailer link could not be confirmed. Similar options are below when available." : "Sorry, Channel3 reports no in-stock offers for this item. Similar options are below when available.");
      else if (selectedRetailerUnavailable) feedback("Sorry, we couldn’t confirm a current in-stock offer at that retailer. Current offers and similar options are below.");
      else feedback("Offers rechecked. Review the current price before visiting the retailer.");
    } catch (cause) {
      closeHandoff();
      if (requestIsCurrent()) {
        feedback(marketplaceRequestError(cause, "Current offers could not be refreshed.", "Checking current offers took too long. Check your connection and try again."), true);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setRefreshingKey(null);
      }
    }
  }

  function prepareSavedItemSearch(product: Product) {
    const searchQuery = product.title.trim().slice(0, 120);
    queryRef.current = searchQuery;
    setQuery(searchQuery);
    setNotice("Search is ready. Compare the results and save a reviewed match in a different collection to keep this older item.");
    queryInput.current?.focus();
  }

  function setHandoffError(productId: string, source: "catalog" | "workspace", message: string) {
    if (source === "catalog") setCatalogFeedback({ productId, message, error: true });
    else { setError(message); setNotice(""); }
  }

  function retailerLinkProps(product: Product, offer: Offer, snapshot: (RetrievedProducts & { storefront: Storefront }) | null, source: "catalog" | "workspace", disclosureId: string, allowAlternateInStock = false) {
    const updating = isProductRefreshing(product, refreshingKey);
    function checkFreshness() {
      if (updating) return;
      const current = snapshot?.storefront === storefrontRef.current && renderedPrivateScopeGeneration === privateScopeGeneration.current;
      if (!current) return;
      const retailerDomain = allowAlternateInStock ? undefined : offer.domain;
      const preferredUrl = allowAlternateInStock ? undefined : offer.url ?? undefined;
      const handoffWindow = window.open("about:blank", "_blank");
      if (!handoffWindow) {
        setHandoffError(product.id, source, "Your browser blocked the retailer tab. Allow pop-ups, then check this offer again.");
        return;
      }
      handoffWindow.opener = null;
      handoffWindow.document.title = "PayPal Markets";
      void refreshProductOffers(product, retailerDomain, source, undefined, preferredUrl, handoffWindow, allowAlternateInStock);
    }
    return {
      type: "button" as const,
      disabled: updating,
      onClick: checkFreshness,
      "aria-describedby": disclosureId,
    };
  }

  function checkProductFromCard(product: Product, source: "catalog" | "workspace", retailerDomain?: string, allowAlternateInStock = false) {
    const handoffWindow = window.open("about:blank", "_blank");
    if (handoffWindow) {
      handoffWindow.opener = null;
      handoffWindow.document.title = "PayPal Markets";
    } else { setHandoffError(product.id, source, "Your browser blocked the retailer tab. Allow pop-ups, then check this offer again."); return; }
    void refreshProductOffers(product, retailerDomain, source, undefined, undefined, handoffWindow, allowAlternateInStock);
  }

  function focusSimilarAlternatives(productId: string) {
    window.requestAnimationFrame(() => {
      const section = document.getElementById(`marketplace-similar-${productId}`);
      section?.scrollIntoView({ behavior: "smooth", block: "center" });
      section?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
  }

  async function toggleSimilarAlternatives(product: Product, source: "catalog" | "workspace", pageSnapshot: (RetrievedProducts & { storefront: Storefront }) | null) {
    const existing = similarOfferSets[product.id];
    const currentSnapshot = pageSnapshot?.storefront === storefrontRef.current ? pageSnapshot : null;
    if (pageSnapshot && !currentSnapshot) return;
    if (existing?.visible && existing.products.length) {
      setSimilarOfferSets((current) => ({ ...current, [product.id]: { ...current[product.id], visible: false } }));
      return;
    }
    if (existing?.loading) return;
    const searchQuery = similarProductQuery(product.title);
    if (!searchQuery) {
      const snapshot = { ...mergeProductPage(null, [], new Date().toISOString()), storefront: storefrontRef.current };
      setSimilarOfferSets((current) => ({ ...current, [product.id]: { products: [], snapshot, visible: true, loading: false, error: "No similar in-stock items were found in this list. Try a broader product search.", unconfirmed: existing?.unconfirmed } }));
      return;
    }
    if (!storefrontReady || request.current || renderedPrivateScopeGeneration !== privateScopeGeneration.current) return;
    const requestedStorefront = storefrontRef.current;
    const requestedSelection = catalogSelectionRef.current;
    const controller = new AbortController();
    request.current = controller;
    setRefreshingKey(`${product.id}:similar`);
    setSimilarOfferSets((current) => ({ ...current, [product.id]: { products: [], snapshot: { ...mergeProductPage(null, [], new Date().toISOString()), storefront: requestedStorefront }, visible: true, loading: true, error: "", unconfirmed: existing?.unconfirmed } }));
    try {
      const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, limit: 24, storefront: requestedStorefront }),
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller || storefrontRef.current !== requestedStorefront || renderedPrivateScopeGeneration !== privateScopeGeneration.current || (source === "catalog" && catalogSelectionRef.current !== requestedSelection)) return;
      if (!response.ok) throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Similar items could not be loaded right now.");
      if (!record(body) || body.provider !== "Channel3" || body.query !== searchQuery || body.storefront !== requestedStorefront || body.currency !== storefrontCurrency(requestedStorefront) || !Array.isArray(body.products) || typeof body.retrievedAt !== "string") throw new Error("The similar items did not match this storefront. Please try again.");
      const products = body.products.slice(0, 24).map((candidate) => parseProduct(candidate, storefrontCurrency(requestedStorefront))).filter((candidate): candidate is Product => candidate !== null);
      const suggestions = findSimilarInStockProducts(product, products);
      const snapshot = { ...mergeProductPage(null, products, body.retrievedAt), storefront: requestedStorefront };
      setSimilarOfferSets((current) => ({ ...current, [product.id]: { products: suggestions, snapshot, visible: true, loading: false, error: suggestions.length ? "" : "No similar items are currently reported in stock.", unconfirmed: existing?.unconfirmed } }));
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        const snapshot = { ...mergeProductPage(null, [], new Date().toISOString()), storefront: requestedStorefront };
        setSimilarOfferSets((current) => ({ ...current, [product.id]: { products: [], snapshot, visible: true, loading: false, error: marketplaceRequestError(cause, "Similar items could not be loaded right now.", "Searching for similar items took too long. Check your connection and try again."), unconfirmed: existing?.unconfirmed } }));
      }
    } finally {
      if (request.current === controller) { request.current = null; setRefreshingKey(null); }
    }
  }

  function renderSimilarAlternatives(product: Product, source: "catalog" | "workspace", pageSnapshot: (RetrievedProducts & { storefront: Storefront }) | null) {
    const stored = similarOfferSets[product.id];
    const currentSnapshot = pageSnapshot?.storefront === storefront ? pageSnapshot : null;
    const storedMatchesStorefront = stored?.snapshot.storefront === storefront;
    const candidates = storedMatchesStorefront && stored?.visible ? stored.products : [];
    const unavailable = !product.offers.some((offer) => offer.url && offer.availability === "InStock");
    if (!stored && !unavailable) return null;
    const snapshot = storedMatchesStorefront ? stored?.snapshot : currentSnapshot;
    return <section id={`marketplace-similar-${product.id}`} className={styles.similarAlternatives} aria-label={`Similar items for ${product.title}`}>
      <button type="button" className={styles.similarToggle} onClick={() => void toggleSimilarAlternatives(product, source, currentSnapshot)} aria-expanded={Boolean(stored?.visible)} disabled={refreshingKey !== null}>
        {stored?.loading ? "Finding similar items…" : stored?.visible ? candidates.length ? "Hide similar items" : "Try similar search again" : unavailable ? "Find similar in-stock items" : "Sold out? Find similar"}
      </button>
      {unavailable && !stored?.visible && <p className={styles.smallCopy}>Sorry, Channel3 reports no in-stock link for this item.</p>}
      {stored?.visible && <div className={styles.similarPanel}>
        <p>Sorry, this item may be unavailable. Similar items are reported in stock by Channel3; retailer stock can differ.</p>
        {stored?.loading ? <span role="status">Finding similar items…</span> : candidates.length ? <ul>{candidates.map((candidate) => {
          const offer = preferredRetailerOffer(candidate.offers);
          const candidateSnapshot = currentSnapshot?.products.some((item) => item.id === candidate.id) ? currentSnapshot : snapshot;
          if (!offer || !candidateSnapshot) return null;
          return <li key={candidate.id}><button className={styles.offerLink} {...retailerLinkProps(candidate, offer, candidateSnapshot, source, "marketplace-commission-legend")} aria-label={`Check and open ${candidate.title} at ${offerHandoffLabel(offer)}`}>
            <span>{candidate.title}<small>{offerHandoffLabel(offer)} · Reported in stock</small></span>
            <strong>{money(offer.price.price, offer.price.currency)}<small>{offer.price.currency}</small></strong>
          </button></li>;
        })}</ul> : <span>{stored?.error || "No similar in-stock items were found in the current list."}</span>}
      </div>}
    </section>;
  }

  async function createCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = collectionName.trim();
    if (!name || !canMutateCollections || collectionNameRef.current !== collectionName) return;
    if (name.length > MAX_COLLECTION_NAME_LENGTH) { setNotice(`Keep collection names to ${MAX_COLLECTION_NAME_LENGTH} characters.`); return; }
    if (collections.length >= MAX_COLLECTIONS) { setNotice(`You can keep up to ${MAX_COLLECTIONS} collections on this device.`); return; }
    if (collections.some((list) => list.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setNotice("A collection with that name already exists. Choose a different name."); return; }
    const list = newCollection(name);
    const draft = collectionName;
    if (await persist([...collections, list]) && scopeIsCurrent()) {
      if (collectionNameRef.current === draft) { shoppingDraft.write(lease, ""); collectionNameRef.current = ""; setCollectionName(""); }
      setDestinationId(list.id);
      setNotice(`Created “${name}”. Search for products to add to it.`);
    }
  }

  const activeCollection = collections.find((list) => list.id === activeId) ?? null;
  const activeCatalogSection = CURATED_SECTIONS.find((section) => section.id === catalogSection) ?? null;
  const activeCatalogTitle = activeCatalogSection?.title ?? CHANNEL3_CURATED_RETAILERS.find((item) => item.id === catalogRetailer)?.title ?? "Curated";
  const catalogBusy = catalogLoading || catalogMoreLoading;
  const catalogPageStatus = catalogLoading
    ? `Loading ${activeCatalogTitle} products for ${storefrontLabel(storefront)}…`
    : catalog && !catalogMoreError
      ? (catalogMoreLoading
        ? `Loading more ${catalog.title} products for ${storefrontLabel(catalog.storefront)}. ${productCountLabel(catalog.products.length)} currently loaded.`
        : `${productCountLabel(catalog.products.length)} loaded for ${catalog.title} · ${storefrontLabel(catalog.storefront)}. ${catalog.nextPageToken ? "More pages are available." : catalog.products.length >= SEARCH_MAX_PRODUCTS ? "Browse limit reached." : "No more pages are available."}`)
      : catalogError
        ? `${activeCatalogTitle} could not load. See the message below and try again.`
        : "";
  const seasonalEdit = getChannel3SeasonalEdit(new Date(), storefront);
  const seasonalSectionIds = new Set(seasonalEdit.sectionIds);
  const seasonalSections = CURATED_SECTIONS.filter((section) => seasonalSectionIds.has(section.id));
  const otherSections = CURATED_SECTIONS.filter((section) => !seasonalSectionIds.has(section.id));
  const renderCuratedSection = (section: (typeof CURATED_SECTIONS)[number]) => (
    <button
      type="button"
      key={section.id}
      className={catalogSection === section.id ? styles.curatedCategorySelected : styles.curatedCategory}
      aria-pressed={catalogSection === section.id}
      disabled={catalogBusy}
      onClick={() => { chooseDiscoveryMode("browse"); void browseCuratedCatalog(section.id, null); }}
    >
      <span className={styles.curatedGlyph}><CuratedGlyph kind={section.glyph} /></span>
      <span className={styles.curatedCategoryCopy}><strong>{section.title}</strong></span>
      <span className={styles.curatedArrow} aria-hidden="true">↗</span>
    </button>
  );
  const destination = collections.find((list) => list.id === destinationId) ?? collections[0] ?? null;
  const items: SavedItem[] = useMemo(() => activeCollection ? activeCollection.items : (results?.products ?? []).map((product) => ({ product, retrievedAt: results?.retrievedById.get(product.id) ?? "", savedAt: "", storefront: results?.storefront ?? null })), [activeCollection, results]);
  const retailers = useMemo(() => [...new Set(items.flatMap((item) => item.product.offers.map((offer) => offer.domain)))].sort(), [items]);
  const currencies = useMemo(() => [...new Set(items.flatMap((item) => item.product.offers.map((offer) => offer.price.currency)))].sort(), [items]);
  const canSortPrice = currency !== "all" || currencies.length < 2;
  const activeSearchPriceRange = activeCollection === null ? results?.priceRange ?? null : null;
  const activeSearchPriceCurrency = activeCollection === null && results ? storefrontCurrency(results.storefront) : null;
  const displayedItems = useMemo(() => {
    const matchingOffers = (item: SavedItem) => item.product.offers.filter((offer) => (retailer === "all" || offer.domain === retailer) && (currency === "all" || offer.price.currency === currency) && (activeSearchPriceRange === null || (offer.price.currency === activeSearchPriceCurrency && (activeSearchPriceRange.minPrice === undefined || offer.price.price >= activeSearchPriceRange.minPrice) && (activeSearchPriceRange.maxPrice === undefined || offer.price.price <= activeSearchPriceRange.maxPrice)))).sort((a, b) => a.price.currency.localeCompare(b.price.currency) || a.price.price - b.price.price);
    const filtered = items.map((item) => {
      const matching = matchingOffers(item);
      const available = inStockOnly ? matching.filter((offer) => offer.availability === "InStock") : matching;
      const recovery = inStockOnly && available.length === 0 && similarOfferSets[item.product.id] ? matching : [];
      return { ...item, offers: available.length ? available : recovery };
    }).filter((item) => item.offers.length > 0 || similarOfferSets[item.product.id] !== undefined || (!activeSearchPriceRange && !inStockOnly && retailer === "all" && currency === "all" && item.product.offers.length === 0) || (activeCollection !== null && needsSavedIdentityReview(item) && retailer === "all" && currency === "all"));
    if (!filtered.length && inStockOnly && items.length) {
      const unavailable = items.map((item) => ({ ...item, offers: matchingOffers(item) })).filter((item) => item.offers.length > 0);
      if (unavailable.length) filtered.push(...unavailable);
    }
    if (sort !== "recommended" && canSortPrice) {
      filtered.sort((a, b) => {
        if (!a.offers.length) return 1;
        if (!b.offers.length) return -1;
        return (a.offers[0].price.price - b.offers[0].price.price) * (sort === "price-asc" ? 1 : -1);
      });
    }
    return filtered;
  }, [items, inStockOnly, retailer, currency, sort, canSortPrice, activeCollection, activeSearchPriceRange, activeSearchPriceCurrency, similarOfferSets]);
  const showingUnavailableFallback = inStockOnly && displayedItems.some((item) => item.offers.length > 0 && !item.offers.some((offer) => offer.availability === "InStock"));

  async function toggleSave(item: SavedItem) {
    if (!canMutateCollections) return;
    const target = activeCollection ?? destination ?? newCollection("Favorites");
    const previous = target.items.find((saved) => saved.product.id === item.product.id);
    const existing = Boolean(previous);
    if (!activeCollection && previous && needsSavedIdentityReview(previous)) {
      setNotice("An older saved item has this identifier. Choose a different collection to save this result and keep the older item.");
      return;
    }
    if (activeCollection && !existing) return;
    if (!existing && target.items.length >= MAX_ITEMS) { setNotice(`“${target.name}” is full. Create another collection or remove an item.`); return; }
    const savedItem: SavedItem = { product: snapshotProduct(item.product), retrievedAt: item.retrievedAt, savedAt: new Date().toISOString(), storefront: item.storefront, identitySource: "complete-id-v1" };
    const updated: ShoppingCollection = { ...target, items: existing ? target.items.filter((saved) => saved.product.id !== item.product.id) : [...target.items, savedItem] };
    const next = collections.some((list) => list.id === target.id) ? collections.map((list) => list.id === target.id ? updated : list) : [...collections, updated];
    if (await persist(next) && scopeIsCurrent()) {
      setDestinationId(target.id);
      setNotice(existing ? `Removed “${item.product.title}” from ${target.name}.` : `Saved “${item.product.title}” to ${target.name}.`);
    }
  }

  async function saveCuratedProduct(product: Product, retrievedAt: string, sourceStorefront: Storefront) {
    if (!canMutateCollections) return;
    const savedIn = collections.find((list) => list.items.some((item) => item.product.id === product.id));
    if (savedIn) {
      setNotice(`“${product.title}” is already saved locally in ${savedIn.name}.`);
      return;
    }

    const target = activeCollection ?? destination ?? newCollection("Favorites");
    if (target.items.length >= MAX_ITEMS) {
      setNotice(`“${target.name}” is full. Create another collection or remove an item.`);
      return;
    }
    const targetIsNew = !collections.some((list) => list.id === target.id);
    if (targetIsNew && collections.length >= MAX_COLLECTIONS) {
      setNotice(`You can keep up to ${MAX_COLLECTIONS} collections on this device.`);
      return;
    }

    const item: SavedItem = {
      product: snapshotProduct(product),
      retrievedAt,
      savedAt: new Date().toISOString(),
      storefront: sourceStorefront,
      identitySource: "complete-id-v1",
    };
    const next = targetIsNew
      ? [...collections, { ...target, items: [item] }]
      : collections.map((list) => list.id === target.id ? { ...list, items: [...list.items, item] } : list);
    if (await persist(next) && scopeIsCurrent()) {
      setDestinationId(target.id);
      setNotice(`Saved “${product.title}” to ${target.name} on this device.`);
    }
  }

  async function deleteCollection() {
    const reviewed = deleteReview.current;
    if (!activeCollection || !reviewed || reviewed.id !== activeCollection.id) return;
    const name = activeCollection.name;
    if (await persist(collections.filter((list) => list.id !== activeCollection.id), reviewed, () => deleteReview.current === reviewed) && scopeIsCurrent()) {
      deleteReview.current = null;
      selectCollection(null, reviewed.version + 1);
      setNotice(`Deleted “${name}”.`);
    }
  }

  function beginRenameCollection() {
    if (!activeCollection || !canMutateCollections || collectionViewVersion !== collectionVersion.current) return;
    renameTargetId.current = activeCollection.id;
    renameDraftRef.current = activeCollection.name;
    setRenameDraft(activeCollection.name);
    setRenameOpen(true);
    setDeletePending(false);
  }

  function beginDeleteCollection() {
    if (!activeCollection || !canMutateCollections || collectionViewVersion !== collectionVersion.current || collectionBaseline.current === undefined) return;
    if (renameOpen && renameDraftRef.current !== activeCollection.name) {
      setRetainedRenames((drafts) => [...drafts, { collection: activeCollection.name, value: renameDraftRef.current }]);
    }
    renameTargetId.current = null;
    deleteReview.current = { id: activeCollection.id, baseline: collectionBaseline.current, version: collectionViewVersion };
    setRenameOpen(false);
    setDeletePending(true);
  }

  async function renameCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCollection || !canMutateCollections || collectionViewVersion !== collectionVersion.current || renameTargetId.current !== activeCollection.id || renameDraftRef.current !== renameDraft) return;
    const name = renameDraft.trim();
    if (!name) {
      setNotice("Enter a collection name.");
      return;
    }
    if (name.length > MAX_COLLECTION_NAME_LENGTH) {
      setNotice(`Keep collection names to ${MAX_COLLECTION_NAME_LENGTH} characters.`);
      return;
    }
    if (collections.some((list) => list.id !== activeCollection.id && list.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setNotice("A collection with that name already exists. Choose a different name.");
      return;
    }
    if (name === activeCollection.name) {
      setRenameOpen(false);
      setNotice("Collection name unchanged.");
      return;
    }
    const previousName = activeCollection.name;
    const next = collections.map((list) => list.id === activeCollection.id ? { ...list, name } : list);
    const draft = renameDraft;
    if (await persist(next) && scopeIsCurrent()) {
      if (renameDraftRef.current === draft) setRenameOpen(false);
      setNotice(renameDraftRef.current === draft ? `Renamed “${previousName}” to “${name}”.` : "The name was saved. Your newer draft is still here.");
    }
  }

  async function moveSavedProduct(productId: string, targetId: string) {
    if (!activeCollection || !canMutateCollections) return;
    const item = activeCollection.items.find((saved) => saved.product.id === productId);
    const target = collections.find((list) => list.id === targetId);
    if (!item || !target || target.id === activeCollection.id) return;
    if (target.items.some((saved) => saved.product.id === productId)) {
      setNotice(`“${item.product.title}” is already in ${target.name}.`);
      return;
    }
    if (target.items.length >= MAX_ITEMS) {
      setNotice(`“${target.name}” is full. Remove an item before moving this product.`);
      return;
    }
    const next = collections.map((list) => {
      if (list.id === activeCollection.id) return { ...list, items: list.items.filter((saved) => saved.product.id !== productId) };
      if (list.id === target.id) return { ...list, items: [...list.items, item] };
      return list;
    });
    if (await persist(next) && scopeIsCurrent()) {
      setMoveDestinationByProduct((current) => {
        const updated = { ...current };
        delete updated[productId];
        return updated;
      });
      setNotice(`Moved “${item.product.title}” to ${target.name}.`);
    }
  }

  return (
    <div className={styles.marketplace}>
      <section className={styles.searchPanel} aria-labelledby="discover-title">
        <div className={styles.heroCopy}><span className={styles.eyebrow}>PRODUCT DISCOVERY / CHANNEL3</span><h2 id="discover-title">Find what you have in mind.</h2></div>
        <div className={styles.discoveryRoutes} role="group" aria-label="Choose how to explore the shared catalogue">
          <button type="button" aria-pressed={discoveryMode === "browse"} onClick={() => chooseDiscoveryMode("browse")}><strong>Browse categories</strong><span aria-hidden="true">▦</span></button>
          <button type="button" aria-pressed={discoveryMode === "search"} onClick={() => chooseDiscoveryMode("search")}><strong>Search products</strong><span aria-hidden="true">⌕</span></button>
        </div>
        <p id="marketplace-commission-legend" className={styles.commissionLegend} role="note">{COMMISSION_LEGEND}</p>
        <div className={styles.storefrontControl}>
          <label htmlFor="shopping-storefront">Shopping storefront</label>
          <select id="shopping-storefront" value={storefrontReady ? storefront : ""} disabled={!storefrontReady || catalogBusy} onChange={(event) => { if (isStorefront(event.currentTarget.value)) chooseStorefront(event.currentTarget.value); }}>
            {!storefrontReady && <option value="">Loading storefront…</option>}
            <option value="US">United States · USD</option>
            <option value="GB">United Kingdom · GBP</option>
          </select>
          {storefrontStorageNotice && <p className={styles.storefrontNotice} role="status">{storefrontStorageNotice}</p>}
          {storefrontChangeNotice && <p role="status" aria-live="polite">{storefrontChangeNotice}</p>}
        </div>
        {discoveryMode === "search" && <>
        <form className={styles.searchForm} onSubmit={search}>
          <label className={styles.srOnly} htmlFor="marketplace-query">What are you looking for?</label>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.7"/></svg>
          <input ref={queryInput} id="marketplace-query" type="search" value={query} onChange={(event) => { queryRef.current = event.target.value; setQuery(event.target.value); setStorefrontChangeNotice(""); }} minLength={2} maxLength={120} placeholder={`Wireless headphones under ${storefront === "GB" ? "£" : "$"}150`} required />
          <button type="submit" disabled={!storefrontReady || loading || refreshingKey !== null || query.trim().length < 2}>{loading ? "Searching…" : "Search offers"}<span aria-hidden="true">↗</span></button>
          <div className={styles.priceFilter} role="group" aria-label={`Price range in ${storefrontCurrency(storefront)}`}>
            <label htmlFor="marketplace-minimum-price">Minimum price <span>{storefrontCurrency(storefront)}</span><input id="marketplace-minimum-price" type="number" min="0" max="100000000" step="0.01" inputMode="decimal" value={minimumPrice} onChange={(event) => { setMinimumPrice(event.target.value); setError(""); }} disabled={!storefrontReady || loading} placeholder="No minimum" /></label>
            <label htmlFor="marketplace-maximum-price">Maximum price <span>{storefrontCurrency(storefront)}</span><input id="marketplace-maximum-price" type="number" min="0" max="100000000" step="0.01" inputMode="decimal" value={maximumPrice} onChange={(event) => { setMaximumPrice(event.target.value); setError(""); }} disabled={!storefrontReady || loading} placeholder="No maximum" /></label>
          </div>
        </form>
        <div className={styles.suggestions}><span>Start with an idea</span>{[{ label: "Desk essentials", query: "home office desk essentials" }, { label: "Everyday audio", query: `wireless headphones under ${storefront === "GB" ? "£" : "$"}150` }, { label: "Travel light", query: "lightweight carry on travel backpack" }].map((idea) => <button key={idea.label} type="button" onClick={() => { queryRef.current = idea.query; setQuery(idea.query); setStorefrontChangeNotice(""); queryInput.current?.focus(); }}>{idea.label}<span aria-hidden="true">↗</span></button>)}</div>
        </>}
      </section>

      {discoveryMode === "browse" && <section className={styles.curatedPanel} aria-labelledby="curated-catalog-title" aria-busy={catalogBusy}>
        <div className={styles.curatedHeader}>
          <div>
            <span className={styles.eyebrow}>CHANNEL3 / PAYPAL MARKETS PICKS</span>
            <h3 id="curated-catalog-title">Browse the shared catalog.</h3>
          </div>
          <span className={styles.sharedBadge}>APP-WIDE · READ ONLY</span>
        </div>
        <p id="curated-catalog-status" className={styles.curatedCatalogStatus} role="status" aria-live="polite">{catalogPageStatus}</p>

        {(catalogSection || catalogRetailer) && <button type="button" className={styles.curatedBackButton} onClick={clearCuratedSelection} disabled={catalogBusy}><span aria-hidden="true">←</span> Browse all categories and retailers</button>}
        {!catalogSection && !catalogRetailer && <>
        <div>
          <span className={styles.eyebrow}>SEASONAL · {seasonalEdit.label.toUpperCase()}</span>
          <div className={styles.curatedCategories} role="group" aria-label={`Seasonal ${seasonalEdit.label} categories`}>
            {seasonalSections.map(renderCuratedSection)}
          </div>
        </div>
        <div>
          <span className={styles.eyebrow}>ALL CATEGORIES</span>
          <div className={styles.curatedCategories} role="group" aria-label="All shared catalog categories">
            {otherSections.map(renderCuratedSection)}
          </div>
        </div>

        <div className={styles.retailerChoices} role="group" aria-label="Shop by retailer">
          {CHANNEL3_CURATED_RETAILERS.map(retailer => <button type="button" key={retailer.id} aria-pressed={catalogRetailer === retailer.id} disabled={catalogBusy} onClick={() => { chooseDiscoveryMode("browse"); void browseCuratedCatalog(null, retailer.id); }}>{retailer.title}<small>US retailer</small></button>)}
          {catalogRetailer && catalogSection && <button type="button" disabled={catalogBusy} onClick={() => void browseCuratedCatalog(catalogSection, null)}>All retailers</button>}
        </div>
        </>}
        {catalogRetailer && storefront === "GB" && <p className={styles.curatedPrivacyNote}>These US retailers may have no UK offers. Your region has not changed. <button type="button" onClick={() => chooseStorefront("US", true)}>Choose United States storefront</button></p>}
        {catalogError && (
          <div className={styles.curatedError} role="alert">
            <p>{catalogError}</p>
            {(catalogSection || catalogRetailer) && <button type="button" onClick={() => void browseCuratedCatalog(catalogSection, catalogRetailer)}>Retry {activeCatalogTitle.toLowerCase()}</button>}
          </div>
        )}
        {catalogLoading && (
          <div className={styles.curatedLoading} aria-hidden="true">
            <span className={styles.loadingDot} aria-hidden="true" />
            <span>Loading {activeCatalogTitle} products for {storefrontLabel(storefront)}…</span>
          </div>
        )}
        {catalog && !catalogLoading && (
          <div className={styles.curatedResults}>
            <div className={styles.curatedResultsHeading}>
              <div>
                <span className={styles.eyebrow}>SHARED CATALOG · {(catalog.section ?? catalog.retailer ?? "PRODUCTS").toUpperCase()}</span>
                <h4>{catalog.title}</h4>
                <p>{productCountLabel(catalog.products.length)} · {storefrontLabel(catalog.storefront)} · {catalog.pagesLoaded > 1 ? "Latest page retrieved" : "Retrieved"} {dateLabel(catalog.retrievedAt)}</p>
              </div>
              <span className={styles.sharedBadge}>NOT YOUR SAVED LISTS</span>
            </div>
            {catalog.products.length > 0 ? (
              <div className={styles.curatedProductGrid}>
                {catalog.products.map((product) => {
                  const image = primaryMarketplaceImage(product.images);
                  const availabilityUnconfirmed = similarOfferSets[product.id]?.unconfirmed === true;
                  const directOffer = availabilityUnconfirmed ? null : preferredRetailerOffer(product.offers);
                  const productLinkOffer = availabilityUnconfirmed ? null : directOffer ?? product.offers.find((candidate) => candidate.url && candidate.availability === "InStock") ?? null;
                  const offer = directOffer ?? product.offers[0];
                  const affiliateDisclosureId = "marketplace-commission-legend";
                  const savedIn = collections.find((list) => list.items.some((item) => item.product.id === product.id));
                  const savedNeedsReview = savedIn?.items.some((item) => item.product.id === product.id && needsSavedIdentityReview(item)) ?? false;
                  const checkedRetailer = catalog.retailer ? product.offers[0]?.domain : undefined;
                  return (
                    <article className={styles.curatedProduct} key={product.id} aria-busy={isProductRefreshing(product, refreshingKey)}>
                      <div className={styles.productImage}>
                        {image ? productLinkOffer ? (
                          <button className={styles.productImageLink} {...retailerLinkProps(product, productLinkOffer, catalog, "catalog", affiliateDisclosureId, !catalog.retailer)} aria-label={directOffer ? `Check and open ${product.title} at ${offerHandoffLabel(directOffer)}` : `Check current availability for ${product.title}`}>
                            <ProductImage src={image} alt={product.title} />
                          </button>
                        ) : <button type="button" className={`${styles.productImageLink} ${styles.productImageCheck}`} onClick={() => checkProductFromCard(product, "catalog", checkedRetailer, !catalog.retailer)} disabled={refreshingKey !== null} aria-label={`Check ${product.title}; if unavailable, find similar in-stock items`}><ProductImage src={image} alt="" /></button> : <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>}
                        <span className={styles.curatedProductBadge}>SHARED PICK</span>
                        <button
                          type="button"
                          className={`${styles.saveButton} ${savedIn ? styles.saved : ""}`}
                          onClick={() => saveCuratedProduct(product, catalog.retrievedById.get(product.id) ?? "", catalog.storefront)}
                          disabled={!canMutateCollections || Boolean(savedIn)}
                          aria-pressed={Boolean(savedIn)}
                          aria-label={savedNeedsReview ? `An older item in ${savedIn?.name} needs review` : savedIn ? `${product.title} saved locally in ${savedIn.name}` : `Save ${product.title} to a local list on this device`}
                        >
                          <span aria-hidden="true">{savedNeedsReview ? "!" : savedIn ? "✓" : "+"}</span>{savedNeedsReview ? "Review saved item" : savedIn ? "Saved here" : "Save locally"}
                        </button>
                      </div>
                      <div className={styles.productBody}>
                        <div className={styles.productHeading}><h4>{productLinkOffer ? (
                          <button className={styles.productTitleLink} {...retailerLinkProps(product, productLinkOffer, catalog, "catalog", affiliateDisclosureId, !catalog.retailer)} aria-label={directOffer ? `Check and open ${product.title} at ${offerHandoffLabel(directOffer)}` : `Check current availability for ${product.title}`}>
                            {product.title}
                          </button>
                        ) : <button type="button" className={styles.productTitleCheck} onClick={() => checkProductFromCard(product, "catalog", checkedRetailer, !catalog.retailer)} disabled={refreshingKey !== null} aria-label={`Check ${product.title}; if unavailable, find similar in-stock items`}>{product.title}</button>}</h4>{primaryOfferPrice(offer, isProductRefreshing(product, refreshingKey), false, availabilityUnconfirmed)}</div>
                        {offer ? (
                          <div className={styles.offerPrice}>
                            <span>{availabilityUnconfirmed ? "Earlier report · current availability unconfirmed" : offer.availability === "InStock" ? "Reported in stock" : "Reported out of stock"}</span>{product.offers.length <= 1 && <span className={styles.commission}>{commissionRate(offer.max_commission_rate)}</span>}
                          </div>
                        ) : <p className={styles.smallCopy}>Current retailer prices are not available for this product.</p>}
                        {directOffer ? (
                          <button className={styles.retailerLink} {...retailerLinkProps(product, directOffer, catalog, "catalog", affiliateDisclosureId)} aria-label={`Check and visit ${offerHandoffLabel(directOffer)} for ${product.title}`}>
                            <span>Check &amp; visit {offerHandoffLabel(directOffer)}</span><span aria-hidden="true">↗</span>
                          </button>
                        ) : <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, undefined, "catalog")} disabled={refreshingKey !== null}>
                          <span>{isProductRefreshing(product, refreshingKey) ? "Refreshing offers…" : "Refresh offers"}</span><span aria-hidden="true">↻</span>
                        </button>}
                        {catalogFeedback?.productId === product.id && <p className={catalogFeedback.error ? styles.error : styles.notice} role={catalogFeedback.error ? "alert" : "status"}>{catalogFeedback.message}</p>}
                        {product.offers.length > 1 && (
                          <section className={styles.offerDetails} aria-label={`Retailer offers for ${product.title}`}><h5>Retailer offers</h5>
                            <ul>
                              {product.offers.map((retailOffer, index) => (
                                <li key={`${retailOffer.domain}-${index}`}>
                                  {!availabilityUnconfirmed && retailOffer.url && retailOffer.availability === "InStock" ? (
                                    <button className={styles.offerLink} {...retailerLinkProps(product, retailOffer, catalog, "catalog", affiliateDisclosureId)} aria-label={offerChoiceLabel("Check and visit", product, retailOffer, index)}>
                                      <span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "Reported in stock" : "Reported out of stock"}</small></span>
                                      <strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionRate(retailOffer.max_commission_rate)}</small></strong>
                                    </button>
                                  ) : <div className={styles.offerSnapshot}><span>{retailOffer.domain}<small>Offer {index + 1} · {availabilityUnconfirmed ? "Earlier report · availability unconfirmed" : retailOffer.availability === "InStock" ? "Reported in stock · no link" : "Reported out of stock"}</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionRate(retailOffer.max_commission_rate)}</small></strong></div>}
                                </li>
                              ))}
                            </ul>
                          </section>
                        )}
                        {renderSimilarAlternatives(product, "catalog", catalog)}
                        <p className={styles.retrieved}>Retrieved {dateLabel(catalog.retrievedById.get(product.id) ?? "")}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className={styles.curatedEmpty}>
                <span className={styles.curatedEmptyMark}><BagIcon /></span>
                <div><strong>No products in this shared section yet.</strong><p>Browse the other curated categories or use product search below.</p></div>
              </div>
            )}
          </div>
        )}
        {catalogMoreError && <p className={styles.error} role="alert">{catalogMoreError}</p>}
        {catalog?.nextPageToken && <button className={styles.loadMore} type="button" disabled={catalogMoreLoading} onClick={() => void browseCuratedCatalog(catalogSection, catalogRetailer, true)}>{catalogMoreLoading ? "Loading more products…" : "Load more products"}</button>}
      </section>}

      {discoveryMode === "search" && error && <p className={styles.error} role="alert">{error}</p>}
      {storageError && <p className={styles.error} role="alert">{storageError}</p>}
      {locksAvailable === false && <p className={styles.smallCopy}>Saving collections requires a secure browser that supports coordination between tabs. You can still view them and export this local view in Settings.</p>}
      {collectionReloadRequired && <button type="button" onClick={reloadSavedCollections} disabled={collectionBusy}>Reload saved collections</button>}
      {retainedRenames.map((draft, index) => <label key={`${draft.collection}-${index}`} className={styles.smallCopy}>Unfinished name for {draft.collection}<input readOnly value={draft.value} aria-label={`Unfinished name for ${draft.collection}`} /></label>)}
      <p className={styles.notice} role="status" aria-live="polite">{notice}</p>

      {discoveryMode === "search" && <div className={styles.workspace}>
        <aside className={styles.collections} aria-labelledby="collections-title">
          <div className={styles.collectionsHeading}><span className={styles.folderIcon}><BagIcon /></span><div><span className={styles.eyebrow}>SAVED ON THIS DEVICE</span><h3 id="collections-title">Your collections</h3></div></div>
          <nav className={styles.collectionNav} aria-label="Shopping collections">
            <button type="button" className={activeCollection === null ? styles.selectedCollection : ""} onClick={() => selectCollection(null)} aria-pressed={!activeCollection}><span>Search results</span><span>{results?.products.length ?? 0}</span></button>
            {collections.map((list) => <button type="button" key={list.id} className={activeId === list.id ? styles.selectedCollection : ""} onClick={() => selectCollection(list.id)} aria-pressed={activeId === list.id}><span>{list.name}</span><span>{list.items.length}</span></button>)}
          </nav>
          {!collections.length && !loaded && <p className={styles.smallCopy}>Loading saved collections…</p>}
          <form className={styles.collectionForm} onSubmit={createCollection}>
            <label htmlFor="collection-name">Create a collection</label>
            <input id="collection-name" value={collectionName} onChange={(event) => { if (collectionViewVersion !== collectionVersion.current || !scopeIsCurrent() || shoppingDraft.write(lease, event.target.value) === "inactive") return; collectionNameRef.current = event.target.value; setCollectionName(event.target.value); }} aria-invalid={collectionName.trim().length > MAX_COLLECTION_NAME_LENGTH} aria-describedby={[collectionName.trim().length > MAX_COLLECTION_NAME_LENGTH ? "collection-name-error" : "", collectionName.length > MAX_RETAINED_COLLECTION_DRAFT_LENGTH ? "collection-draft-limit" : ""].filter(Boolean).join(" ") || undefined} placeholder="e.g. My next desk setup" required disabled={!loaded} />
            {collectionName.trim().length > MAX_COLLECTION_NAME_LENGTH && <span id="collection-name-error" className={styles.nameError}>Keep collection names to {MAX_COLLECTION_NAME_LENGTH} characters.</span>}
            {collectionName.length > MAX_RETAINED_COLLECTION_DRAFT_LENGTH && <span id="collection-draft-limit" className={styles.nameError}>This draft is too long to keep when this view is reverified. Copy it or shorten it before leaving.</span>}
            <button type="submit" disabled={!canMutateCollections || !collectionName.trim() || collections.length >= MAX_COLLECTIONS}>Create collection <span aria-hidden="true">+</span></button>
          </form>
        </aside>

        <section className={styles.results} aria-labelledby="offers-title" aria-busy={loading || searchMoreLoading || refreshingKey !== null}>
          <div className={styles.resultsHeading}>
            <div><span className={styles.eyebrow}>{activeCollection ? "YOUR SAVED FINDS" : results ? "RETAILER OFFERS" : "A LITTLE INSPIRATION"}</span><h3 id="offers-title">{activeCollection?.name ?? (results ? `Results for “${results.query}”` : "Your next find starts here")}</h3>{(activeCollection || results) && <p>{activeCollection ? `${activeCollection.items.length} saved ${activeCollection.items.length === 1 ? "product" : "products"} · Earlier offer snapshots may be from another storefront` : results ? `${results.products.length} ${results.products.length === 1 ? "product" : "products"} · ${results.storefront === "GB" ? "United Kingdom · GBP" : "United States · USD"} · ${results.pagesLoaded > 1 ? "Latest page retrieved" : "Retrieved"} ${dateLabel(results.retrievedAt)}` : null}</p>}{results && formatPriceRange(results.priceRange, storefrontCurrency(results.storefront)) && <p className={styles.appliedPriceFilter} role="status">{formatPriceRange(results.priceRange, storefrontCurrency(results.storefront))}</p>}</div>
            {activeCollection && <div className={styles.collectionActions}>
              <button className={styles.renameButton} type="button" disabled={!canMutateCollections} onClick={beginRenameCollection}>Rename</button>
              <button className={styles.deleteButton} type="button" disabled={!canMutateCollections} onClick={beginDeleteCollection}>Delete collection</button>
            </div>}
          </div>
          {renameOpen && activeCollection && <form className={styles.renameForm} onSubmit={renameCollection}>
            <label htmlFor="rename-collection">Collection name<input id="rename-collection" value={renameDraft} onChange={(event) => { if (collectionViewVersion !== collectionVersion.current || renameTargetId.current !== activeCollection.id || !scopeIsCurrent()) return; renameDraftRef.current = event.target.value; setRenameDraft(event.target.value); }} aria-invalid={renameDraft.trim().length > MAX_COLLECTION_NAME_LENGTH} aria-describedby={renameDraft.trim().length > MAX_COLLECTION_NAME_LENGTH ? "rename-collection-error" : undefined} required autoFocus />{renameDraft.trim().length > MAX_COLLECTION_NAME_LENGTH && <span id="rename-collection-error" className={styles.nameError}>Keep collection names to {MAX_COLLECTION_NAME_LENGTH} characters.</span>}</label>
            <button type="submit" disabled={!canMutateCollections || !renameDraft.trim()}>Save name</button>
            <button type="button" onClick={() => { if (collectionViewVersion === collectionVersion.current && renameTargetId.current === activeCollection.id) { renameTargetId.current = null; setRenameOpen(false); } }}>Cancel</button>
          </form>}
          {deletePending && activeCollection && <div className={styles.confirmDelete} role="group" aria-label="Confirm collection deletion"><p>Delete “{activeCollection.name}” and its saved products from this browser?</p><div><button type="button" onClick={() => { deleteReview.current = null; setDeletePending(false); }}>Keep collection</button><button type="button" disabled={!canMutateCollections} onClick={deleteCollection}>Delete collection</button></div></div>}
          {items.length > 0 && <div className={styles.filters}>
            <label>Retailer<select value={retailer} onChange={(event) => setRetailer(event.target.value)}><option value="all">All retailers</option>{retailers.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="all">All currencies</option>{currencies.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
            <label>Sort by<select value={canSortPrice ? sort : "recommended"} onChange={(event) => setSort(event.target.value as Sort)}><option value="recommended">{activeCollection ? "Saved order" : "Search order"}</option><option value="price-asc" disabled={!canSortPrice}>Price: low to high</option><option value="price-desc" disabled={!canSortPrice}>Price: high to low</option></select></label>
            <label className={styles.stockFilter}><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} />Reported in stock only</label>
            {!activeCollection && collections.length > 0 && <label className={styles.saveDestination}>Save new finds to<select value={destination?.id ?? ""} onChange={(event) => setDestinationId(event.target.value)}>{collections.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}
            {!canSortPrice && <p className={styles.currencyNote}>Choose a currency to compare products by price.</p>}
          </div>}
          {loading && !activeCollection ? <div className={styles.empty} role="status"><span className={styles.loadingDot} /><h4>Finding retailer offers</h4><p>Your search is on its way to Channel3.</p></div> : displayedItems.length ? <>
            {showingUnavailableFallback && <p className={styles.notice} role="status">Unavailable matches remain visible so you can find similar items.</p>}
            <p className={styles.resultCount}>{displayedItems.length} {displayedItems.length === 1 ? "product" : "products"} shown</p>
            <div className={styles.productGrid}>{displayedItems.map((item, itemIndex) => {
              const product = item.product;
              const image = primaryMarketplaceImage(product.images);
              const availabilityUnconfirmed = similarOfferSets[product.id]?.unconfirmed === true;
              const directOffer = activeCollection || availabilityUnconfirmed ? null : preferredRetailerOffer(item.offers);
              const productLinkOffer = activeCollection || availabilityUnconfirmed ? null : directOffer ?? item.offers.find((candidate) => candidate.url && candidate.availability === "InStock") ?? null;
              const offer = directOffer ?? item.offers[0];
              const moveTargets = activeCollection
                ? collections.filter((list) => list.id !== activeCollection.id && list.items.length < MAX_ITEMS && !list.items.some((saved) => saved.product.id === product.id))
                : [];
              const storedMoveTarget = moveDestinationByProduct[product.id];
              const moveTargetId = (moveTargets.find((list) => list.id === storedMoveTarget) ?? moveTargets[0])?.id ?? "";
              const moveControlId = `move-to-collection-${activeCollection?.id ?? "search"}-${itemIndex}`;
              const target = activeCollection ?? destination;
              const savedItem = target?.items.find((candidate) => candidate.product.id === product.id);
              const savedConflict = !activeCollection && Boolean(savedItem && needsSavedIdentityReview(savedItem));
              const saved = Boolean(savedItem) && !savedConflict;
              const identityNeedsReview = Boolean(activeCollection && needsSavedIdentityReview(item));
              const affiliateDisclosureId = "marketplace-commission-legend";
              const availabilityLabel = availabilityUnconfirmed
                ? "Earlier report · current availability unconfirmed"
                : offer?.availability === "InStock"
                ? (activeCollection ? "Previously reported in stock" : "Reported in stock")
                : (activeCollection ? "Previously reported out of stock" : "Reported out of stock");
              return <article className={styles.product} key={product.id} aria-busy={isProductRefreshing(product, refreshingKey)}>
                <div className={styles.productImage}>
                  {image ? productLinkOffer ? (
                    <button className={styles.productImageLink} {...retailerLinkProps(product, productLinkOffer, results, "workspace", affiliateDisclosureId, !activeCollection)} aria-label={directOffer ? `Check and open ${product.title} at ${offerHandoffLabel(directOffer)}` : `Check current availability for ${product.title}`}>
                      <ProductImage src={image} alt={product.title} />
                    </button>
                  ) : identityNeedsReview ? <ProductImage src={image} alt={product.title} /> : <button type="button" className={`${styles.productImageLink} ${styles.productImageCheck}`} onClick={() => checkProductFromCard(product, "workspace", undefined, true)} disabled={refreshingKey !== null} aria-label={`Check ${product.title}; if unavailable, find similar in-stock items`}><ProductImage src={image} alt="" /></button> : <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>}
                  <button type="button" className={`${styles.saveButton} ${saved ? styles.saved : ""}`} onClick={() => toggleSave(item)} disabled={!canMutateCollections || savedConflict} aria-pressed={saved} aria-label={savedConflict ? `Choose a different collection to save ${product.title}` : `${saved ? "Remove" : "Save"} ${product.title} ${saved ? "from" : "to"} ${target?.name ?? "Favorites"}`}><span aria-hidden="true">{saved ? "✓" : "+"}</span>{savedConflict ? "Choose another list" : saved ? "Saved" : "Save"}</button>
                </div>
                <div className={styles.productBody}>
                  <div className={styles.productHeading}><h4>{productLinkOffer ? (
                    <button className={styles.productTitleLink} {...retailerLinkProps(product, productLinkOffer, results, "workspace", affiliateDisclosureId, !activeCollection)} aria-label={directOffer ? `Check and open ${product.title} at ${offerHandoffLabel(directOffer)}` : `Check current availability for ${product.title}`}>
                      {product.title}
                    </button>
                  ) : identityNeedsReview ? product.title : <button type="button" className={styles.productTitleCheck} onClick={() => checkProductFromCard(product, "workspace", undefined, true)} disabled={refreshingKey !== null} aria-label={`Check ${product.title}; if unavailable, find similar in-stock items`}>{product.title}</button>}</h4>{primaryOfferPrice(offer, isProductRefreshing(product, refreshingKey), Boolean(activeCollection), availabilityUnconfirmed)}</div>
                  {offer && <div className={styles.offerPrice}><span>{availabilityLabel}</span>{item.offers.length <= 1 && <span className={styles.commission}>{commissionRate(offer.max_commission_rate)}</span>}</div>}
                  {savedConflict && <p className={styles.smallCopy}>An older item with this identifier is saved in this collection. Choose another collection to save this result without changing it.</p>}
                  {identityNeedsReview ? <><p className={styles.smallCopy}>This older saved item needs review: its original identifier may be incomplete. Search again and compare the results. Save a reviewed match in a different collection to keep this item.</p><button type="button" className={styles.retailerLink} onClick={() => prepareSavedItemSearch(product)}>Search for this item again <span aria-hidden="true">↗</span></button></> : activeCollection ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, undefined, "workspace", item)} disabled={refreshingKey !== null} aria-label={`Find current retailer offers for ${product.title}`}>
                    {refreshingKey === `${product.id}:collection` ? "Refreshing current offers…" : "Find current offers on Channel3"}<span aria-hidden="true">↻</span>
                  </button> : directOffer ? (
                    <button className={styles.retailerLink} {...retailerLinkProps(product, directOffer, results, "workspace", affiliateDisclosureId)} aria-label={`Check and visit ${offerHandoffLabel(directOffer)} for ${product.title}`}>
                      <span>Check &amp; visit {offerHandoffLabel(directOffer)}</span><span aria-hidden="true">↗</span>
                    </button>
                  ) : !activeCollection ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, undefined, "workspace")} disabled={refreshingKey !== null}>
                    <span>{isProductRefreshing(product, refreshingKey) ? "Refreshing offers…" : "Refresh offers"}</span><span aria-hidden="true">↻</span>
                  </button> : <p className={styles.smallCopy}>A retailer link is not available for this product.</p>}
                  {activeCollection && moveTargets.length > 0 && <div className={styles.moveCollectionForm}>
                    <label htmlFor={moveControlId}>Move to collection</label>
                    <select id={moveControlId} value={moveTargetId} onChange={(event) => setMoveDestinationByProduct((current) => ({ ...current, [product.id]: event.target.value }))}>
                      {moveTargets.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
                    </select>
                    <button type="button" onClick={() => moveSavedProduct(product.id, moveTargetId)} disabled={!canMutateCollections || !moveTargetId}>Move</button>
                  </div>}
                  {activeCollection && collections.length > 1 && moveTargets.length === 0 && <p className={styles.moveHint}>No other collection can accept this product right now.</p>}
                  {item.offers.length > 1 && (
                    <section className={styles.offerDetails} aria-label={`Retailer offers for ${product.title}`}><h5>Retailer offers</h5>
                      <ul>{item.offers.map((retailOffer, index) => (
                        <li key={`${retailOffer.domain}-${index}`}>
                          {!activeCollection && !availabilityUnconfirmed && retailOffer.url && retailOffer.availability === "InStock" ? (
                            <button className={styles.offerLink} {...retailerLinkProps(product, retailOffer, results, "workspace", affiliateDisclosureId)} aria-label={offerChoiceLabel("Check and visit", product, retailOffer, index)}>
                              <span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "Reported in stock" : "Reported out of stock"}</small></span>
                              <strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionRate(retailOffer.max_commission_rate)}</small></strong>
                            </button>
                          ) : (
                            <div className={styles.offerSnapshot}>
                              <span>{retailOffer.domain}<small>Offer {index + 1} · {availabilityUnconfirmed ? "Earlier report · availability unconfirmed" : retailOffer.availability === "InStock" ? activeCollection ? "Saved · reported in stock then" : "Reported in stock · no link" : activeCollection ? "Saved · reported out of stock then" : "Reported out of stock"}</small></span>
                              <strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionRate(retailOffer.max_commission_rate)}</small></strong>
                            </div>
                          )}
                        </li>
                      ))}</ul>
                    </section>
                  )}
                  {renderSimilarAlternatives(product, "workspace", results)}
                  <p className={styles.retrieved}>{activeCollection ? `Saved offer snapshot · ${item.storefront === "GB" ? "United Kingdom" : item.storefront === "US" ? "United States" : item.storefront ? `Storefront ${item.storefront}` : "Storefront not recorded"}` : "Retrieved"} · {dateLabel(item.retrievedAt)}</p>
                </div>
              </article>;
            })}</div>
          </> : <div className={styles.empty}><span className={styles.emptyIcon}><BagIcon /></span><h4>{items.length ? activeSearchPriceRange ? "No offers match this price range" : "No offers match these filters" : activeCollection ? "A collection ready for your next find" : results?.pagination === "more" ? "No products on these pages yet" : results ? "No products found for this search" : "Good choices start with a shortlist"}</h4>{(items.length > 0 || activeCollection || results) && <p>{items.length ? activeSearchPriceRange ? "Widen the budget or enter a new range, then search again." : "Try another retailer or include out-of-stock offers." : activeCollection ? "Search for a product, then save it to this collection." : results?.pagination === "more" ? "Load more results or try a broader search." : results ? "Try a broader product name or a different budget." : null}</p>}{items.length ? <button type="button" onClick={() => { if (activeSearchPriceRange) { setMinimumPrice(""); setMaximumPrice(""); queryInput.current?.focus(); } else { resetFilters(); setInStockOnly(false); } }}>{activeSearchPriceRange ? "Edit search budget" : "Reset filters"}</button> : <button type="button" onClick={() => queryInput.current?.focus()}>Start a search <span aria-hidden="true">↗</span></button>}</div>}
          {!activeCollection && results && !loading && <div className={styles.searchPagination}>
            <p className={styles.smallCopy} role="status" aria-live="polite">{searchMoreStatus}{results.pagination === "end" ? " You’ve reached the end of these search results." : results.pagination === "limit" ? ` This search is limited to ${SEARCH_MAX_PAGES} pages.` : results.pagination === "unavailable" ? " More pages are unavailable for this search." : ""}</p>
            {searchMoreError && <p className={styles.error} role="alert">{searchMoreError}</p>}
            {results.pagination === "more" && <button className={styles.loadMore} type="button" onClick={() => void loadMoreSearchResults()} disabled={searchMoreLoading || refreshingKey !== null} aria-busy={searchMoreLoading}>{searchMoreLoading ? "Loading more search results…" : "Load more search results"}</button>}
          </div>}
        </section>
      </div>}
      <section className={styles.offerDetails} aria-label="About offers and privacy">
        <h4>About offers &amp; privacy</h4>
        <p>Channel3 supplies products and offers for your chosen storefront. Prices, stock, shipping, and checkout can change at the retailer. Your portfolio display currency stays separate.</p>
        <p>Searches go to Channel3. Its image host receives your IP address when product images load.</p>
        <p>Saved collections stay in this browser and are not synced to PayPal or Channel3. Recheck saved offers before shopping.</p>
      </section>
    </div>
  );
}

function ProductImage({ src, alt }: { src: string; alt: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<{ source: string; url: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void fetchMarketplaceImage(src, controller.signal).then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ source: src, url: objectUrl });
      }).catch(() => {
        if (active) setImage({ source: src, url: null });
      });
    };
    let observer: IntersectionObserver | null = null;
    if (frame.current && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); load(); }
      }, { rootMargin: "150px" });
      observer.observe(frame.current);
    } else load();
    return () => {
      active = false;
      observer?.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  const visibleUrl = image?.source === src ? image.url : undefined;
  const content = visibleUrl === undefined ? <span className={styles.imageFallback}>Loading image…</span> : visibleUrl === null
    ? <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>
    : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={visibleUrl} alt={alt} onError={() => setImage({ source: src, url: null })} />
    );
  return <span ref={frame} className={styles.imageFrame}>{content}</span>;
}
