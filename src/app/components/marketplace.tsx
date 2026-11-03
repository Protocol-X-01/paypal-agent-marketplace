"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./marketplace.module.css";

export const SHOPPING_LISTS_STORAGE_KEY = "paypal-markets-shopping-lists-v1";
const MAX_COLLECTIONS = 12;
const MAX_ITEMS = 40;

type Offer = {
  url: string | null;
  domain: string;
  availability: "InStock" | "OutOfStock";
  price: { price: number; compare_at_price: number | null; currency: string };
};
type Product = {
  id: string;
  title: string;
  description: string | null;
  images: Array<{ url: string; cleaned_url: string | null; is_main_image: boolean }>;
  offers: Offer[];
};
type SavedItem = { product: Product; retrievedAt: string; savedAt: string };
type ShoppingCollection = { id: string; name: string; createdAt: string; items: SavedItem[] };
type SearchResults = { query: string; retrievedAt: string; products: Product[] };
type Sort = "recommended" | "price-asc" | "price-desc";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function parseProduct(value: unknown): Product | null {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || !value.title) return null;
  const offers: Offer[] = Array.isArray(value.offers) ? value.offers.slice(0, 30).flatMap((offer) => {
    if (!record(offer) || !record(offer.price)) return [];
    const url = httpsUrl(offer.url);
    const host = url ? new URL(url).hostname.replace(/^www\./, "") : null;
    const suppliedDomain = typeof offer.domain === "string" && /^[a-z0-9.-]{1,253}$/i.test(offer.domain)
      ? offer.domain.toLowerCase().replace(/^www\./, "")
      : null;
    const domain = host ?? suppliedDomain;
    const price = offer.price.price;
    const currency = offer.price.currency;
    if (!domain || typeof price !== "number" || !Number.isFinite(price) || price < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return [];
    if (offer.availability !== "InStock" && offer.availability !== "OutOfStock") return [];
    return [{ url, domain, availability: offer.availability, price: { price, currency, compare_at_price: null } }];
  }) : [];
  const images: Product["images"] = Array.isArray(value.images) ? value.images.slice(0, 6).flatMap((image) => {
    if (!record(image)) return [];
    const url = httpsUrl(image.cleaned_url) ?? httpsUrl(image.url);
    return url ? [{ url, cleaned_url: null, is_main_image: image.is_main_image === true }] : [];
  }) : [];
  return { id: value.id.slice(0, 300), title: value.title.slice(0, 300), description: typeof value.description === "string" ? value.description.slice(0, 1000) : null, images, offers };
}

function snapshotProduct(product: Product): Product {
  return { ...product, offers: product.offers.map((offer) => ({ ...offer, url: null })) };
}

function readCollections(raw: string | null): ShoppingCollection[] {
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
      const product = parseProduct(item.product);
      if (!product || productIds.has(product.id)) return [];
      productIds.add(product.id);
      return [{ product: snapshotProduct(product), retrievedAt: typeof item.retrievedAt === "string" ? item.retrievedAt : "", savedAt: typeof item.savedAt === "string" ? item.savedAt : "" }];
    });
    return [{ id: list.id.slice(0, 120), name: list.name.trim().slice(0, 40), createdAt: typeof list.createdAt === "string" ? list.createdAt : "", items }];
  });
}

