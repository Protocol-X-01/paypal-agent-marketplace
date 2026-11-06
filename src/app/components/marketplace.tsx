"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { isStorefront, storefrontCurrency, STOREFRONT_STORAGE_KEY, type Storefront } from "@/lib/channel3-storefront";
import { fetchMarketplaceJson, MarketplaceRequestTimeoutError } from "@/lib/marketplace-request";
import { fetchMarketplaceImage, isFreshVerifiedOffer, matchCurrentOffer, primaryMarketplaceImage, VERIFIED_OFFER_LIFETIME_MS } from "@/lib/marketplace-safety";
import { MAX_COLLECTIONS, MAX_ITEMS, parseProduct, readCollections, snapshotProduct, type Offer, type Product, type SavedItem, type ShoppingCollection } from "@/lib/marketplace-storage";
import { CHANNEL3_CURATED_SECTIONS, CHANNEL3_CURATED_RETAILERS } from "@/lib/channel3-catalog";
import styles from "./marketplace.module.css";
import { usePrivateDataScope } from "./customer-session";

export const SHOPPING_LISTS_STORAGE_KEY = "paypal-markets-shopping-lists-v1";
const DEFAULT_STOREFRONT: Storefront = "GB";

// Called only from user-triggered offer checks and link events.
function currentTimeMs() { return Date.now(); }

type SearchResults = { query: string; retrievedAt: string; storefront: Storefront; products: Product[] };
type Sort = "recommended" | "price-asc" | "price-desc";
type CatalogSectionId = (typeof CHANNEL3_CURATED_SECTIONS)[number]["id"];
type CatalogRetailerId = (typeof CHANNEL3_CURATED_RETAILERS)[number]["id"];
type CuratedCatalog = { provider: "Channel3"; section: CatalogSectionId | null; retailer: CatalogRetailerId | null; nextPageToken: string | null; title: string; retrievedAt: string; storefront: Storefront; products: Product[] };

const CURATED_SECTIONS = CHANNEL3_CURATED_SECTIONS.map(section => ({ id: section.id, title: section.title, detail: section.description, glyph: section.id }));
function commissionLabel(rate: number | null | undefined) { return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? `Up to ${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(rate * 100)}% affiliate commission` : "Commission unavailable"; }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    products,
  };
}

function money(value: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}

function offerHandoffLabel(offer: Offer): string {
  if (!offer.url) return offer.domain;
  const host = new URL(offer.url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return host === offer.domain ? offer.domain : `${offer.domain} via ${host}`;
}

function offerChoiceLabel(action: string, product: Product, offer: Offer, index: number) {
  return `${action} offer ${index + 1} for ${product.title}, ${offerHandoffLabel(offer)}, ${money(offer.price.price, offer.price.currency)} ${offer.price.currency}, ${offer.availability === "InStock" ? "in stock" : "out of stock"}`;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "date unavailable" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
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
  const localStorage = privateData.storage;
  const privateEvents = privateData.events;
  const [storefront, setStorefront] = useState<Storefront>(DEFAULT_STOREFRONT);
  const [storefrontReady, setStorefrontReady] = useState(false);
  const [storefrontStorageNotice, setStorefrontStorageNotice] = useState("");
  const [storefrontChangeNotice, setStorefrontChangeNotice] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [catalogSection, setCatalogSection] = useState<CatalogSectionId | null>(null);
  const [catalogRetailer, setCatalogRetailer] = useState<CatalogRetailerId | null>(null);
  const [catalogMoreLoading, setCatalogMoreLoading] = useState(false);
  const [catalogMoreError, setCatalogMoreError] = useState("");
  const [catalog, setCatalog] = useState<CuratedCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collections, setCollections] = useState<ShoppingCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageReadable, setStorageReadable] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [notice, setNotice] = useState("");
  const [collectionName, setCollectionName] = useState("");
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
  const [catalogFeedback, setCatalogFeedback] = useState<{ productId: string; message: string; error: boolean; review: boolean } | null>(null);
  const [verifiedOffers, setVerifiedOffers] = useState<{ productId: string; verifiedAt: number; storefront: Storefront } | null>(null);
  const request = useRef<AbortController | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const storefrontRef = useRef<Storefront>(DEFAULT_STOREFRONT);
  const queryRef = useRef("");
  const queryInput = useRef<HTMLInputElement>(null);
  const resultsSection = useRef<HTMLElement>(null);

  const applyStorefront = useCallback((next: Storefront, announce: boolean) => {
    if (storefrontRef.current === next) return;
    storefrontRef.current = next;
    request.current?.abort();
    catalogRequest.current?.abort();
    request.current = null;
    catalogRequest.current = null;
    setStorefront(next);
    setResults(null);
    setCatalog(null);
    setCatalogSection(null);
    setCatalogRetailer(null);
    setCatalogMoreLoading(false);
    setCatalogMoreError("");
    setCatalogLoading(false);
    setLoading(false);
    setRefreshingKey(null);
    setVerifiedOffers(null);
    setCatalogFeedback(null);
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
  }, []);

  useEffect(() => {
    if (!privateData.ready) return;
    function loadStorefront(raw: string | null, announce: boolean) {
      if (raw === null) {
        applyStorefront(DEFAULT_STOREFRONT, announce);
        setStorefrontStorageNotice("");
        return;
      }
      try {
        const saved: unknown = JSON.parse(raw);
        if (!isStorefront(saved)) throw new Error("Invalid storefront");
        applyStorefront(saved, announce);
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

  function chooseStorefront(next: Storefront) {
    if (!privateData.ready || !storefrontReady) return;
    applyStorefront(next, true);
    try {
      localStorage.setItem(STOREFRONT_STORAGE_KEY, JSON.stringify(next));
      setStorefrontStorageNotice("");
    } catch {
      setStorefrontStorageNotice("Your storefront changed for this visit, but the browser could not save it.");
    }
  }

  useEffect(() => {
    if (!privateData.ready) return;
    function load() {
      try {
        setCollections(readCollections(localStorage.getItem(SHOPPING_LISTS_STORAGE_KEY)));
        setStorageError("");
        setStorageReadable(true);
      } catch {
        setStorageError("Saved collections could not be loaded. Your existing browser data has not been changed.");
        setStorageReadable(false);
      }
      setLoaded(true);
    }
    const timer = window.setTimeout(() => {
      load();
      const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim();
      if (initialQuery && initialQuery.length <= 120) { queryRef.current = initialQuery; setQuery(initialQuery); }
    }, 0);
    function handleStorage(event: StorageEvent) {
      if (event.key === SHOPPING_LISTS_STORAGE_KEY || event.key === null) load();
    }
    privateEvents.addEventListener("storage", handleStorage);
    return () => {
      window.clearTimeout(timer);
      privateEvents.removeEventListener("storage", handleStorage);
      request.current?.abort();
      catalogRequest.current?.abort();
    };
  }, [localStorage, privateData.ready, privateEvents]);

  useEffect(() => {
    if (!verifiedOffers) return;
    const timer = window.setTimeout(() => setVerifiedOffers((current) => current === verifiedOffers ? null : current), VERIFIED_OFFER_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [verifiedOffers]);

  function persist(next: ShoppingCollection[]) {
    if (!privateData.ready || !storageReadable) return false;
    try {
      localStorage.setItem(SHOPPING_LISTS_STORAGE_KEY, JSON.stringify({ version: 1, collections: next }));
      setCollections(next);
      setStorageError("");
      return true;
    } catch {
      setStorageError("Your browser could not save this change. Free up browser storage or allow site storage, then try again.");
      return false;
    }
  }

  function resetFilters() {
    setRetailer("all");
    setCurrency("all");
    setInStockOnly(true);
    setSort("recommended");
  }

  function selectCollection(id: string | null) {
    setActiveId(id);
    setDeletePending(false);
    setRenameOpen(false);
    setMoveDestinationByProduct({});
    setNotice("");
    resetFilters();
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const searchQuery = query.trim();
    if (!storefrontReady || searchQuery.length < 2 || searchQuery.length > 120 || loading || refreshingKey) return;
    const requestedStorefront = storefrontRef.current;
    setStorefrontChangeNotice("");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setVerifiedOffers(null);
    setResults(null);
    selectCollection(null);
    try {
      const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: searchQuery, limit: 24, storefront: requestedStorefront }) }, controller.signal);
      if (controller.signal.aborted || storefrontRef.current !== requestedStorefront) return;
      if (!response.ok) throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Product search is unavailable right now. Please try again shortly.");
      if (!record(body) || body.provider !== "Channel3" || body.storefront !== requestedStorefront || body.currency !== storefrontCurrency(requestedStorefront) || !Array.isArray(body.products) || typeof body.retrievedAt !== "string") throw new Error("The results did not match this storefront. Please try again.");
      const products = body.products.slice(0, 24).map((product) => parseProduct(product, storefrontCurrency(requestedStorefront))).filter((product): product is Product => product !== null);
      setResults({ query: searchQuery, retrievedAt: body.retrievedAt, storefront: requestedStorefront, products });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof MarketplaceRequestTimeoutError ? "Product search took too long. Please try again." : cause instanceof Error ? cause.message : "Product search is unavailable right now.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function browseCuratedCatalog(section: CatalogSectionId | null, selectedRetailer: CatalogRetailerId | null = catalogRetailer, append = false) {
    if (!storefrontReady || (!section && !selectedRetailer) || (append && (catalogMoreLoading || !catalog?.nextPageToken))) return;
    const previous = append ? catalog : null;
    const requestedStorefront = storefrontRef.current;
    catalogRequest.current?.abort();
    const controller = new AbortController(); catalogRequest.current = controller;
    setCatalogSection(section); setCatalogRetailer(selectedRetailer); setCatalogMoreError("");
    if (append) setCatalogMoreLoading(true);
    else { setCatalog(null); setCatalogError(""); setCatalogFeedback(null); setCatalogLoading(true); setCatalogMoreLoading(false); }
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
      const seen = new Set<string>();
      const products = [...(previous?.products ?? []), ...parsed.products].filter(product => !seen.has(product.id) && !!seen.add(product.id)).slice(0, 96);
      setCatalog({ ...parsed, products, nextPageToken: products.length >= 96 || parsed.nextPageToken === previous?.nextPageToken ? null : parsed.nextPageToken });
    } catch (cause) {
      if (!controller.signal.aborted && catalogRequest.current === controller && storefrontRef.current === requestedStorefront) {
        const message = cause instanceof MarketplaceRequestTimeoutError ? "The curated catalog took too long. Please try again." : cause instanceof Error ? cause.message : "This curated section is unavailable right now.";
        if (append) setCatalogMoreError(message); else setCatalogError(message);
      }
    } finally {
      if (catalogRequest.current === controller) { catalogRequest.current = null; setCatalogLoading(false); setCatalogMoreLoading(false); }
    }
  }

  async function refreshProductOffers(product: Product, retailerDomain?: string, source: "catalog" | "workspace" = "workspace") {
    if (!storefrontReady || loading || refreshingKey) return;
    const requestedStorefront = storefrontRef.current;
    const searchQuery = product.title.trim().slice(0, 120);
    const key = `${product.id}:${retailerDomain ?? "collection"}`;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setRefreshingKey(key);
    setError("");
    setVerifiedOffers(null);
    const feedback = (message: string, isError = false, review = false) => {
      if (source === "catalog") setCatalogFeedback({ productId: product.id, message, error: isError, review });
      else if (isError) { setError(message); setNotice(""); }
      else setNotice(message);
    };
    feedback("Checking current retailer offers with Channel3…");

    try {
      const { response, body } = await fetchMarketplaceJson("/api/marketplace/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, limit: 24, storefront: requestedStorefront }),
      }, controller.signal);
      if (controller.signal.aborted || storefrontRef.current !== requestedStorefront) return;
      if (!response.ok) {
        throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Current offers could not be refreshed. Please try again shortly.");
      }
      if (!record(body) || body.provider !== "Channel3" || body.storefront !== requestedStorefront || body.currency !== storefrontCurrency(requestedStorefront) || !Array.isArray(body.products) || typeof body.retrievedAt !== "string") {
        throw new Error("The offers did not match this storefront. Please try again.");
      }

      const candidates = body.products.slice(0, 24).map((candidate) => parseProduct(candidate, storefrontCurrency(requestedStorefront))).filter((candidate): candidate is Product => candidate !== null);
      const { product: refreshed, url: currentUrl } = matchCurrentOffer(candidates, product.id, retailerDomain);
      if (!refreshed) {
        feedback("This exact item is no longer in the current catalog results. Search again to find a current match.");
        return;
      }

      queryRef.current = searchQuery;
      setQuery(searchQuery);
      setResults({ query: searchQuery, retrievedAt: body.retrievedAt, storefront: requestedStorefront, products: [refreshed] });
      selectCollection(null);
      const hasLinks = refreshed.offers.some((offer) => offer.url);
      if (hasLinks) setVerifiedOffers({ productId: refreshed.id, verifiedAt: currentTimeMs(), storefront: requestedStorefront });
      if (!hasLinks) feedback("No current retailer links are available for this product.");
      else if (retailerDomain && !currentUrl) feedback("The selected link changed or shares a host with other offers. Review the current offers below.", false, true);
      else feedback("Offers rechecked. Review the current price and choose a retailer below.", false, true);
    } catch (cause) {
      if (!controller.signal.aborted) {
        feedback(cause instanceof MarketplaceRequestTimeoutError ? "Checking current offers took too long. Please try again." : cause instanceof Error ? cause.message : "Current offers could not be refreshed.", true);
      }
    } finally {
      if (!controller.signal.aborted) setRefreshingKey(null);
    }
  }

  function checkVerifiedLink(event: MouseEvent<HTMLAnchorElement>, productId: string) {
    if (!verifiedOffers || verifiedOffers.productId !== productId || verifiedOffers.storefront !== storefrontRef.current || !isFreshVerifiedOffer(verifiedOffers.verifiedAt, currentTimeMs())) {
      event.preventDefault();
      setVerifiedOffers(null);
      setNotice("This offer check expired. Refresh the offers before visiting a retailer.");
    }
  }

  function createCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = collectionName.trim();
    if (!name || !loaded || !storageReadable) return;
    if (collections.length >= MAX_COLLECTIONS) { setNotice(`You can keep up to ${MAX_COLLECTIONS} collections on this device.`); return; }
    if (collections.some((list) => list.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setNotice("A collection with that name already exists. Choose a different name."); return; }
    const list = newCollection(name);
    if (persist([...collections, list])) {
      setCollectionName("");
      setDestinationId(list.id);
      setNotice(`Created “${name}”. Search for products to add to it.`);
    }
  }

  const activeCollection = collections.find((list) => list.id === activeId) ?? null;
  const activeCatalogSection = CURATED_SECTIONS.find((section) => section.id === catalogSection) ?? null;
  const destination = collections.find((list) => list.id === destinationId) ?? collections[0] ?? null;
  const items: SavedItem[] = useMemo(() => activeCollection ? activeCollection.items : (results?.products ?? []).map((product) => ({ product, retrievedAt: results?.retrievedAt ?? "", savedAt: "", storefront: results?.storefront ?? null })), [activeCollection, results]);
  const retailers = useMemo(() => [...new Set(items.flatMap((item) => item.product.offers.map((offer) => offer.domain)))].sort(), [items]);
  const currencies = useMemo(() => [...new Set(items.flatMap((item) => item.product.offers.map((offer) => offer.price.currency)))].sort(), [items]);
  const canSortPrice = currency !== "all" || currencies.length < 2;
  const displayedItems = useMemo(() => {
    const filtered = items.map((item) => ({ ...item, offers: item.product.offers.filter((offer) => (!inStockOnly || offer.availability === "InStock") && (retailer === "all" || offer.domain === retailer) && (currency === "all" || offer.price.currency === currency)).sort((a, b) => a.price.currency.localeCompare(b.price.currency) || a.price.price - b.price.price) })).filter((item) => item.offers.length > 0 || (!inStockOnly && retailer === "all" && currency === "all" && item.product.offers.length === 0));
    if (sort !== "recommended" && canSortPrice) {
      filtered.sort((a, b) => {
        if (!a.offers.length) return 1;
        if (!b.offers.length) return -1;
        return (a.offers[0].price.price - b.offers[0].price.price) * (sort === "price-asc" ? 1 : -1);
      });
    }
    return filtered;
  }, [items, inStockOnly, retailer, currency, sort, canSortPrice]);

  function toggleSave(item: SavedItem) {
    if (!loaded || !storageReadable) return;
    const target = activeCollection ?? destination ?? newCollection("Favourites");
    const existing = target.items.some((saved) => saved.product.id === item.product.id);
    if (!existing && target.items.length >= MAX_ITEMS) { setNotice(`“${target.name}” is full. Create another collection or remove an item.`); return; }
    const updated = { ...target, items: existing ? target.items.filter((saved) => saved.product.id !== item.product.id) : [...target.items, { ...item, product: snapshotProduct(item.product), savedAt: new Date().toISOString() }] };
    const next = collections.some((list) => list.id === target.id) ? collections.map((list) => list.id === target.id ? updated : list) : [...collections, updated];
    if (persist(next)) {
      setDestinationId(target.id);
      setNotice(existing ? `Removed “${item.product.title}” from ${target.name}.` : `Saved “${item.product.title}” to ${target.name}.`);
    }
  }

  function saveCuratedProduct(product: Product, retrievedAt: string, sourceStorefront: Storefront) {
    if (!loaded || !storageReadable) return;
    const savedIn = collections.find((list) => list.items.some((item) => item.product.id === product.id));
    if (savedIn) {
      setNotice(`“${product.title}” is already saved locally in ${savedIn.name}.`);
      return;
    }

    const target = activeCollection ?? destination ?? newCollection("Favourites");
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
    };
    const next = targetIsNew
      ? [...collections, { ...target, items: [item] }]
      : collections.map((list) => list.id === target.id ? { ...list, items: [...list.items, item] } : list);
    if (persist(next)) {
      setDestinationId(target.id);
      setNotice(`Saved “${product.title}” to ${target.name} on this device.`);
    }
  }

  function deleteCollection() {
    if (!activeCollection) return;
    const name = activeCollection.name;
    if (persist(collections.filter((list) => list.id !== activeCollection.id))) {
      selectCollection(null);
      setNotice(`Deleted “${name}”.`);
    }
  }

  function beginRenameCollection() {
    if (!activeCollection) return;
    setRenameDraft(activeCollection.name);
    setRenameOpen(true);
    setDeletePending(false);
  }

  function renameCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCollection || !loaded || !storageReadable) return;
    const name = renameDraft.trim();
    if (!name) {
      setNotice("Enter a collection name.");
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
    if (persist(next)) {
      setRenameOpen(false);
      setNotice(`Renamed “${previousName}” to “${name}”.`);
    }
  }

  function moveSavedProduct(productId: string, targetId: string) {
    if (!activeCollection || !loaded || !storageReadable) return;
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
    if (persist(next)) {
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
        <div className={styles.heroCopy}><span className={styles.eyebrow}>PRODUCT DISCOVERY / CHANNEL3</span><h2 id="discover-title">Find what you have in mind.</h2><p>Compare retailer offers. Keep your favourites together. Make your next purchase a considered one.</p></div>
        <div className={styles.storefrontControl}>
          <label htmlFor="shopping-storefront">Shopping storefront</label>
          <select id="shopping-storefront" aria-describedby="shopping-storefront-help" value={storefrontReady ? storefront : ""} disabled={!storefrontReady} onChange={(event) => { if (isStorefront(event.currentTarget.value)) chooseStorefront(event.currentTarget.value); }}>
            {!storefrontReady && <option value="">Loading storefront…</option>}
            <option value="GB">United Kingdom · GBP</option>
            <option value="US">United States · USD</option>
          </select>
          <p id="shopping-storefront-help">Offers are requested for this location. Your portfolio currency stays separate.</p>
          {storefrontStorageNotice && <p className={styles.storefrontNotice} role="status">{storefrontStorageNotice}</p>}
          {storefrontChangeNotice && <p role="status" aria-live="polite">{storefrontChangeNotice}</p>}
        </div>
        <form className={styles.searchForm} onSubmit={search}>
          <label className={styles.srOnly} htmlFor="marketplace-query">What are you looking for?</label>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.7"/></svg>
          <input ref={queryInput} id="marketplace-query" type="search" value={query} onChange={(event) => { queryRef.current = event.target.value; setQuery(event.target.value); setStorefrontChangeNotice(""); }} minLength={2} maxLength={120} placeholder={`Wireless headphones under ${storefront === "GB" ? "£" : "$"}150`} required />
          <button type="submit" disabled={!storefrontReady || loading || refreshingKey !== null || query.trim().length < 2}>{loading ? "Searching…" : "Search offers"}<span aria-hidden="true">↗</span></button>
        </form>
        <div className={styles.suggestions}><span>Start with an idea</span>{[{ label: "Desk essentials", query: "home office desk essentials" }, { label: "Everyday audio", query: `wireless headphones under ${storefront === "GB" ? "£" : "$"}150` }, { label: "Travel light", query: "lightweight carry on travel backpack" }].map((idea) => <button key={idea.label} type="button" onClick={() => { queryRef.current = idea.query; setQuery(idea.query); setStorefrontChangeNotice(""); queryInput.current?.focus(); }}>{idea.label}<span aria-hidden="true">↗</span></button>)}</div>
        <p className={styles.privacyNote}>Searches go to Channel3. Product images are requested from Channel3’s image host, which receives your IP address. Images may be unavailable if the host cannot provide them securely.</p>
      </section>

      <section className={styles.curatedPanel} aria-labelledby="curated-catalog-title" aria-busy={catalogLoading}>
        <div className={styles.curatedHeader}>
          <div>
            <span className={styles.eyebrow}>CHANNEL3 / PAYPAL MARKETS PICKS</span>
            <h3 id="curated-catalog-title">Browse the shared catalog.</h3>
            <p>Curated categories are available to everyone. Choose one to load current products and retailer offers.</p>
          </div>
          <span className={styles.sharedBadge}>APP-WIDE · READ ONLY</span>
        </div>

        <div className={styles.curatedCategories} role="group" aria-label="Shared catalog categories">
          {CURATED_SECTIONS.map((section) => (
            <button
              type="button"
              key={section.id}
              className={catalogSection === section.id ? styles.curatedCategorySelected : styles.curatedCategory}
              aria-pressed={catalogSection === section.id}
              disabled={!storefrontReady}
              onClick={() => void browseCuratedCatalog(section.id)}
            >
              <span className={styles.curatedGlyph}><CuratedGlyph kind={section.glyph} /></span>
              <span className={styles.curatedCategoryCopy}><strong>{section.title}</strong><small>{section.detail}</small></span>
              <span className={styles.curatedArrow} aria-hidden="true">↗</span>
            </button>
          ))}
        </div>

        <div className={styles.retailerChoices} role="group" aria-label="Shop by retailer">
          {CHANNEL3_CURATED_RETAILERS.map(retailer => <button type="button" key={retailer.id} aria-pressed={catalogRetailer === retailer.id} disabled={!storefrontReady} onClick={() => void browseCuratedCatalog(null, retailer.id)}>{retailer.title}<small>US retailer</small></button>)}
          {catalogRetailer && catalogSection && <button type="button" onClick={() => void browseCuratedCatalog(catalogSection, null)}>All retailers</button>}
        </div>
        {catalogRetailer && storefront === "GB" && <p className={styles.curatedPrivacyNote}>These US retailers may have no UK offers. Your region has not changed. <button type="button" onClick={() => { applyStorefront("US", true); try { localStorage.setItem(STOREFRONT_STORAGE_KEY, "US"); } catch { setStorefrontStorageNotice("This shopping region applies for this session."); } }}>Choose United States storefront</button></p>}
        <p className={styles.curatedPrivacyNote}>Commission is an advertised maximum for the affiliate, not customer cashback. Actual earnings may vary.</p>
        <p className={styles.curatedPrivacyNote}>This app-wide list is separate from your saved lists below. Saved price snapshots may come from an earlier storefront; check current offers before visiting a retailer.</p>

        {!catalogSection && !catalogRetailer && <p className={styles.curatedPrompt}>Choose a category to browse the shared picks. Nothing loads until you select one.</p>}
        {catalogError && (
          <div className={styles.curatedError} role="alert">
            <p>{catalogError}</p>
            {activeCatalogSection && <button type="button" onClick={() => void browseCuratedCatalog(activeCatalogSection.id)}>Retry {activeCatalogSection.title.toLowerCase()}</button>}
          </div>
        )}
        {catalogLoading && (
          <div className={styles.curatedLoading} role="status" aria-live="polite">
            <span className={styles.loadingDot} aria-hidden="true" />
            <span>Loading {activeCatalogSection?.title.toLowerCase() ?? "retailer"} picks from Channel3…</span>
          </div>
        )}
        {catalog && !catalogLoading && (
          <div className={styles.curatedResults} aria-live="polite">
            <div className={styles.curatedResultsHeading}>
              <div>
                <span className={styles.eyebrow}>SHARED CATALOG · {(catalog.section ?? catalog.retailer ?? "PRODUCTS").toUpperCase()}</span>
                <h4>{catalog.title}</h4>
                <p>{catalog.products.length} {catalog.products.length === 1 ? "product" : "products"} · {catalog.storefront === "GB" ? "United Kingdom · GBP" : "United States · USD"} · Retrieved {dateLabel(catalog.retrievedAt)}</p>
              </div>
              <span className={styles.sharedBadge}>NOT YOUR SAVED LISTS</span>
            </div>
            {catalog.products.length > 0 ? (
              <div className={styles.curatedProductGrid}>
                {catalog.products.map((product) => {
                  const image = primaryMarketplaceImage(product.images);
                  const offer = product.offers[0];
                  const savedIn = collections.find((list) => list.items.some((item) => item.product.id === product.id));
                  return (
                    <article className={styles.curatedProduct} key={product.id}>
                      <div className={styles.productImage}>
                        {image ? <ProductImage src={image} alt={product.title} /> : <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>}
                        <span className={styles.curatedProductBadge}>SHARED PICK</span>
                        <button
                          type="button"
                          className={`${styles.saveButton} ${savedIn ? styles.saved : ""}`}
                          onClick={() => saveCuratedProduct(product, catalog.retrievedAt, catalog.storefront)}
                          disabled={!loaded || !storageReadable || Boolean(savedIn)}
                          aria-pressed={Boolean(savedIn)}
                          aria-label={savedIn ? `${product.title} saved locally in ${savedIn.name}` : `Save ${product.title} to a local list on this device`}
                        >
                          <span aria-hidden="true">{savedIn ? "✓" : "+"}</span>{savedIn ? "Saved here" : "Save locally"}
                        </button>
                      </div>
                      <div className={styles.productBody}>
                        <h4>{product.title}</h4>
                        {offer ? (
                          <div className={styles.offerPrice}>
                            <strong>{money(offer.price.price, offer.price.currency)}</strong>
                            <span>{offer.price.currency} · {offer.availability === "InStock" ? "In stock" : "Out of stock"}</span><span className={styles.commission}>{commissionLabel(offer.max_commission_rate)}</span>
                          </div>
                        ) : <p className={styles.smallCopy}>Current retailer prices are not available for this product.</p>}
                        {offer?.url
                          ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, offer.domain, "catalog")} disabled={loading || refreshingKey !== null} aria-label={`Check current ${offer.domain} offers for ${product.title}`}><span>{refreshingKey === `${product.id}:${offer.domain}` ? "Checking current offer…" : "Check current offers"}</span><span aria-hidden="true">↻</span></button>
                          : <p className={styles.smallCopy}>A retailer link is not available for this product.</p>}
                        {catalogFeedback?.productId === product.id && <p className={catalogFeedback.error ? styles.error : styles.notice} role={catalogFeedback.error ? "alert" : "status"}>{catalogFeedback.message}</p>}
                        {catalogFeedback?.productId === product.id && catalogFeedback.review && <button type="button" className={styles.reviewOffers} onClick={() => { resultsSection.current?.scrollIntoView({ block: "start", behavior: "auto" }); resultsSection.current?.focus({ preventScroll: true }); }}>Review current offers <span aria-hidden="true">↓</span></button>}
                        {product.offers.length > 1 && (
                          <details className={styles.offerDetails}>
                            <summary>Compare {product.offers.length} retailer offers</summary>
                            <ul>
                              {product.offers.map((retailOffer, index) => (
                                <li key={`${retailOffer.domain}-${index}`}>
                                  {retailOffer.url
                                    ? <button type="button" className={styles.offerLink} onClick={() => void refreshProductOffers(product, retailOffer.domain, "catalog")} disabled={loading || refreshingKey !== null} aria-label={offerChoiceLabel("Check current", product, retailOffer, index)}><span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Check before visiting</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionLabel(retailOffer.max_commission_rate)}</small></strong></button>
                                    : <div className={styles.offerSnapshot}><span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · No retailer link</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionLabel(retailOffer.max_commission_rate)}</small></strong></div>}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <p className={styles.retrieved}>Offer details were retrieved {dateLabel(catalog.retrievedAt)}. Price, stock, shipping, and checkout can change at the retailer.</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className={styles.curatedEmpty} role="status">
                <span className={styles.curatedEmptyMark}><BagIcon /></span>
                <div><strong>No products in this shared section yet.</strong><p>Browse the other curated categories or use product search below.</p></div>
              </div>
            )}
          </div>
        )}
        {catalogMoreError && <p className={styles.error} role="alert">{catalogMoreError}</p>}
        {catalog?.nextPageToken && <button className={styles.loadMore} type="button" disabled={catalogMoreLoading} onClick={() => void browseCuratedCatalog(catalogSection, catalogRetailer, true)}>{catalogMoreLoading ? "Loading more products…" : "Load more products"}</button>}
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {storageError && <p className={styles.error} role="alert">{storageError}</p>}
      <p className={styles.notice} role="status" aria-live="polite">{notice}</p>

      <div className={styles.workspace}>
        <aside className={styles.collections} aria-labelledby="collections-title">
          <div className={styles.collectionsHeading}><span className={styles.folderIcon}><BagIcon /></span><div><span className={styles.eyebrow}>SAVED ON THIS DEVICE</span><h3 id="collections-title">Your collections</h3></div></div>
          <nav className={styles.collectionNav} aria-label="Shopping collections">
            <button type="button" className={activeCollection === null ? styles.selectedCollection : ""} onClick={() => selectCollection(null)} aria-pressed={!activeCollection}><span>Search results</span><span>{results?.products.length ?? 0}</span></button>
            {collections.map((list) => <button type="button" key={list.id} className={activeId === list.id ? styles.selectedCollection : ""} onClick={() => selectCollection(list.id)} aria-pressed={activeId === list.id}><span>{list.name}</span><span>{list.items.length}</span></button>)}
          </nav>
          {!collections.length && <p className={styles.smallCopy}>{loaded ? "A place for your next desk setup, travel kit, or everyday favourites." : "Loading saved collections…"}</p>}
          <form className={styles.collectionForm} onSubmit={createCollection}>
            <label htmlFor="collection-name">Create a collection</label>
            <input id="collection-name" value={collectionName} onChange={(event) => setCollectionName(event.target.value)} maxLength={40} placeholder="e.g. My next desk setup" required disabled={!loaded || !storageReadable} />
            <button type="submit" disabled={!loaded || !storageReadable || !collectionName.trim() || collections.length >= MAX_COLLECTIONS}>Create collection <span aria-hidden="true">+</span></button>
          </form>
          <p className={styles.privacyNote}>Collections stay in this browser. They are not synced to your PayPal account or Channel3.</p>
        </aside>

        <section ref={resultsSection} tabIndex={-1} className={styles.results} aria-labelledby="offers-title" aria-busy={loading || refreshingKey !== null}>
          <div className={styles.resultsHeading}>
            <div><span className={styles.eyebrow}>{activeCollection ? "YOUR SAVED FINDS" : results ? "RETAILER OFFERS" : "A LITTLE INSPIRATION"}</span><h3 id="offers-title">{activeCollection?.name ?? (results ? `Results for “${results.query}”` : "Your next find starts here")}</h3><p>{activeCollection ? `${activeCollection.items.length} saved ${activeCollection.items.length === 1 ? "product" : "products"} · Earlier offer snapshots may be from another storefront` : results ? `${results.products.length} ${results.products.length === 1 ? "product" : "products"} · ${results.storefront === "GB" ? "United Kingdom · GBP" : "United States · USD"} · Retrieved ${dateLabel(results.retrievedAt)}` : "Search with a product, a budget, or a few details that matter to you."}</p></div>
            {activeCollection && <div className={styles.collectionActions}>
              <button className={styles.renameButton} type="button" onClick={beginRenameCollection}>Rename</button>
              <button className={styles.deleteButton} type="button" onClick={() => { setRenameOpen(false); setDeletePending(true); }}>Delete collection</button>
            </div>}
          </div>
          {renameOpen && activeCollection && <form className={styles.renameForm} onSubmit={renameCollection}>
            <label htmlFor="rename-collection">Collection name<input id="rename-collection" value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={40} required autoFocus /></label>
            <button type="submit" disabled={!loaded || !storageReadable || !renameDraft.trim()}>Save name</button>
            <button type="button" onClick={() => setRenameOpen(false)}>Cancel</button>
          </form>}
          {deletePending && activeCollection && <div className={styles.confirmDelete} role="group" aria-label="Confirm collection deletion"><p>Delete “{activeCollection.name}” and its saved products from this browser?</p><div><button type="button" onClick={() => setDeletePending(false)}>Keep collection</button><button type="button" onClick={deleteCollection}>Delete collection</button></div></div>}
          {items.length > 0 && <div className={styles.filters}>
            <label>Retailer<select value={retailer} onChange={(event) => setRetailer(event.target.value)}><option value="all">All retailers</option>{retailers.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="all">All currencies</option>{currencies.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
            <label>Sort by<select value={canSortPrice ? sort : "recommended"} onChange={(event) => setSort(event.target.value as Sort)}><option value="recommended">{activeCollection ? "Saved order" : "Search order"}</option><option value="price-asc" disabled={!canSortPrice}>Price: low to high</option><option value="price-desc" disabled={!canSortPrice}>Price: high to low</option></select></label>
            <label className={styles.stockFilter}><input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} />In stock only</label>
            {!activeCollection && collections.length > 0 && <label className={styles.saveDestination}>Save new finds to<select value={destination?.id ?? ""} onChange={(event) => setDestinationId(event.target.value)}>{collections.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}
            {!canSortPrice && <p className={styles.currencyNote}>Choose a currency to compare products by price.</p>}
          </div>}
          {loading && !activeCollection ? <div className={styles.empty} role="status"><span className={styles.loadingDot} /><h4>Finding retailer offers</h4><p>Your search is on its way to Channel3.</p></div> : displayedItems.length ? <>
            <p className={styles.resultCount}>{displayedItems.length} {displayedItems.length === 1 ? "product" : "products"} shown</p>
            <div className={styles.productGrid}>{displayedItems.map((item, itemIndex) => {
              const product = item.product;
              const image = primaryMarketplaceImage(product.images);
              const offer = item.offers[0];
              const moveTargets = activeCollection
                ? collections.filter((list) => list.id !== activeCollection.id && list.items.length < MAX_ITEMS && !list.items.some((saved) => saved.product.id === product.id))
                : [];
              const storedMoveTarget = moveDestinationByProduct[product.id];
              const moveTargetId = (moveTargets.find((list) => list.id === storedMoveTarget) ?? moveTargets[0])?.id ?? "";
              const moveControlId = `move-to-collection-${activeCollection?.id ?? "search"}-${itemIndex}`;
              const target = activeCollection ?? destination;
              const saved = target?.items.some((savedItem) => savedItem.product.id === product.id) ?? false;
              const verified = !activeCollection && verifiedOffers?.productId === product.id && verifiedOffers.storefront === storefront;
              return <article className={styles.product} key={product.id}>
                <div className={styles.productImage}>{image ? <ProductImage src={image} alt={product.title} /> : <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>}<button type="button" className={`${styles.saveButton} ${saved ? styles.saved : ""}`} onClick={() => toggleSave(item)} disabled={!loaded || !storageReadable} aria-pressed={saved} aria-label={`${saved ? "Remove" : "Save"} ${product.title} ${saved ? "from" : "to"} ${target?.name ?? "Favourites"}`}><span aria-hidden="true">{saved ? "✓" : "+"}</span>{saved ? "Saved" : "Save"}</button></div>
                <div className={styles.productBody}><h4>{product.title}</h4>{offer && <div className={styles.offerPrice}><strong>{money(offer.price.price, offer.price.currency)}</strong><span>{offer.price.currency} · {offer.availability === "InStock" ? "In stock" : "Out of stock"}</span><span className={styles.commission}>{commissionLabel(offer.max_commission_rate)}</span></div>}
                  {activeCollection ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product)} disabled={refreshingKey !== null} aria-label={`Find current retailer offers for ${product.title}`}>
                    {refreshingKey === `${product.id}:collection` ? "Refreshing current offers…" : "Find current offers on Channel3"}<span aria-hidden="true">↻</span>
                  </button> : offer?.url ? verified ? <a className={styles.retailerLink} href={offer.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={(event) => checkVerifiedLink(event, product.id)} onAuxClick={(event) => checkVerifiedLink(event, product.id)} onContextMenu={(event) => checkVerifiedLink(event, product.id)} aria-label={`Visit ${offerHandoffLabel(offer)} for ${product.title}`}><span>Visit {offerHandoffLabel(offer)}</span><span aria-hidden="true">↗</span></a> : <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, offer.domain)} disabled={loading || refreshingKey !== null} aria-label={`Check current ${offer.domain} offers for ${product.title}`}>
                    {refreshingKey === `${product.id}:${offer.domain}` ? "Checking current offer…" : "Check current offers"}<span aria-hidden="true">↻</span>
                  </button> : <p className={styles.smallCopy}>No retailer offer is available in this search.</p>}
                  {verified && <p className={styles.smallCopy}>Rechecked for this exact product · check again after five minutes.</p>}
                  {activeCollection && moveTargets.length > 0 && <div className={styles.moveCollectionForm}>
                    <label htmlFor={moveControlId}>Move to collection</label>
                    <select id={moveControlId} value={moveTargetId} onChange={(event) => setMoveDestinationByProduct((current) => ({ ...current, [product.id]: event.target.value }))}>
                      {moveTargets.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
                    </select>
                    <button type="button" onClick={() => moveSavedProduct(product.id, moveTargetId)} disabled={!loaded || !storageReadable || !moveTargetId}>Move</button>
                  </div>}
                  {activeCollection && collections.length > 1 && moveTargets.length === 0 && <p className={styles.moveHint}>No other collection can accept this product right now.</p>}
                  {item.offers.length > 1 && <details className={styles.offerDetails}><summary>Compare {item.offers.length} retailer offers</summary><ul>{item.offers.map((retailOffer, index) => <li key={`${retailOffer.domain}-${index}`}>{activeCollection
                    ? <div className={styles.offerSnapshot}><span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Saved snapshot</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionLabel(retailOffer.max_commission_rate)}</small></strong></div>
                    : retailOffer.url ? verified ? <a className={styles.offerLink} href={retailOffer.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={(event) => checkVerifiedLink(event, product.id)} onAuxClick={(event) => checkVerifiedLink(event, product.id)} onContextMenu={(event) => checkVerifiedLink(event, product.id)} aria-label={offerChoiceLabel("Visit", product, retailOffer, index)}><span>{offerHandoffLabel(retailOffer)}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Rechecked offer</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionLabel(retailOffer.max_commission_rate)}</small></strong></a> : <button type="button" className={styles.offerLink} onClick={() => void refreshProductOffers(product, retailOffer.domain)} disabled={loading || refreshingKey !== null} aria-label={offerChoiceLabel("Check current", product, retailOffer, index)}><span>{retailOffer.domain}<small>Offer {index + 1} · {retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Check before visiting</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small><small>{commissionLabel(retailOffer.max_commission_rate)}</small></strong></button> : null}</li>)}</ul></details>}
                  <p className={styles.retrieved}>{activeCollection ? `Saved offer snapshot · ${item.storefront === "GB" ? "United Kingdom" : item.storefront === "US" ? "United States" : item.storefront ? `Storefront ${item.storefront}` : "Storefront not recorded"}` : "Offers retrieved"} · {dateLabel(item.retrievedAt)}</p>
                </div>
              </article>;
            })}</div>
          </> : <div className={styles.empty}><span className={styles.emptyIcon}><BagIcon /></span><h4>{items.length ? "No offers match these filters" : activeCollection ? "A collection ready for your next find" : results ? "No products found for this search" : "Good choices start with a shortlist"}</h4><p>{items.length ? "Try another retailer or include out-of-stock offers." : activeCollection ? "Search for a product, then save it to this collection." : results ? "Try a broader product name or a different budget." : "Find products, compare their retailer offers, and save the ones worth coming back to."}</p>{items.length ? <button type="button" onClick={() => { resetFilters(); setInStockOnly(false); }}>Reset filters</button> : <button type="button" onClick={() => queryInput.current?.focus()}>Start a search <span aria-hidden="true">↗</span></button>}</div>}
          <p className={styles.footerNote}>Product information is supplied by Channel3. Prices and availability can change; the retailer confirms your purchase and checkout.</p>
        </section>
      </div>
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