function money(value: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
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

export default function Marketplace() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collections, setCollections] = useState<ShoppingCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageReadable, setStorageReadable] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [notice, setNotice] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [retailer, setRetailer] = useState("all");
  const [currency, setCurrency] = useState("all");
  const [inStockOnly, setInStockOnly] = useState(true);
  const [sort, setSort] = useState<Sort>("recommended");
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const queryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
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
      if (initialQuery && initialQuery.length <= 120) setQuery(initialQuery);
    }, 0);
    function handleStorage(event: StorageEvent) {
      if (event.key === SHOPPING_LISTS_STORAGE_KEY || event.key === null) load();
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", handleStorage);
      request.current?.abort();
    };
  }, []);

  function persist(next: ShoppingCollection[]) {
    if (!storageReadable) return false;
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
    setNotice("");
    resetFilters();
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const searchQuery = query.trim();
    if (searchQuery.length < 2 || searchQuery.length > 120 || loading || refreshingKey) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setResults(null);
    selectCollection(null);
    try {
      const response = await fetch("/api/marketplace/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: searchQuery, limit: 8 }), signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Product search is unavailable right now. Please try again shortly.");
      if (!record(body) || !Array.isArray(body.products) || typeof body.retrievedAt !== "string") throw new Error("The catalog returned an unexpected result. Please try another search.");
      const products = body.products.slice(0, 8).map(parseProduct).filter((product): product is Product => product !== null);
      setResults({ query: searchQuery, retrievedAt: body.retrievedAt, products });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Product search is unavailable right now.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function refreshProductOffers(product: Product, retailerDomain?: string) {
    if (loading || refreshingKey) return;
    const searchQuery = product.title.trim().slice(0, 120);
    const key = `${product.id}:${retailerDomain ?? "collection"}`;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setRefreshingKey(key);
    setError("");
    setNotice("Checking current retailer offers with Channel3…");

    try {
      const response = await fetch("/api/marketplace/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, limit: 8 }),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(response.status === 429 ? "Search is temporarily limited. Wait a minute, then try again." : "Current offers could not be refreshed. Please try again shortly.");
      }
      if (!record(body) || !Array.isArray(body.products) || typeof body.retrievedAt !== "string") {
        throw new Error("The catalog returned an unexpected result. Please try another search.");
      }

      const refreshed = body.products.slice(0, 8).map(parseProduct).find((candidate) => candidate?.id === product.id);
      if (!refreshed) {
        setNotice("This exact item is no longer in the current catalog results. Search again to find a current match.");
        return;
      }

      setQuery(searchQuery);
      setResults({ query: searchQuery, retrievedAt: body.retrievedAt, products: [refreshed] });
      selectCollection(null);
      if (retailerDomain) {
        const currentOffer = refreshed.offers.find((offer) => offer.domain === retailerDomain && offer.url);
        if (currentOffer?.url) {
          window.location.assign(currentOffer.url);
          return;
        }
        setNotice(`The ${retailerDomain} offer changed. Current offers are shown here.`);
      } else {
        setNotice(`Current offers refreshed for ${product.title}. Select a retailer to continue.`);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Current offers could not be refreshed.");
        setNotice("");
      }
    } finally {
      if (!controller.signal.aborted) setRefreshingKey(null);
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
  const destination = collections.find((list) => list.id === destinationId) ?? collections[0] ?? null;
  const items: SavedItem[] = useMemo(() => activeCollection ? activeCollection.items : (results?.products ?? []).map((product) => ({ product, retrievedAt: results?.retrievedAt ?? "", savedAt: "" })), [activeCollection, results]);
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

  function deleteCollection() {
    if (!activeCollection) return;
    const name = activeCollection.name;
    if (persist(collections.filter((list) => list.id !== activeCollection.id))) {
      selectCollection(null);
      setNotice(`Deleted “${name}”.`);
    }
  }

  return (
    <div className={styles.marketplace}>
      <section className={styles.searchPanel} aria-labelledby="discover-title">
        <div className={styles.heroCopy}><span className={styles.eyebrow}>PRODUCT DISCOVERY / CHANNEL3</span><h2 id="discover-title">Find what you have in mind.</h2><p>Compare retailer offers. Keep your favourites together. Make your next purchase a considered one.</p></div>
        <form className={styles.searchForm} onSubmit={search}>
          <label className={styles.srOnly} htmlFor="marketplace-query">What are you looking for?</label>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.7"/></svg>
          <input ref={queryInput} id="marketplace-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} maxLength={120} placeholder="Wireless headphones under $150" required />
          <button type="submit" disabled={loading || refreshingKey !== null || query.trim().length < 2}>{loading ? "Searching…" : "Search offers"}<span aria-hidden="true">↗</span></button>
        </form>
        <div className={styles.suggestions}><span>Start with an idea</span>{[{ label: "Desk essentials", query: "home office desk essentials" }, { label: "Everyday audio", query: "wireless headphones under $150" }, { label: "Travel light", query: "lightweight carry on travel backpack" }].map((idea) => <button key={idea.label} type="button" onClick={() => { setQuery(idea.query); queryInput.current?.focus(); }}>{idea.label}<span aria-hidden="true">↗</span></button>)}</div>
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
            <input id="collection-name" value={collectionName} onChange={(event) => setCollectionName(event.target.value)} maxLength={40} placeholder="e.g. My next desk setup" required disabled={!loaded} />
            <button type="submit" disabled={!loaded || !collectionName.trim() || collections.length >= MAX_COLLECTIONS}>Create collection <span aria-hidden="true">+</span></button>
          </form>
          <p className={styles.privacyNote}>Collections stay in this browser. They are not synced to your PayPal account or Channel3.</p>
        </aside>

        <section className={styles.results} aria-labelledby="offers-title" aria-busy={loading || refreshingKey !== null}>
          <div className={styles.resultsHeading}><div><span className={styles.eyebrow}>{activeCollection ? "YOUR SAVED FINDS" : results ? "RETAILER OFFERS" : "A LITTLE INSPIRATION"}</span><h3 id="offers-title">{activeCollection?.name ?? (results ? `Results for “${results.query}”` : "Your next find starts here")}</h3><p>{activeCollection ? `${activeCollection.items.length} saved ${activeCollection.items.length === 1 ? "product" : "products"} · Offer snapshots from when you saved them` : results ? `${results.products.length} products · Retrieved ${dateLabel(results.retrievedAt)}` : "Search with a product, a budget, or a few details that matter to you."}</p></div>{activeCollection && <button className={styles.deleteButton} type="button" onClick={() => setDeletePending(true)}>Delete collection</button>}</div>
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
            <div className={styles.productGrid}>{displayedItems.map((item) => {
              const product = item.product;
              const image = product.images.find((candidate) => candidate.is_main_image)?.url ?? product.images[0]?.url;
              const offer = item.offers[0];
              const target = activeCollection ?? destination;
              const saved = target?.items.some((savedItem) => savedItem.product.id === product.id) ?? false;
              return <article className={styles.product} key={product.id}>
                <div className={styles.productImage}>{image ? /* Channel3 images come from multiple retailers; keep requests client-side with no referrer. */ <ProductImage src={image} alt={product.title} /> : <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>}<button type="button" className={`${styles.saveButton} ${saved ? styles.saved : ""}`} onClick={() => toggleSave(item)} disabled={!loaded} aria-pressed={saved} aria-label={`${saved ? "Remove" : "Save"} ${product.title} ${saved ? "from" : "to"} ${target?.name ?? "Favourites"}`}><span aria-hidden="true">{saved ? "✓" : "+"}</span>{saved ? "Saved" : "Save"}</button></div>
                <div className={styles.productBody}><h4>{product.title}</h4>{offer && <div className={styles.offerPrice}><strong>{money(offer.price.price, offer.price.currency)}</strong><span>{offer.price.currency} · {offer.availability === "InStock" ? "In stock" : "Out of stock"}</span></div>}
                  {activeCollection ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product)} disabled={refreshingKey !== null} aria-label={`Find current retailer offers for ${product.title}`}>
                    {refreshingKey === `${product.id}:collection` ? "Refreshing current offers…" : "Find current offers on Channel3"}<span aria-hidden="true">↻</span>
                  </button> : offer?.url ? <button type="button" className={styles.retailerLink} onClick={() => void refreshProductOffers(product, offer.domain)} disabled={refreshingKey !== null} aria-label={`Refresh and open the ${offer.domain} offer for ${product.title}`}>
                    {refreshingKey === `${product.id}:${offer.domain}` ? "Checking current offer…" : `Refresh and visit ${offer.domain}`}<span aria-hidden="true">↗</span>
                  </button> : <p className={styles.smallCopy}>No retailer offer is available in this search.</p>}
                  {item.offers.length > 1 && <details className={styles.offerDetails}><summary>Compare {item.offers.length} retailer offers</summary><ul>{item.offers.map((retailOffer, index) => <li key={`${retailOffer.domain}-${index}`}>{activeCollection
                    ? <div className={styles.offerSnapshot}><span>{retailOffer.domain}<small>{retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Saved snapshot</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small></strong></div>
                    : retailOffer.url ? <button type="button" className={styles.offerLink} onClick={() => void refreshProductOffers(product, retailOffer.domain)} disabled={refreshingKey !== null} aria-label={`Refresh and open the ${retailOffer.domain} offer for ${product.title}`}><span>{retailOffer.domain}<small>{retailOffer.availability === "InStock" ? "In stock" : "Out of stock"} · Refresh before visiting</small></span><strong>{money(retailOffer.price.price, retailOffer.price.currency)}<small>{retailOffer.price.currency}</small></strong></button> : null}</li>)}</ul></details>}
                  <p className={styles.retrieved}>{activeCollection ? "Saved offer snapshot" : "Offers retrieved"} · {dateLabel(item.retrievedAt)}</p>
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
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={styles.imageFallback}><BagIcon /><span>Image unavailable</span></span>;
  // Retailer hosts vary per result; avoid proxying arbitrary URLs through the image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
