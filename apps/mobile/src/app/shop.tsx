import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetch as expoFetch } from 'expo/fetch';

import { searchChannel3, fetchChannel3Catalog, createCustomerCollectionsRepository, planProductSave, newCollection, MAX_COLLECTIONS, MAX_COLLECTION_NAME_LENGTH, type Channel3Catalog, type Channel3CatalogSection, type Channel3CatalogRetailer, type Channel3Offer, type Channel3PriceRange, type Channel3Product, type SavedProduct, type ShoppingCollection } from '@/lib/channel3';
import { CHANNEL3_CURATED_SECTIONS, CHANNEL3_CURATED_RETAILERS, getChannel3SeasonalEdit } from '@/lib/channel3-shelves';
import { VERIFIED_OFFERS_TTL_MS } from '@/lib/channel3-offers';
import { createChannel3ImageLoader, type Channel3ImageLease } from '@/lib/channel3-image';
import { createStorefrontFence, DEFAULT_SHOP_STOREFRONT, loadShopDiscoveryMode, loadShopStorefront, saveShopDiscoveryMode, saveShopStorefront, SHOP_STOREFRONTS, type ShopDiscoveryMode, type ShopStorefront, type StorefrontTicket } from '@/lib/shop-storefront';
import { useCustomerSession } from '@/lib/customer-session-context';
import { useResponsiveLayout } from '@/lib/responsive-layout';
import { palette } from '@/lib/palette';
import { NativeButton } from '@/components/native-button';
import { useAppearanceStyles, usePalette } from '@/lib/theme-context';

const EMPTY_COLLECTIONS: ShoppingCollection[] = [];
const AFFILIATE_DISCLOSURE = 'We may earn a commission from retailer links.';
const COMMISSION_LEGEND = '★ Max advertised commission; we may earn from links. Not cashback; rates vary.';
const SUGGESTIONS = ['wireless headphones', 'travel backpack', 'desk lamp'];
const MAX_SEARCH_RESULTS = 96;
const MAX_SEARCH_PAGES = 8;
// The named Expo fetch is used even when RN's legacy global fetch is enabled.
// On web it delegates to the browser, which also receives referrerPolicy.
const productImageLoader = createChannel3ImageLoader((url, options) => expoFetch(url, options));
const CURATED_CATEGORIES = CHANNEL3_CURATED_SECTIONS.map(section => ({ id: section.id, label: section.title, description: section.description, symbol: section.id === 'audio' ? '♫' : section.id === 'travel' ? '↗' : '✦' }));
function commissionLabel(rate: number | null | undefined): string { return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? `★ Up to ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rate * 100)}%` : '★ Rate unavailable'; }

function offerHandoffLabel(offer: Channel3Offer): string {
  const host = new URL(offer.url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return host === offer.domain ? offer.domain : `${offer.domain} via ${host}`;
}

function preferredRetailerOffer(product: Pick<Channel3Product, 'offers'>): Channel3Offer | null {
  return product.offers.find((offer) => offer.url && offer.availability === 'InStock') ?? null;
}

const SIMILAR_PRODUCT_FAMILIES = [
  { query: 'travel backpack', terms: ['bag', 'bags', 'backpack', 'backpacks', 'rucksack', 'sackpack', 'sack', 'tote', 'duffel', 'luggage', 'carryon'] },
  { query: 'wireless headphones', terms: ['headphone', 'headphones', 'earbud', 'earbuds', 'earphone', 'earphones', 'headset'] },
  { query: 'shoes', terms: ['shoe', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots'] },
  { query: 'laptops', terms: ['laptop', 'notebook', 'computer'] },
  { query: 'smartphones', terms: ['phone', 'smartphone', 'mobile'] },
  { query: 'tablets', terms: ['tablet', 'ipad'] },
  { query: 'desk lamps', terms: ['lamp', 'lighting', 'light'] },
  { query: 'coffee makers', terms: ['coffee', 'coffeemaker', 'espresso'] },
  { query: 'cameras', terms: ['camera', 'webcam'] },
  { query: 'water bottles', terms: ['bottle', 'flask', 'tumbler'] },
  { query: 'chairs', terms: ['chair', 'stool', 'desk'] },
  { query: 'watches', terms: ['watch', 'watches', 'smartwatch', 'wearable'] },
  { query: 'monitors and televisions', terms: ['monitor', 'television', 'display', 'screen'] },
  { query: 'printers', terms: ['printer', 'printers', 'scanner'] },
  { query: 'gaming accessories', terms: ['gaming', 'console', 'controller', 'videogame'] },
  { query: 'board games and toys', terms: ['toy', 'toys', 'puzzle', 'boardgame', 'boardgames'] },
  { query: 'skin care and beauty', terms: ['skincare', 'makeup', 'cosmetics', 'beauty'] },
  { query: 'fitness equipment', terms: ['fitness', 'exercise', 'yoga', 'weights', 'dumbbell', 'treadmill'] },
  { query: 'pet supplies', terms: ['pet', 'pets', 'dog', 'dogs', 'cat', 'cats'] },
  { query: 'clothing', terms: ['shirt', 'shirts', 'dress', 'jacket', 'jeans', 'clothing', 'apparel'] },
  { query: 'jewelry', terms: ['jewelry', 'jewellery', 'necklace', 'ring', 'bracelet'] },
  { query: 'home and bedding', terms: ['bedding', 'duvet', 'pillow', 'mattress', 'decor'] },
  { query: 'small appliances', terms: ['vacuum', 'blender', 'toaster', 'appliance', 'airfryer'] },
  { query: 'pantry and snacks', terms: ['snack', 'snacks', 'pantry', 'grocery', 'food'] },
];
const SIMILAR_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'new', 'black', 'white', 'blue', 'red', 'green', 'pink', 'small', 'large', 'medium', 'mens', 'womens', 'kids']);

function productWords(value: string): Set<string> {
  return new Set((value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !SIMILAR_STOP_WORDS.has(word)));
}

function similarProductQuery(value: string): string | null {
  const words = productWords(value);
  return SIMILAR_PRODUCT_FAMILIES.find((family) => family.terms.some((term) => words.has(term)))?.query ?? null;
}

function findSimilarInStockProducts(source: Pick<Channel3Product, 'id' | 'title' | 'brand'>, candidates: readonly Channel3Product[]): Channel3Product[] {
  const sourceWords = productWords(`${source.brand ?? ''} ${source.title}`);
  const families = SIMILAR_PRODUCT_FAMILIES.filter((family) => family.terms.some((word) => sourceWords.has(word)));
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    if (candidate.id === source.id || seen.has(candidate.id) || !candidate.offers.some((offer) => offer.url && offer.availability === 'InStock')) return [];
    const candidateWords = productWords(`${candidate.brand ?? ''} ${candidate.title}`);
    const sharedWords = [...sourceWords].filter((word) => candidateWords.has(word)).length;
    const sharedFamily = families.some((family) => family.terms.some((word) => candidateWords.has(word)));
    const sameBrand = Boolean(source.brand && candidate.brand && source.brand.toLowerCase() === candidate.brand.toLowerCase());
    if (!sharedFamily && sharedWords < 2) return [];
    const score = sharedWords + (sharedFamily ? 4 : 0) + (sameBrand ? 2 : 0);
    seen.add(candidate.id);
    return [{ candidate, score }];
  }).sort((left, right) => right.score - left.score || left.candidate.title.localeCompare(right.candidate.title)).slice(0, 3).map(({ candidate }) => candidate);
}

type CollectionsRepository = ReturnType<typeof createCustomerCollectionsRepository>;
type RetainedRename = { collectionName: string; value: string };
type VerifiedOffers = { repository?: CollectionsRepository; offers: Channel3Offer[]; verifiedAt: number; ticket: StorefrontTicket };
function offerSnapshotStatus(offer: Channel3Offer, verified: VerifiedOffers | undefined, unconfirmed: boolean) {
  if (unconfirmed) return { label: 'Earlier report · current stock unconfirmed', availability: 'unknown' as const };
  const current = verified?.offers.find((candidate) => candidate.domain === offer.domain);
  if (verified && !current) return { label: 'Not in current check', availability: 'unknown' as const };
  if (current?.availability === 'InStock') return { label: 'Current check · reported in stock', availability: 'InStock' as const };
  if (current?.availability === 'OutOfStock') return { label: 'Current check · reported out of stock', availability: 'OutOfStock' as const };
  if (verified) return { label: 'Current stock unknown', availability: 'unknown' as const };
  return { label: offer.availability === 'InStock' ? 'Reported in stock' : offer.availability === 'OutOfStock' ? 'Reported out of stock' : 'Check stock', availability: offer.availability };
}
type SearchStopReason = 'complete' | 'result-limit' | 'page-limit' | 'repeated-token' | null;
type SearchSnapshot = {
  query: string;
  ticket: StorefrontTicket;
  priceRange: Channel3PriceRange | null;
  products: Channel3Product[];
  firstRetrievedAt: string;
  latestRetrievedAt: string;
  nextPageToken: string | null;
  seenTokens: string[];
  pages: number;
  stopReason: SearchStopReason;
};

function currentEpochMs(): number {
  return Date.now();
}

function formatPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function parsePriceRangeDraft(minimumValue: string, maximumValue: string): { range: Channel3PriceRange | undefined; error: string | null } {
  const read = (raw: string, label: string): { value?: number; error?: string } => {
    const value = raw.trim();
    if (!value) return {};
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return { error: `Enter a valid ${label} price.` };
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount > 100_000_000) return { error: `${label} price must be 100,000,000 or less.` };
    return { value: amount };
  };
  const minimum = read(minimumValue, 'minimum');
  if (minimum.error) return { range: undefined, error: minimum.error };
  const maximum = read(maximumValue, 'maximum');
  if (maximum.error) return { range: undefined, error: maximum.error };
  if (minimum.value !== undefined && maximum.value !== undefined && minimum.value > maximum.value) {
    return { range: undefined, error: 'Minimum price must not exceed maximum price.' };
  }
  return {
    range: minimum.value === undefined && maximum.value === undefined
      ? undefined
      : { ...(minimum.value === undefined ? {} : { minPrice: minimum.value }), ...(maximum.value === undefined ? {} : { maxPrice: maximum.value }) },
    error: null,
  };
}

function appliedPriceLabel(range: Channel3PriceRange | null, currency: string): string | null {
  if (!range) return null;
  const format = (amount: number) => formatPrice(amount, currency);
  if (range.minPrice !== undefined && range.maxPrice !== undefined) return `Price filter applied · ${format(range.minPrice)}–${format(range.maxPrice)}`;
  if (range.minPrice !== undefined) return `Price filter applied · from ${format(range.minPrice)}`;
  return `Price filter applied · up to ${format(range.maxPrice as number)}`;
}

function isOfferWithinPriceRange(offer: Channel3Offer, range: Channel3PriceRange | null, currency: string): boolean {
  if (!range) return true;
  return offer.currency === currency &&
    (range.minPrice === undefined || offer.price >= range.minPrice) &&
    (range.maxPrice === undefined || offer.price <= range.maxPrice);
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function priceSnapshotLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Appended pages can have different retrieval times; do not refresh earlier prices in the label. */
function pageRetrievalLabel(first: string, latest: string): string {
  function utc(value: string) {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match) return 'time unavailable';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'time unavailable';
    const iso = date.toISOString();
    if (iso !== `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`) return 'time unavailable';
    return iso.replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC');
  }
  return first === latest ? `Retrieved ${utc(first)}` : `First page retrieved ${utc(first)} · Latest page retrieved ${utc(latest)}`;
}

function productLabel(brand: string | null): string {
  return brand ? brand : 'Retailer product';
}

function ProductThumbnail({ imageUrl }: { imageUrl: string | null }) {
  const styles = useAppearanceStyles(baseStyles);
  const [image, setImage] = useState<{ source: string; uri: string | null } | null>(null);
  const lease = useRef<{ source: string; value: Channel3ImageLease } | null>(null);
  useEffect(() => {
    if (!imageUrl) return;
    const controller = new AbortController();
    let active = true;
    void productImageLoader.load(imageUrl, controller.signal).then((loaded) => {
      if (!active || controller.signal.aborted) { loaded.release(); return; }
      lease.current = { source: imageUrl, value: loaded };
      setImage({ source: imageUrl, uri: loaded.uri });
    }).catch(() => {
      if (active && !controller.signal.aborted) setImage({ source: imageUrl, uri: null });
    });
    return () => {
      active = false;
      controller.abort();
      if (lease.current?.source === imageUrl) {
        lease.current.value.release();
        lease.current = null;
      }
    };
  }, [imageUrl]);
  const visibleUri = imageUrl && image?.source === imageUrl ? image.uri : null;
  const imageFailed = () => {
    if (imageUrl && lease.current?.source === imageUrl) {
      lease.current.value.release();
      lease.current = null;
    }
    if (imageUrl) setImage((current) => current?.source === imageUrl ? { source: imageUrl, uri: null } : current);
  };
  return (
    <View style={styles.productGlyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {visibleUri ? <Image source={{ uri: visibleUri }} style={styles.productImage} resizeMode="contain" accessible={false} onError={imageFailed} />
        : <Text style={styles.productGlyphText}>✦</Text>}
    </View>
  );
}

export default function ShopScreen() {
  const styles = useAppearanceStyles(baseStyles);
  const colors = usePalette();
  const layout = useResponsiveLayout();
  const { storageFence, revision: storageRevision } = useCustomerSession();
  const repository = useMemo(() => ({ ...createCustomerCollectionsRepository(storageFence), revision: storageRevision }), [storageFence, storageRevision]);
  const [loadedRepository, setLoadedRepository] = useState<CollectionsRepository | null>(null);
  const privateVisible = loadedRepository === repository && repository.isCurrent();
  const [storefront, setStorefront] = useState<ShopStorefront>(DEFAULT_SHOP_STOREFRONT);
  const [storefrontReady, setStorefrontReady] = useState(false);
  const [storefrontStatus, setStorefrontStatus] = useState<'loading' | 'default' | 'saved' | 'saving' | 'invalid' | 'unavailable'>('loading');
  const storefrontFence = useRef(createStorefrontFence(DEFAULT_SHOP_STOREFRONT));
  const storefrontMounted = useRef(false);
  const storefrontSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const storefrontSaveRevision = useRef(0);
  const [discoveryMode, setDiscoveryMode] = useState<ShopDiscoveryMode>('browse');
  const discoveryModeSelectionRevision = useRef(0);
  const discoveryModeSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const searchRequest = useRef<AbortController | null>(null);
  const searchIdentity = useRef<object | null>(null);
  const searchInterrupted = useRef(false);
  const catalogRequest = useRef<AbortController | null>(null);
  const recheckRequest = useRef<AbortController | null>(null);
  const [storedCollections, setCollections] = useState<ShoppingCollection[]>([]);
  const [storedActiveCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [storedCollectionDraft, setCollectionDraft] = useState('');
  const [storedRenameDraft, setRenameDraft] = useState('');
  const [storedStorageReady, setStorageReady] = useState(false);
  const [storedStorageError, setStorageError] = useState<string | null>(null);
  const [storedCollectionNotice, setCollectionNotice] = useState<string | null>(null);
  const [storedIsSavingCollections, setIsSavingCollections] = useState(false);
  const [storedReloadingCollections, setReloadingCollections] = useState(false);
  const [storedRetainedRenames, setRetainedRenames] = useState<RetainedRename[]>([]);
  const [collectionsViewRevision, setCollectionsViewRevision] = useState(0);
  const [draftInputRevision, setDraftInputRevision] = useState(0);
  const savingCollectionsRef = useRef(false);
  const collectionsMountedRef = useRef(false);
  const collectionsVerifiedRef = useRef(false);
  const collectionsReadInProgressRef = useRef(false);
  const collectionsOperationRef = useRef(0);
  const collectionsViewRevisionRef = useRef(0);
  const draftInputRevisionRef = useRef(0);
  const collectionsRef = useRef<ShoppingCollection[]>([]);
  const activeCollectionIdRef = useRef<string | null>(null);
  const collectionDraftRef = useRef('');
  const renameDraftRef = useRef('');
  const saveUncertainRef = useRef(false);
  const [storedDeletePending, setDeletePending] = useState(false);

  const [query, setQuery] = useState('');
  const [minimumPrice, setMinimumPrice] = useState('');
  const [maximumPrice, setMaximumPrice] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchSnapshot, setSearchSnapshot] = useState<SearchSnapshot | null>(null);
  const searchSnapshotRef = useRef<SearchSnapshot | null>(null);
  const [searchMoreLoading, setSearchMoreLoading] = useState(false);
  const [searchMoreError, setSearchMoreError] = useState<string | null>(null);
  const [searchPageStatus, setSearchPageStatus] = useState('');
  const [curatedSection, setCuratedSection] = useState<Channel3CatalogSection | null>(null);
  const [curatedRetailer, setCuratedRetailer] = useState<Channel3CatalogRetailer | null>(null);
  const [curatedMoreLoading, setCuratedMoreLoading] = useState(false);
  const [curatedPageStatus, setCuratedPageStatus] = useState('');
  const [curatedMoreError, setCuratedMoreError] = useState<string | null>(null);
  const [curatedCatalog, setCuratedCatalog] = useState<Channel3Catalog | null>(null);
  const [curatedFirstRetrievedAt, setCuratedFirstRetrievedAt] = useState<string | null>(null);
  const [curatedLoading, setCuratedLoading] = useState(false);
  const [curatedError, setCuratedError] = useState<string | null>(null);
  const [curatedTicket, setCuratedTicket] = useState<StorefrontTicket | null>(null);
  const [verifiedByProduct, setVerifiedByProduct] = useState<Record<string, VerifiedOffers>>({});
  const [availabilityUnconfirmedByProduct, setAvailabilityUnconfirmedByProduct] = useState<Record<string, boolean>>({});
  const [similarByProduct, setSimilarByProduct] = useState<Record<string, Channel3Product[]>>({});
  const [similarVisibleByProduct, setSimilarVisibleByProduct] = useState<Record<string, boolean>>({});
  const [similarLoadingByProduct, setSimilarLoadingByProduct] = useState<Record<string, boolean>>({});
  const [similarErrorByProduct, setSimilarErrorByProduct] = useState<Record<string, string>>({});
  const [offerErrors, setOfferErrors] = useState<Record<string, string>>({});
  const [storedRefreshingProductId, setRefreshingProductId] = useState<string | null>(null);
  const [refreshRepository, setRefreshRepository] = useState<CollectionsRepository | null>(null);
  const refreshingProductId = !refreshRepository || refreshRepository.isCurrent() ? storedRefreshingProductId : null;
  const recheckPrivateRepository = useRef<CollectionsRepository | null>(null);
  const refreshingProductRef = useRef<string | null>(null);
  const offerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const collections = privateVisible ? storedCollections : EMPTY_COLLECTIONS;
  const activeCollectionId = privateVisible ? storedActiveCollectionId : null;
  const collectionDraft = privateVisible ? storedCollectionDraft : '';
  const renameDraft = privateVisible ? storedRenameDraft : '';
  const storageReady = privateVisible ? storedStorageReady : false;
  const storageError = privateVisible ? storedStorageError : null;
  const collectionNotice = privateVisible ? storedCollectionNotice : null;
  const isSavingCollections = privateVisible ? storedIsSavingCollections : false;
  const reloadingCollections = privateVisible ? storedReloadingCollections : false;
  const retainedRenames = privateVisible ? storedRetainedRenames : [];
  const deletePending = privateVisible ? storedDeletePending : false;
  const searchResults = searchSnapshot?.products ?? null;
  const searchTicket = searchSnapshot?.ticket ?? null;
  function publishSearchSnapshot(next: SearchSnapshot | null) {
    searchSnapshotRef.current = next;
    setSearchSnapshot(next);
  }
  const activeCollection = useMemo(
    () => collections.find((item) => item.id === activeCollectionId) ?? null,
    [collections, activeCollectionId],
  );
  const saveTarget = activeCollection ?? collections[0] ?? null;

  useEffect(() => {
    storefrontMounted.current = true;
    const modeRevision = discoveryModeSelectionRevision.current;
    void loadShopDiscoveryMode().then((savedMode) => {
      if (storefrontMounted.current && discoveryModeSelectionRevision.current === modeRevision) setDiscoveryMode(savedMode);
    }).catch(() => undefined);
    void loadShopStorefront().then((saved) => {
      if (!storefrontMounted.current) return;
      storefrontFence.current.select(saved.storefront);
      setStorefront(saved.storefront);
      setStorefrontStatus(saved.status);
      setStorefrontReady(true);
    }).catch(() => {
      if (!storefrontMounted.current) return;
      setStorefrontStatus('unavailable');
      setStorefrontReady(true);
    });
    return () => {
      storefrontMounted.current = false;
      searchRequest.current?.abort();
      catalogRequest.current?.abort();
      recheckRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    const identity = storageFence.current();
    if (searchInterrupted.current && !searchRequest.current) {
      searchInterrupted.current = false;
      setSearching(false);
      setSearchMoreLoading(false);
      if (searchSnapshotRef.current) setSearchPageStatus('Loading more stopped. Try again to continue.');
      else setSearchError('Search was interrupted. Please try again.');
    }
    return () => {
      if (searchRequest.current && searchIdentity.current === identity) {
        searchRequest.current.abort();
        searchRequest.current = null;
        searchIdentity.current = null;
        searchInterrupted.current = true;
      }
    };
  }, [storageFence, storageRevision]);

  useEffect(() => {
    let active = true;
    const operation = ++collectionsOperationRef.current;
    collectionsMountedRef.current = true;
    collectionsVerifiedRef.current = false;
    collectionsReadInProgressRef.current = true;
    collectionsViewRevisionRef.current += 1;
    draftInputRevisionRef.current += 1;
    collectionsRef.current = [];
    activeCollectionIdRef.current = null;
    collectionDraftRef.current = '';
    renameDraftRef.current = '';
    saveUncertainRef.current = false;
    savingCollectionsRef.current = false;
    const current = () => active && collectionsMountedRef.current && repository.isCurrent() && collectionsOperationRef.current === operation;
    void repository.load()
      .then((stored) => {
        if (!current()) return;
        collectionsRef.current = stored;
        activeCollectionIdRef.current = stored[0]?.id ?? null;
        renameDraftRef.current = stored[0]?.name ?? '';
        collectionsVerifiedRef.current = true;
        collectionsViewRevisionRef.current += 1;
        setCollectionsViewRevision(collectionsViewRevisionRef.current);
        draftInputRevisionRef.current += 1;
        setDraftInputRevision(draftInputRevisionRef.current);
        setReloadingCollections(false);
        setRetainedRenames([]);
        setStorageError(null);
        setCollectionDraft('');
        setCollectionNotice(null);
        setDeletePending(false);
        setIsSavingCollections(false);
        savingCollectionsRef.current = false;
        setCollections(stored);
        setActiveCollectionId(stored[0]?.id ?? null);
        setRenameDraft(stored[0]?.name ?? '');
        collectionsReadInProgressRef.current = false;
        setStorageReady(true);
        setLoadedRepository(repository);
      })
      .catch(() => {
        if (!current()) return;
        collectionsVerifiedRef.current = false;
        collectionsViewRevisionRef.current += 1;
        setCollectionsViewRevision(collectionsViewRevisionRef.current);
        draftInputRevisionRef.current += 1;
        setDraftInputRevision(draftInputRevisionRef.current);
        setReloadingCollections(false);
        setRetainedRenames([]);
        setCollections([]);
        setCollectionDraft('');
        setRenameDraft('');
        setActiveCollectionId(null);
        setCollectionNotice(null);
        setDeletePending(false);
        setIsSavingCollections(false);
        savingCollectionsRef.current = false;
        setStorageError('Saved collections could not be read. Reload them to check the data on this device.');
        collectionsReadInProgressRef.current = false;
        setStorageReady(true);
        setLoadedRepository(repository);
      });
    return () => {
      active = false;
      collectionsMountedRef.current = false;
      collectionsVerifiedRef.current = false;
      collectionsReadInProgressRef.current = false;
      collectionsOperationRef.current += 1;
      collectionsViewRevisionRef.current += 1;
      draftInputRevisionRef.current += 1;
      if (recheckPrivateRepository.current === repository) {
        recheckRequest.current?.abort();
        recheckRequest.current = null;
        recheckPrivateRepository.current = null;
        refreshingProductRef.current = null;
      }
    };
  }, [repository]);

  function clearVerifiedOffers() {
    for (const timer of offerTimers.current.values()) clearTimeout(timer);
    offerTimers.current.clear();
    setVerifiedByProduct({});
    setAvailabilityUnconfirmedByProduct({});
    setSimilarByProduct({});
    setSimilarVisibleByProduct({});
    setSimilarLoadingByProduct({});
    setSimilarErrorByProduct({});
    setOfferErrors({});
  }

  function chooseStorefront(next: ShopStorefront) {
    if (!storefrontReady) return;
    if (storefrontFence.current.select(next)) {
      searchRequest.current?.abort();
      catalogRequest.current?.abort();
      recheckRequest.current?.abort();
      searchRequest.current = null;
      searchIdentity.current = null;
      searchInterrupted.current = false;
      catalogRequest.current = null;
      recheckRequest.current = null;
      refreshingProductRef.current = null;
      setStorefront(next);
      setMinimumPrice('');
      setMaximumPrice('');
      setSearching(false);
      setSearchError(null);
      publishSearchSnapshot(null);
      setSearchMoreLoading(false);
      setSearchMoreError(null);
      setSearchPageStatus('');
      setCuratedSection(null);
      setCuratedRetailer(null);
      setCuratedMoreLoading(false);
      setCuratedMoreError(null);
      setCuratedPageStatus('');
      setCuratedCatalog(null);
      setCuratedFirstRetrievedAt(null);
      setCuratedTicket(null);
      setCuratedError(null);
      setCuratedLoading(false);
      setRefreshingProductId(null);
      clearVerifiedOffers();
    }
    setStorefrontStatus('saving');
    const revision = ++storefrontSaveRevision.current;
    const saving = storefrontSaveQueue.current.catch(() => undefined).then(() => saveShopStorefront(next));
    storefrontSaveQueue.current = saving;
    void saving.then(() => {
      if (storefrontMounted.current && revision === storefrontSaveRevision.current) setStorefrontStatus('saved');
    }).catch(() => {
      if (storefrontMounted.current && revision === storefrontSaveRevision.current) setStorefrontStatus('unavailable');
    });
  }

  useEffect(() => {
    const timers = offerTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  function setOfferError(productId: string, message: string | null) {
    setOfferErrors((current) => {
      const next = { ...current };
      if (message) next[productId] = message;
      else delete next[productId];
      return next;
    });
  }

  const mayChangeCollections = privateVisible && repository.isCurrent() && storageReady && !storageError && !isSavingCollections && !reloadingCollections;
  const canChangeCollections = () => mayChangeCollections && collectionsMountedRef.current && collectionsVerifiedRef.current && !collectionsReadInProgressRef.current && !savingCollectionsRef.current && collectionsViewRevision === collectionsViewRevisionRef.current && repository.isCurrent();

  async function reloadSavedCollections() {
    if (!privateVisible || !storageError || !collectionsMountedRef.current || !repository.isCurrent() || collectionsReadInProgressRef.current || savingCollectionsRef.current || collectionsViewRevision !== collectionsViewRevisionRef.current) return;
    const operation = ++collectionsOperationRef.current;
    const current = () => collectionsMountedRef.current && repository.isCurrent() && collectionsOperationRef.current === operation;
    collectionsVerifiedRef.current = false;
    collectionsReadInProgressRef.current = true;
    collectionsViewRevisionRef.current += 1;
    setCollectionsViewRevision(collectionsViewRevisionRef.current);
    setReloadingCollections(true);
    try {
      const stored = await repository.load();
      if (!current()) return;
      const previousId = activeCollectionIdRef.current;
      const previous = collectionsRef.current.find((item) => item.id === previousId);
      const selected = previousId ? stored.find((item) => item.id === previousId) ?? null : stored[0] ?? null;
      if (previous && !selected && renameDraftRef.current !== previous.name) {
        const retained = { collectionName: previous.name, value: renameDraftRef.current };
        setRetainedRenames((drafts) => [...drafts, retained]);
      }
      if (!selected || !previous || (selected.id === previous.id && renameDraftRef.current === previous.name)) {
        renameDraftRef.current = selected?.name ?? '';
        setRenameDraft(renameDraftRef.current);
      }
      collectionsRef.current = stored;
      activeCollectionIdRef.current = selected?.id ?? null;
      collectionsVerifiedRef.current = true;
      collectionsViewRevisionRef.current += 1;
      setCollectionsViewRevision(collectionsViewRevisionRef.current);
      draftInputRevisionRef.current += 1;
      setDraftInputRevision(draftInputRevisionRef.current);
      saveUncertainRef.current = false;
      setCollections(stored);
      setActiveCollectionId(activeCollectionIdRef.current);
      setStorageError(null);
      setCollectionNotice('Saved collections reloaded. Review them before making changes.');
      setDeletePending(false);
    } catch {
      if (!current()) return;
      collectionsVerifiedRef.current = false;
      collectionsViewRevisionRef.current += 1;
      setCollectionsViewRevision(collectionsViewRevisionRef.current);
      setStorageError(saveUncertainRef.current
        ? 'Saved collections could not be reloaded. Your last change may already have been saved. Try again to review them.'
        : 'Saved collections could not be read. Try again to check the data on this device.');
    } finally {
      if (current()) {
        collectionsReadInProgressRef.current = false;
        setReloadingCollections(false);
      }
    }
  }

  function chooseDiscoveryMode(mode: ShopDiscoveryMode) {
    discoveryModeSelectionRevision.current += 1;
    setDiscoveryMode(mode);
    discoveryModeSaveQueue.current = discoveryModeSaveQueue.current
      .catch(() => undefined)
      .then(() => saveShopDiscoveryMode(mode))
      .catch(() => undefined);
    if (mode === 'browse') {
      searchRequest.current?.abort();
      searchRequest.current = null;
      searchIdentity.current = null;
      searchInterrupted.current = false;
      setSearching(false);
      setSearchMoreLoading(false);
      setSearchMoreError(null);
    } else {
      catalogRequest.current?.abort();
      catalogRequest.current = null;
      setCuratedLoading(false);
      setCuratedMoreLoading(false);
    }
  }

  async function loadCuratedSection(section: Channel3CatalogSection | null, retailer: Channel3CatalogRetailer | null = curatedRetailer, append = false) {
    if (!storefrontReady || (!section && !retailer) || (append && (curatedMoreLoading || !curatedCatalog?.nextPageToken))) return;
    chooseDiscoveryMode('browse');
    const previous = append ? curatedCatalog : null;
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const ticket = storefrontFence.current.capture();
    setCuratedSection(section);
    setCuratedRetailer(retailer);
    setCuratedMoreError(null);
    if (append) { setCuratedMoreLoading(true); setCuratedPageStatus('Loading more products…'); }
    else {
      setCuratedPageStatus('');
      setCuratedFirstRetrievedAt(null);
      setCuratedCatalog(null); setCuratedTicket(null); setCuratedError(null); setCuratedLoading(true); setCuratedMoreLoading(false);
      recheckRequest.current?.abort(); recheckRequest.current = null; refreshingProductRef.current = null; setRefreshingProductId(null); clearVerifiedOffers();
    }
    try {
      const result = await fetchChannel3Catalog(section, ticket.storefront, controller.signal, { retailer, ...(previous?.nextPageToken ? { pageToken: previous.nextPageToken } : {}) });
      if (controller.signal.aborted || !storefrontFence.current.isCurrent(ticket) || catalogRequest.current !== controller) return;
      const seen = new Set<string>();
      const products = [...(previous?.products ?? []), ...result.products].filter(product => !seen.has(product.id) && !!seen.add(product.id)).slice(0, 96);
      const nextPageToken = products.length >= 96 || result.nextPageToken === previous?.nextPageToken ? null : result.nextPageToken;
      setCuratedCatalog({ ...result, products, nextPageToken });
      if (!append) setCuratedFirstRetrievedAt(result.retrievedAt);
      setCuratedPageStatus(`${append ? `${products.length - (previous?.products.length ?? 0)} more products added. ` : ''}${products.length} products loaded.${products.length >= 96 ? ' Browse limit reached; choose another category or retailer to explore more.' : !nextPageToken ? ' No more products in these results.' : ''}`);
      setCuratedTicket(ticket);
    } catch (error) {
      if (!controller.signal.aborted && storefrontFence.current.isCurrent(ticket) && catalogRequest.current === controller) {
        const message = error instanceof Error ? error.message : 'Curated picks are temporarily unavailable.';
        if (append) { setCuratedMoreError(message); setCuratedPageStatus(`${previous?.products.length ?? 0} products remain loaded. More products could not be loaded; retry below.`); } else setCuratedError(message);
      }
    } finally {
      if (storefrontFence.current.isCurrent(ticket) && catalogRequest.current === controller) {
        catalogRequest.current = null; setCuratedLoading(false); setCuratedMoreLoading(false);
      }
    }
  }

  async function persistCollections(next: ShoppingCollection[], nextActiveId = activeCollectionIdRef.current): Promise<boolean> {
    if (!canChangeCollections()) return false;
    const operation = collectionsOperationRef.current;
    const current = () => collectionsMountedRef.current && repository.isCurrent() && collectionsOperationRef.current === operation;
    const previous = collectionsRef.current.find((item) => item.id === activeCollectionIdRef.current);
    savingCollectionsRef.current = true;
    setIsSavingCollections(true);
    setCollectionNotice(null);
    try {
      await repository.save(next);
      if (!current()) return false;
      const selected = next.find((item) => item.id === nextActiveId);
      if (previous && previous.id !== nextActiveId && renameDraftRef.current !== previous.name) {
        const retained = { collectionName: previous.name, value: renameDraftRef.current };
        setRetainedRenames((drafts) => [...drafts, retained]);
      }
      if (!previous || previous.id !== nextActiveId || renameDraftRef.current === previous.name) {
        renameDraftRef.current = selected?.name ?? '';
        setRenameDraft(renameDraftRef.current);
      }
      collectionsRef.current = next;
      activeCollectionIdRef.current = nextActiveId;
      collectionsViewRevisionRef.current += 1;
      setCollectionsViewRevision(collectionsViewRevisionRef.current);
      draftInputRevisionRef.current += 1;
      setDraftInputRevision(draftInputRevisionRef.current);
      setCollections(next);
      setActiveCollectionId(nextActiveId);
      return true;
    } catch {
      if (!current()) return false;
      collectionsVerifiedRef.current = false;
      collectionsViewRevisionRef.current += 1;
      setCollectionsViewRevision(collectionsViewRevisionRef.current);
      saveUncertainRef.current = true;
      setStorageError('Your last change may already have been saved. Reload saved collections and review them before making changes.');
      return false;
    } finally {
      if (current()) {
        savingCollectionsRef.current = false;
        setIsSavingCollections(false);
      }
    }
  }

  async function createCollection() {
    if (!canChangeCollections()) return;
    const draft = collectionDraftRef.current;
    const name = draft.trim();
    if (!name) {
      setCollectionNotice('Enter a name for your collection.');
      return;
    }
    if (name.length > MAX_COLLECTION_NAME_LENGTH) {
      setCollectionNotice(`Keep collection names to ${MAX_COLLECTION_NAME_LENGTH} characters.`);
      return;
    }
    const currentCollections = collectionsRef.current;
    if (currentCollections.length >= MAX_COLLECTIONS) {
      setCollectionNotice(`You can keep up to ${MAX_COLLECTIONS} collections on this device.`);
      return;
    }
    if (currentCollections.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setCollectionNotice('A collection with that name already exists.');
      return;
    }
    const created = newCollection(name);
    if (await persistCollections([...currentCollections, created], created.id) && repository.isCurrent() && collectionDraftRef.current === draft) {
      collectionDraftRef.current = '';
      setCollectionDraft('');
    }
  }

  async function renameCollection() {
    if (!canChangeCollections()) return;
    const currentCollections = collectionsRef.current;
    const selected = currentCollections.find((item) => item.id === activeCollectionIdRef.current);
    if (!selected) return;
    const name = renameDraftRef.current.trim();
    if (!name) {
      setCollectionNotice('Enter a name for this collection.');
      return;
    }
    if (name.length > MAX_COLLECTION_NAME_LENGTH) {
      setCollectionNotice(`Keep collection names to ${MAX_COLLECTION_NAME_LENGTH} characters.`);
      return;
    }
    if (currentCollections.some((item) => item.id !== selected.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setCollectionNotice('A collection with that name already exists.');
      return;
    }
    const next = currentCollections.map((item) => item.id === selected.id ? { ...item, name, updatedAt: new Date().toISOString() } : item);
    await persistCollections(next, selected.id);
  }

  async function deleteCollection() {
    if (!canChangeCollections()) return;
    const selectedId = activeCollectionIdRef.current;
    if (!selectedId) return;
    const next = collectionsRef.current.filter((item) => item.id !== selectedId);
    const nextId = next[0]?.id ?? null;
    if (await persistCollections(next, nextId) && repository.isCurrent()) setDeletePending(false);
  }

  async function removeSavedProduct(productId: string) {
    if (!canChangeCollections()) return;
    const selectedId = activeCollectionIdRef.current;
    if (!selectedId) return;
    const next = collectionsRef.current.map((item) => item.id === selectedId
      ? { ...item, items: item.items.filter((saved) => saved.id !== productId), updatedAt: new Date().toISOString() }
      : item);
    await persistCollections(next, selectedId);
  }

  async function saveProduct(product: Channel3Product, ticket: StorefrontTicket | null) {
    if (!canChangeCollections() || !ticket || !storefrontFence.current.isCurrent(ticket)) return;
    try {
      const plan = planProductSave(collectionsRef.current, activeCollectionIdRef.current, product, ticket.storefront);
      if (await persistCollections(plan.collections, plan.activeId) && repository.isCurrent() && plan.createdFavourites) {
        setCollectionNotice('Saved to Favourites on this device.');
      }
    } catch (error) {
      if (!repository.isCurrent()) return false;
      setCollectionNotice(error instanceof Error ? error.message : 'This product could not be saved.');
    }
  }

  async function runSearch(searchText = query) {
    if (!storefrontReady || searching) return;
    chooseDiscoveryMode('search');
    const cleaned = searchText.trim();
    if (cleaned.length < 2 || cleaned.length > 120) {
      setSearchError('Enter a search phrase between 2 and 120 characters.');
      return;
    }
    const priceDraft = parsePriceRangeDraft(minimumPrice, maximumPrice);
    if (priceDraft.error) {
      setSearchError(priceDraft.error);
      return;
    }
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    setCuratedSection(null);
    setCuratedRetailer(null);
    setCuratedMoreLoading(false);
    setCuratedMoreError(null);
    setCuratedPageStatus('');
    setCuratedCatalog(null);
    setCuratedFirstRetrievedAt(null);
    setCuratedTicket(null);
    setCuratedError(null);
    setCuratedLoading(false);
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    const identity = storageFence.current();
    searchIdentity.current = identity;
    searchInterrupted.current = false;
    const ticket = storefrontFence.current.capture();
    const current = () => !controller.signal.aborted && storageFence.current() === identity && storefrontFence.current.isCurrent(ticket) && searchRequest.current === controller;
    setSearching(true);
    setSearchError(null);
    setSearchMoreLoading(false);
    setSearchMoreError(null);
    setSearchPageStatus('');
    publishSearchSnapshot(null);
    recheckRequest.current?.abort();
    recheckRequest.current = null;
    refreshingProductRef.current = null;
    setRefreshingProductId(null);
    clearVerifiedOffers();
    try {
      const result = await searchChannel3(cleaned, ticket.storefront, controller.signal, priceDraft.range ? { priceRange: priceDraft.range } : {});
      if (!current()) return;
      const seen = new Set<string>();
      const products = result.products.filter((product) => !seen.has(product.id) && !!seen.add(product.id)).slice(0, MAX_SEARCH_RESULTS);
      const nextPageToken = result.nextPageToken ?? null;
      publishSearchSnapshot({ query: cleaned, ticket, priceRange: result.priceRange, products, firstRetrievedAt: result.retrievedAt, latestRetrievedAt: result.retrievedAt, nextPageToken, seenTokens: nextPageToken ? [nextPageToken] : [], pages: 1, stopReason: nextPageToken ? null : 'complete' });
      setQuery(cleaned);
      setSearchPageStatus(`${products.length} products loaded.${nextPageToken ? ' More results are available.' : ' The service did not provide another page.'}`);
      if (!products.length && !nextPageToken) setSearchError('No products were returned for that phrase. Try a broader search.');
    } catch (error) {
      if (current()) {
        setSearchError(error instanceof Error ? error.message : 'The product catalog is temporarily unavailable.');
      }
    } finally {
      if (current()) {
        searchRequest.current = null;
        searchIdentity.current = null;
        setSearching(false);
      }
    }
  }

  async function loadMoreSearch() {
    const previous = searchSnapshotRef.current;
    if (!storefrontReady || searching || searchRequest.current || !previous?.nextPageToken || !storefrontFence.current.isCurrent(previous.ticket)) return;
    const controller = new AbortController();
    const identity = storageFence.current();
    searchRequest.current = controller;
    searchIdentity.current = identity;
    searchInterrupted.current = false;
    const current = () => !controller.signal.aborted && storageFence.current() === identity && storefrontFence.current.isCurrent(previous.ticket) && searchRequest.current === controller && searchSnapshotRef.current === previous;
    setSearchMoreLoading(true);
    setSearchMoreError(null);
    setSearchPageStatus('Loading more search results…');
    try {
      const result = await searchChannel3(previous.query, previous.ticket.storefront, controller.signal, { pageToken: previous.nextPageToken, ...(previous.priceRange ? { priceRange: previous.priceRange } : {}) });
      if (!current()) return;
      if (result.priceRange?.minPrice !== previous.priceRange?.minPrice || result.priceRange?.maxPrice !== previous.priceRange?.maxPrice) {
        throw new Error('The price filter changed while loading results. Start the search again.');
      }
      const seen = new Set<string>();
      const products = [...previous.products, ...result.products].filter((product) => !seen.has(product.id) && !!seen.add(product.id)).slice(0, MAX_SEARCH_RESULTS);
      const next = result.nextPageToken ?? null;
      const pages = previous.pages + 1;
      const repeated = next !== null && previous.seenTokens.includes(next);
      const stopReason: SearchStopReason = !next ? 'complete' : repeated ? 'repeated-token' : products.length >= MAX_SEARCH_RESULTS ? 'result-limit' : pages >= MAX_SEARCH_PAGES ? 'page-limit' : null;
      publishSearchSnapshot({ ...previous, products, latestRetrievedAt: result.retrievedAt, pages, nextPageToken: stopReason ? null : next, seenTokens: next ? [...previous.seenTokens, next] : previous.seenTokens, stopReason });
      const endMessage = stopReason === 'complete' ? ' The service did not provide another page.' : stopReason === 'result-limit' ? ' Search result limit reached; refine the search to explore more.' : stopReason === 'page-limit' ? ' Search page limit reached; refine the search to explore more.' : stopReason === 'repeated-token' ? ' The catalog repeated a page; start a new search to continue.' : '';
      setSearchPageStatus(`${products.length - previous.products.length} more products added. ${products.length} products loaded.${endMessage}`);
    } catch (error) {
      if (current()) {
        setSearchMoreError(error instanceof Error ? error.message : 'More search results are temporarily unavailable.');
        setSearchPageStatus(`${previous.products.length} products remain loaded. More results could not be loaded; retry below.`);
      }
    } finally {
      // Publishing a successful page replaces the snapshot; the request and
      // identity are still the authority for clearing its loading state.
      if (!controller.signal.aborted && storageFence.current() === identity && storefrontFence.current.isCurrent(previous.ticket) && searchRequest.current === controller) {
        searchRequest.current = null;
        searchIdentity.current = null;
        setSearchMoreLoading(false);
      }
    }
  }

  async function toggleSimilarAlternatives(product: Channel3Product | SavedProduct, candidates: readonly Channel3Product[], sourceTicket?: StorefrontTicket | null) {
    if (similarVisibleByProduct[product.id]) {
      setSimilarVisibleByProduct((current) => ({ ...current, [product.id]: false }));
      return;
    }
    const privateRepository = sourceTicket === undefined ? repository : undefined;
    const privateCurrent = () => !privateRepository || (privateVisible && privateRepository.isCurrent());
    if (!storefrontReady || sourceTicket === null || refreshingProductRef.current !== null || (sourceTicket && !storefrontFence.current.isCurrent(sourceTicket)) || !privateCurrent()) return;
    const cached = findSimilarInStockProducts(product, [...(similarByProduct[product.id] ?? []), ...candidates]);
    if (cached.length) {
      setSimilarByProduct((current) => ({ ...current, [product.id]: cached }));
      setSimilarErrorByProduct((current) => ({ ...current, [product.id]: '' }));
      setSimilarVisibleByProduct((current) => ({ ...current, [product.id]: true }));
      return;
    }
    setSimilarVisibleByProduct((current) => ({ ...current, [product.id]: true }));
    const query = similarProductQuery(product.title);
    if (!query) {
      setSimilarErrorByProduct((current) => ({ ...current, [product.id]: 'No similar in-stock items were found in this list. Try a broader search.' }));
      return;
    }
    const ticket = sourceTicket ?? storefrontFence.current.capture();
    const controller = new AbortController();
    recheckRequest.current = controller;
    recheckPrivateRepository.current = privateRepository ?? null;
    setRefreshRepository(privateRepository ?? null);
    refreshingProductRef.current = product.id;
    setRefreshingProductId(product.id);
    setSimilarLoadingByProduct((current) => ({ ...current, [product.id]: true }));
    setSimilarErrorByProduct((current) => ({ ...current, [product.id]: '' }));
    try {
      const result = await searchChannel3(query, ticket.storefront, controller.signal);
      if (!privateCurrent() || controller.signal.aborted || !storefrontFence.current.isCurrent(ticket) || recheckRequest.current !== controller) return;
      const similar = findSimilarInStockProducts(product, result.products);
      setSimilarByProduct((current) => ({ ...current, [product.id]: similar }));
      setSimilarErrorByProduct((current) => ({ ...current, [product.id]: similar.length ? '' : 'No similar items are currently reported in stock.' }));
    } catch (error) {
      if (privateCurrent() && !controller.signal.aborted && storefrontFence.current.isCurrent(ticket) && recheckRequest.current === controller) {
        setSimilarErrorByProduct((current) => ({ ...current, [product.id]: error instanceof Error ? error.message : 'Similar items could not be loaded right now.' }));
      }
    } finally {
      if (storefrontFence.current.isCurrent(ticket) && recheckRequest.current === controller) {
        recheckRequest.current = null;
        refreshingProductRef.current = null;
        if (privateCurrent()) setRefreshingProductId(null);
        setSimilarLoadingByProduct((current) => ({ ...current, [product.id]: false }));
      }
    }
  }

  async function refreshProductOffers(product: Channel3Product | SavedProduct, sourceTicket?: StorefrontTicket | null, openAfterCheck = false, preferredDomain?: string, handoffWindow?: Window | null) {
    const closeHandoff = () => { if (handoffWindow && !handoffWindow.closed) handoffWindow.close(); };
    const privateRepository = sourceTicket === undefined ? repository : undefined;
    const privateCurrent = () => !privateRepository || (privateVisible && privateRepository.isCurrent());
    if (!privateCurrent()) { closeHandoff(); return; }
    if (!storefrontReady || sourceTicket === null || refreshingProductRef.current !== null || (sourceTicket && !storefrontFence.current.isCurrent(sourceTicket))) { closeHandoff(); return; }
    const ticket = sourceTicket ?? storefrontFence.current.capture();
    const controller = new AbortController();
    recheckRequest.current = controller;
    recheckPrivateRepository.current = privateRepository ?? null;
    setRefreshRepository(privateRepository ?? null);
    refreshingProductRef.current = product.id;
    setRefreshingProductId(product.id);
    setOfferError(product.id, null);
    const previousTimer = offerTimers.current.get(product.id);
    if (previousTimer) clearTimeout(previousTimer);
    offerTimers.current.delete(product.id);
    setVerifiedByProduct((current) => {
      const next = { ...current };
      delete next[product.id];
      return next;
    });
    try {
      const query = product.title.trim().slice(0, 120);
      let exactMatch: Channel3Product | undefined;
      const checkedCandidates: Channel3Product[] = [];
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      // Each page is a separate rate-limited, collection-scoped request.
      // Bound the work: a miss is inconclusive, not proof of removal.
      for (let page = 0; page < 3; page++) {
        const result = await searchChannel3(query, ticket.storefront, controller.signal, pageToken ? { pageToken } : {});
        if (!privateCurrent() || controller.signal.aborted || !storefrontFence.current.isCurrent(ticket) || recheckRequest.current !== controller) { closeHandoff(); return; }
        for (const candidate of result.products) if (!checkedCandidates.some((item) => item.id === candidate.id)) checkedCandidates.push(candidate);
        exactMatch = result.products.find((item) => item.id === product.id);
        if (exactMatch || !result.nextPageToken || seenTokens.has(result.nextPageToken)) break;
        seenTokens.add(result.nextPageToken);
        pageToken = result.nextPageToken;
      }
      if (!exactMatch) {
        const similar = findSimilarInStockProducts(product, checkedCandidates);
        setAvailabilityUnconfirmedByProduct((current) => ({ ...current, [product.id]: true }));
        setSimilarByProduct((current) => ({ ...current, [product.id]: similar }));
        setSimilarVisibleByProduct((current) => ({ ...current, [product.id]: true }));
        setSimilarErrorByProduct((current) => ({ ...current, [product.id]: similar.length ? '' : 'No similar in-stock items were found in the checked results.' }));
        throw new Error('Channel3 could not confirm this exact product in the checked results. Search for it again before opening a retailer.');
      }
      const similar = findSimilarInStockProducts(product, checkedCandidates);
      setAvailabilityUnconfirmedByProduct((current) => {
        if (!current[product.id]) return current;
        const next = { ...current };
        delete next[product.id];
        return next;
      });
      const hasAnyInStockOffer = exactMatch.offers.some((offer) => offer.url && offer.availability === 'InStock');
      const selectedRetailerUnavailable = Boolean(preferredDomain && !exactMatch.offers.some((offer) => offer.domain === preferredDomain && offer.url && offer.availability === 'InStock'));
      setSimilarByProduct((current) => ({ ...current, [product.id]: similar }));
      if (!hasAnyInStockOffer || selectedRetailerUnavailable) {
        setSimilarVisibleByProduct((current) => ({ ...current, [product.id]: true }));
        setSimilarErrorByProduct((current) => ({ ...current, [product.id]: similar.length ? '' : 'No similar in-stock items were found in the checked results.' }));
      }
      const handoffOffer = preferredDomain
        ? exactMatch.offers.find((offer) => offer.domain === preferredDomain && offer.url && offer.availability === 'InStock')
        : preferredRetailerOffer(exactMatch);
      const verifiedAt = currentEpochMs();
      setVerifiedByProduct((current) => ({ ...current, [product.id]: { offers: exactMatch.offers, verifiedAt, ticket, repository: privateRepository } }));
      const timer = setTimeout(() => {
        if (!privateCurrent() || offerTimers.current.get(product.id) !== timer) return;
        offerTimers.current.delete(product.id);
        setVerifiedByProduct((current) => {
          const currentEntry = current[product.id];
          if (!currentEntry || currentEntry.verifiedAt !== verifiedAt || currentEntry.ticket.revision !== ticket.revision) return current;
          const next = { ...current };
          delete next[product.id];
          return next;
        });
      }, VERIFIED_OFFERS_TTL_MS);
      offerTimers.current.set(product.id, timer);
      if (openAfterCheck && !handoffOffer) {
        setOfferError(product.id, preferredDomain
          ? 'Sorry, Channel3 reports that retailer out of stock. Current offers and similar options are shown below.'
          : 'Sorry, Channel3 reports no in-stock offers for this item. Similar options are shown below when available.');
        closeHandoff();
        return;
      }
      if (openAfterCheck && handoffOffer) {
        if (handoffWindow) {
          if (!handoffWindow.closed) handoffWindow.location.replace(handoffOffer.url);
        } else await Linking.openURL(handoffOffer.url);
      }
    } catch (error) {
      closeHandoff();
      if (privateCurrent() && !controller.signal.aborted && storefrontFence.current.isCurrent(ticket) && recheckRequest.current === controller) {
        setOfferError(product.id, error instanceof Error ? error.message : 'Current retailer offers could not be confirmed.');
      }
    } finally {
      if (storefrontFence.current.isCurrent(ticket) && recheckRequest.current === controller) {
        recheckRequest.current = null;
        refreshingProductRef.current = null;
        if (privateCurrent()) setRefreshingProductId(null);
      }
    }
  }

  function openProductAtRetailer(product: Channel3Product | SavedProduct, sourceTicket?: StorefrontTicket | null) {
    const handoffWindow = Platform.OS === 'web' ? window.open('about:blank', '_blank') : null;
    if (Platform.OS === 'web' && !handoffWindow) {
      setOfferError(product.id, 'Your browser blocked the retailer tab. Allow pop-ups, then tap the product again.');
      return;
    }
    if (handoffWindow) {
      handoffWindow.opener = null;
      handoffWindow.document.title = 'PayPal Markets';
    }
    void refreshProductOffers(product, sourceTicket, true, undefined, handoffWindow);
  }

  function openRetailer(product: Channel3Product | SavedProduct, offer: Channel3Offer) {
    const verified = verifiedByProduct[product.id];
    if (verified?.repository && !verified.repository.isCurrent()) return;
    if (!verified || !storefrontFence.current.isCurrent(verified.ticket) || !verified.offers.some((item) => item.url === offer.url && item.domain === offer.domain && item.availability === 'InStock')) {
      setVerifiedByProduct((current) => {
        const next = { ...current };
        delete next[product.id];
        return next;
      });
      setOfferError(product.id, 'Refresh offers before leaving the app.');
      return;
    }
    const handoffWindow = Platform.OS === 'web' ? window.open('about:blank', '_blank') : null;
    if (Platform.OS === 'web' && !handoffWindow) {
      setOfferError(product.id, 'Your browser blocked the retailer tab. Allow pop-ups, then try again.');
      return;
    }
    if (handoffWindow) {
      handoffWindow.opener = null;
      handoffWindow.document.title = 'PayPal Markets';
    }
    void refreshProductOffers(product, verified.repository ? undefined : verified.ticket, true, offer.domain, handoffWindow);
  }

  function selectCollection(collection: ShoppingCollection) {
    if (!canChangeCollections()) return;
    const selected = collectionsRef.current.find((item) => item.id === collection.id);
    if (!selected) return;
    const previous = collectionsRef.current.find((item) => item.id === activeCollectionIdRef.current);
    if (previous?.id === selected.id) return;
    if (previous && previous.id !== selected.id && renameDraftRef.current !== previous.name) {
      const retained = { collectionName: previous.name, value: renameDraftRef.current };
      setRetainedRenames((drafts) => [...drafts, retained]);
    }
    activeCollectionIdRef.current = selected.id;
    renameDraftRef.current = selected.name;
    collectionsViewRevisionRef.current += 1;
    setCollectionsViewRevision(collectionsViewRevisionRef.current);
    draftInputRevisionRef.current += 1;
    setDraftInputRevision(draftInputRevisionRef.current);
    setActiveCollectionId(selected.id);
    setRenameDraft(selected.name);
    setCollectionNotice(null);
    setDeletePending(false);
  }

  const hasCollections = collections.length > 0;
  const seasonalEdit = getChannel3SeasonalEdit(new Date(), storefront);
  const seasonalSectionIds = new Set(seasonalEdit.sectionIds);
  const seasonalCategories = CURATED_CATEGORIES.filter((category) => seasonalSectionIds.has(category.id));
  const otherCategories = CURATED_CATEGORIES.filter((category) => !seasonalSectionIds.has(category.id));
  const renderCuratedCategory = (category: typeof CURATED_CATEGORIES[number]) => {
    const selected = curatedSection === category.id;
    return (
      <Pressable
        key={category.id}
        accessibilityRole="button"
        accessibilityLabel={`${category.label} curated picks. ${category.description} Tap to load products.`}
        accessibilityState={{ selected, disabled: curatedLoading || !storefrontReady }}
        onPress={() => void loadCuratedSection(category.id, null)}
        disabled={curatedLoading || !storefrontReady}
        style={({ pressed }) => [styles.curatedChoice, selected && styles.curatedChoiceSelected, pressed && styles.pressed, (curatedLoading || !storefrontReady) && styles.disabled]}>
        <Text style={[styles.curatedSymbol, selected && styles.curatedTextSelected]}>{category.symbol}</Text>
        <Text style={[styles.curatedChoiceLabel, selected && styles.curatedTextSelected]}>{category.label}</Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, layout.wideCanvas && styles.contentWide]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            <View style={styles.brandLockup}>
              <View style={styles.paypalMark}><Text style={styles.paypalMarkText}>P</Text></View>
              <View>
                <Text style={styles.brandName}>PayPal</Text>
                <Text style={styles.brandProduct}>MARKETS · CONCEPT</Text>
              </View>
            </View>
            <View style={styles.channelTag}><Text style={styles.channelTagText}>CHANNEL3</Text></View>
          </View>

          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={styles.kicker}>Discover</Text>
            <Text style={styles.pageTitle}>Shop</Text>
            <Text style={styles.subtitle}>Search, compare, save.</Text>
          </View>


          <View style={styles.storefrontCard}>
            <View style={styles.storefrontHeading}>
              <View style={styles.headingFlex}>
                <Text accessibilityRole="header" style={styles.storefrontTitle}>Shopping region</Text>
                <Text style={styles.storefrontDescription}>Prices follow this region.</Text>
              </View>
              <Text style={styles.storefrontCurrency}>{storefrontReady ? SHOP_STOREFRONTS[storefront].currency : '—'}</Text>
            </View>
            <View style={styles.storefrontChoices} accessibilityRole="radiogroup" accessibilityLabel="Shopping region">
              {(['US', 'GB'] as const).map((option) => {
                const selected = storefrontReady && option === storefront;
                return <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityLabel={`${SHOP_STOREFRONTS[option].label}, ${SHOP_STOREFRONTS[option].currency}`}
                  accessibilityState={{ checked: selected, disabled: !storefrontReady }}
                  aria-checked={Platform.OS === 'web' ? selected : undefined}
                  disabled={!storefrontReady}
                  onPress={() => chooseStorefront(option)}
                  style={({ pressed }) => [styles.storefrontOption, selected && styles.storefrontOptionSelected, !storefrontReady && styles.disabled, pressed && styles.pressed]}>
                  <Text style={[styles.storefrontOptionLabel, selected && styles.storefrontOptionLabelSelected]}>{SHOP_STOREFRONTS[option].shortLabel}</Text>
                  <Text style={styles.storefrontOptionCurrency}>{SHOP_STOREFRONTS[option].currency}</Text>
                </Pressable>;
              })}
            </View>
            <Text style={styles.storefrontFootnote}>{storefrontReady ? `Offers refresh · ${SHOP_STOREFRONTS[storefront].currency}.${query.trim() ? ' Check price limits.' : ''}` : 'Loading region…'}</Text>
            {(storefrontStatus === 'invalid' || storefrontStatus === 'unavailable') && <Text style={styles.storefrontNotice} accessibilityRole="summary" accessibilityLiveRegion="polite">{storefrontStatus === 'invalid' ? 'The saved shopping region could not be read. Select a region to replace it.' : 'Your shopping region could not be read or saved. This choice applies for this session.'}</Text>}
          </View>

          <View style={styles.discoveryModes} accessibilityRole="radiogroup" accessibilityLabel="Catalogue view">
            {(['browse', 'search'] as const).map((mode) => {
              const selected = discoveryMode === mode;
              const label = mode === 'browse' ? 'Browse' : 'Search';
              return <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityLabel={`${label} catalogue`}
                accessibilityState={{ checked: selected }}
                aria-checked={Platform.OS === 'web' ? selected : undefined}
                onPress={() => chooseDiscoveryMode(mode)}
                style={({ pressed }) => [styles.discoveryModeOption, selected && styles.discoveryModeSelected, pressed && styles.pressed]}>
                <Text style={[styles.discoveryModeText, selected && styles.discoveryModeTextSelected]}>{label}</Text>
              </Pressable>;
            })}
          </View>

          <View style={styles.privacyNotice} accessibilityRole="summary">
            <Text style={styles.privacyTitle}>Saved lists stay on this device</Text>
            <Text style={styles.privacyText}>Search goes through PayPal Markets to Channel3; image requests expose your IP. Last-seen prices stay on this device; retailer links are never saved.</Text>
          </View>

          {discoveryMode === 'browse' && <>
          <View style={styles.curatedSection}>
            <View style={styles.sectionHeadingRow}>
              <View style={styles.headingFlex}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Curated picks</Text>
                <Text style={styles.sectionSubtitle}>Seasonal browse · {seasonalEdit.label} · {storefront}</Text>
              </View>
              <Text style={styles.curatedBadge}>CHANNEL3</Text>
            </View>
            <Text style={styles.sectionSubtitle}>Seasonal</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.curatedChoices}>
              {seasonalCategories.map(renderCuratedCategory)}
            </ScrollView>
            <Text style={styles.sectionSubtitle}>All categories</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.curatedChoices}>
              {otherCategories.map(renderCuratedCategory)}
            </ScrollView>
            <Text style={styles.sectionSubtitle}>US retailers</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.curatedChoices}>
              {CHANNEL3_CURATED_RETAILERS.map(retailer => <Pressable key={retailer.id} accessibilityRole="button" accessibilityLabel={`Browse ${retailer.title}, US retailer`} accessibilityState={{ selected: curatedRetailer === retailer.id, disabled: !storefrontReady }} disabled={!storefrontReady} onPress={() => void loadCuratedSection(null, retailer.id)} style={[styles.retailerChoice, curatedRetailer === retailer.id && styles.curatedChoiceSelected, !storefrontReady && styles.disabled]}><Text style={styles.curatedChoiceLabel}>{retailer.title}</Text></Pressable>)}
              {curatedRetailer && curatedSection && <NativeButton label="All retailers" onPress={() => void loadCuratedSection(curatedSection, null)} />}
            </ScrollView>
            {curatedRetailer && storefront === 'GB' && <View><Text style={styles.storefrontFootnote}>These US retailers may have no UK offers. Your region has not changed.</Text><NativeButton label="Choose United States storefront" onPress={() => chooseStorefront('US')} /></View>}
            <Text style={styles.commissionLegend}>{COMMISSION_LEGEND}</Text>
          </View>

          {curatedLoading && (
            <View
              style={styles.loadingCard}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={`Loading ${[CHANNEL3_CURATED_RETAILERS.find((item) => item.id === curatedRetailer)?.title, CURATED_CATEGORIES.find((item) => item.id === curatedSection)?.label].filter(Boolean).join(' ') || 'curated'} picks`}
              accessibilityState={{ busy: true }}
              accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.link} accessible={false} />
              <Text style={styles.loadingText} accessible={false}>Loading curated products…</Text>
            </View>
          )}
          {curatedError && (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle} accessibilityRole="alert" accessibilityLabel={`Curated picks need attention. ${curatedError}`} accessibilityLiveRegion="polite">Curated picks need attention</Text>
              <Text style={styles.errorText}>{curatedError}</Text>
              {(curatedSection || curatedRetailer) && <Pressable accessibilityRole="button" onPress={() => void loadCuratedSection(curatedSection, curatedRetailer)} style={styles.retryButton}><Text style={styles.retryText}>Retry curated picks</Text></Pressable>}
            </View>
          )}
          {curatedCatalog && (
            <View style={styles.resultsSection}>
              <View style={styles.sectionHeadingRow}>
                <View style={styles.headingFlex}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>{curatedCatalog.title}</Text>
                  <Text style={styles.sectionSubtitle}>{SHOP_STOREFRONTS[curatedCatalog.storefront].label} · {curatedCatalog.currency} · {curatedCatalog.products.length} products</Text>
                  <Text style={styles.sectionSubtitle}>{pageRetrievalLabel(curatedFirstRetrievedAt ?? curatedCatalog.retrievedAt, curatedCatalog.retrievedAt)}</Text>
                </View>
                <Text style={styles.curatedBadge}>CURATED</Text>
              </View>
              {curatedCatalog.products.length === 0 ? (
                <View style={styles.emptySaved}><Text style={styles.emptySavedText}>{curatedCatalog.nextPageToken ? 'No products appeared in this page. Load more to continue.' : 'No products were returned for this selection. Try another category or retailer.'}</Text></View>
              ) : <View style={layout.shopGrid ? styles.productGrid : undefined}>{curatedCatalog.products.map((product) => {
                const alreadySaved = saveTarget?.items.some((item) => item.id === product.id) ?? false;
                const directOffer = preferredRetailerOffer(product);
                const directOfferLabel = directOffer ? offerHandoffLabel(directOffer) : 'a current retailer';
                return (
                  <View key={`curated-${product.id}`} style={[styles.productCard, layout.shopGrid && styles.productGridItem]}>
                    <View style={styles.productHeading}>
                      <Pressable accessibilityRole="link" accessibilityLabel={`Open ${product.title} at ${directOfferLabel}`} accessibilityHint="Checks this exact product before opening the retailer. The retailer confirms final price and checkout." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product, curatedTicket)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [styles.productThumbnailLink, pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}>
                        <ProductThumbnail key={`${product.id}-${product.imageUrl ?? ''}`} imageUrl={product.imageUrl} />
                      </Pressable>
                      <View style={styles.productInfo}>
                        <Text style={styles.productBrand}>{productLabel(product.brand)}</Text>
                        <Pressable accessibilityRole="link" accessibilityLabel={`Open ${product.title} at ${directOfferLabel}`} accessibilityHint="Checks this exact product before opening the retailer. The retailer confirms final price and checkout." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product, curatedTicket)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}>
                          <Text style={styles.productName}>{product.title}</Text>
                        </Pressable>
                        {directOffer && <Text style={styles.productLinkHint}>Shop at {directOfferLabel} ↗</Text>}
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${alreadySaved ? 'Already saved' : 'Save'} ${product.title} to ${saveTarget?.name ?? 'Favourites'} on this device`}
                        accessibilityState={{ disabled: !mayChangeCollections || alreadySaved }}
                        onPress={() => void saveProduct(product, curatedTicket)}
                        disabled={!mayChangeCollections || alreadySaved}
                        style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, (!mayChangeCollections || alreadySaved) && styles.disabled]}
                      >
                        <Text style={styles.saveButtonText}>{alreadySaved ? 'Saved' : '＋ Save'}</Text>
                      </Pressable>
                    </View>
                    <View style={styles.offerSummary}>
                      <Text style={styles.offerSummaryLabel}>{product.offers.length ? `${product.offers.length} retailer offers found` : 'No retailer offers in this result'}</Text>
                      {product.offers.map((offer, index) => {
                        const status = offerSnapshotStatus(offer, verifiedByProduct[product.id], Boolean(availabilityUnconfirmedByProduct[product.id]));
                        return <View key={`${product.id}-curated-${offer.domain}-${index}`} style={styles.offerRow}>
                          <View style={styles.offerRetailerInfo}><Text style={styles.offerDomain} numberOfLines={1}>{offer.domain}</Text><Text style={styles.commission}>{commissionLabel(offer.maxCommissionRate)}</Text></View>
                          <Text style={styles.offerPrice}>{formatPrice(offer.price, offer.currency)}</Text>
                          <Text style={[styles.availability, status.availability === 'InStock' ? styles.inStock : status.availability === 'OutOfStock' ? styles.outOfStock : styles.unknownStock]}>
                            {status.label}
                          </Text>
                        </View>;
                      })}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Recheck offers for ${product.title}`}
                      accessibilityState={{ disabled: refreshingProductId !== null, busy: refreshingProductId === product.id }}
                      onPress={() => void refreshProductOffers(product, curatedTicket)}
                      disabled={refreshingProductId !== null}
                      style={({ pressed }) => [styles.refreshOffersButton, pressed && styles.pressed, refreshingProductId !== null && styles.disabled]}
                    >
                      {refreshingProductId === product.id ? <ActivityIndicator size="small" color={colors.link} /> : <Text style={styles.refreshGlyph}>↻</Text>}
                      <Text style={styles.refreshOffersText}>{refreshingProductId === product.id ? 'Checking offers…' : 'Refresh offers'}</Text>
                    </Pressable>
                    <VerifiedOffersCard product={product} verified={verifiedByProduct[product.id]?.repository && !verifiedByProduct[product.id].repository?.isCurrent() ? undefined : verifiedByProduct[product.id]} error={offerErrors[product.id]} refreshing={refreshingProductId === product.id} similarProducts={findSimilarInStockProducts(product, [...(similarByProduct[product.id] ?? []), ...(curatedCatalog?.products ?? []), ...(searchSnapshot?.products ?? [])])} similarVisible={Boolean(similarVisibleByProduct[product.id])} similarLoading={Boolean(similarLoadingByProduct[product.id])} similarError={similarErrorByProduct[product.id]} onFindSimilar={() => void toggleSimilarAlternatives(product, [...(curatedCatalog?.products ?? []), ...(searchSnapshot?.products ?? [])], curatedTicket)} onOpenSimilar={(candidate) => openProductAtRetailer(candidate, storefrontFence.current.capture())} onOpen={openRetailer} />
                  </View>
                );
              })}</View>}
            </View>
          )}

          {curatedMoreError && <Text style={styles.offerError} accessibilityRole="alert" accessibilityLiveRegion="polite">{curatedMoreError}</Text>}
          {curatedCatalog && <Text style={styles.sectionSubtitle} accessibilityLiveRegion="polite" accessibilityState={{ busy: curatedMoreLoading }}>{curatedPageStatus}</Text>}
          {curatedCatalog && <NativeButton label={curatedMoreLoading ? 'Loading more products…' : curatedCatalog.nextPageToken ? 'Load more products' : curatedCatalog.products.length >= 96 ? 'Browse limit reached' : 'All loaded'} disabled={curatedMoreLoading || !curatedCatalog.nextPageToken} onPress={() => void loadCuratedSection(curatedSection, curatedRetailer, true)} />}
          </>}

          {discoveryMode === 'search' && <>
          <View style={styles.searchCard}>
            <Text style={styles.sectionTitle}>Find something</Text>
              <Text style={styles.sectionSubtitle}>Search products or brands.</Text>
            <TextInput
              accessibilityLabel="Search products"
              accessibilityHint="Search terms are sent to the Channel3 product catalog through PayPal Markets."
              value={query}
              onChangeText={(value) => { setQuery(value.slice(0, 120)); setSearchError(null); }}
              onSubmitEditing={() => void runSearch()}
              placeholder="e.g. bags under 150"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={120}
              returnKeyType="search"
              editable={storefrontReady && !searching}
              style={styles.searchInput}
            />
            <View style={styles.priceFilterGroup}>
              <Text style={styles.priceFilterTitle}>Price range · {storefrontReady ? SHOP_STOREFRONTS[storefront].currency : '—'}</Text>
              <View style={styles.priceFilterFields}>
                <View style={styles.priceFilterField}>
                  <Text style={styles.priceFilterLabel}>Minimum</Text>
                  <TextInput
                    accessibilityLabel={`Minimum price in ${storefrontReady ? SHOP_STOREFRONTS[storefront].currency : 'selected currency'}`}
                    value={minimumPrice}
                    onChangeText={(value) => { setMinimumPrice(value.slice(0, 14)); setSearchError(null); }}
                    placeholder="No minimum"
                    placeholderTextColor={colors.muted}
                    keyboardType="decimal-pad"
                    maxLength={14}
                    editable={storefrontReady && !searching}
                    style={styles.priceFilterInput}
                  />
                </View>
                <View style={styles.priceFilterField}>
                  <Text style={styles.priceFilterLabel}>Maximum</Text>
                  <TextInput
                    accessibilityLabel={`Maximum price in ${storefrontReady ? SHOP_STOREFRONTS[storefront].currency : 'selected currency'}`}
                    value={maximumPrice}
                    onChangeText={(value) => { setMaximumPrice(value.slice(0, 14)); setSearchError(null); }}
                    placeholder="No maximum"
                    placeholderTextColor={colors.muted}
                    keyboardType="decimal-pad"
                    maxLength={14}
                    editable={storefrontReady && !searching}
                    style={styles.priceFilterInput}
                  />
                </View>
              </View>
              <Text style={styles.priceFilterHelp}>Prices use this region; “under 150” also filters results.</Text>
            </View>
            <View style={styles.searchButton}>
              <NativeButton label={searching ? 'Searching Channel3…' : 'Search products'} onPress={() => void runSearch()} disabled={!storefrontReady || searching || query.trim().length < 2} />
            </View>
            <View style={styles.suggestions}>
              {SUGGESTIONS.map((suggestion) => (
                <Pressable
                  key={suggestion}
                  accessibilityRole="button"
                  accessibilityLabel={`Search for ${suggestion}`}
                  onPress={() => { setQuery(suggestion); void runSearch(suggestion); }}
                  disabled={!storefrontReady || searching}
                  style={({ pressed }) => [styles.suggestion, pressed && styles.pressed, (!storefrontReady || searching) && styles.disabled]}
                >
                  <Text style={styles.suggestionText}>{suggestion}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {searching && (
            <View
              style={styles.loadingCard}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Searching the Channel3 product catalog"
              accessibilityState={{ busy: true }}
              accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.link} accessible={false} />
              <Text style={styles.loadingText} accessible={false}>Checking the product catalog…</Text>
            </View>
          )}
          {searchError && (
            <View style={styles.errorCard}>
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLabel={`Product search needs attention. ${searchError}`}
                accessibilityLiveRegion="polite">
                <Text style={styles.errorTitle} accessible={false}>Search needs attention</Text>
                <Text style={styles.errorText} accessible={false}>{searchError}</Text>
              </View>
              {query.trim().length >= 2 && query.trim().length <= 120 && (
                <Pressable accessibilityRole="button" accessibilityLabel="Search again" onPress={() => void runSearch()} style={styles.retryButton}><Text style={styles.retryText}>Search again</Text></Pressable>
              )}
            </View>
          )}
          {searchSnapshot && searchResults && (
            <View style={styles.resultsSection}>
              <View style={styles.sectionHeadingRow}>
                <View style={styles.headingFlex}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Search results</Text>
                  <Text style={styles.sectionSubtitle}>Results for “{searchSnapshot.query}”</Text>
                  <Text style={styles.sectionSubtitle}>{searchTicket ? `${SHOP_STOREFRONTS[searchTicket.storefront].label} · ${SHOP_STOREFRONTS[searchTicket.storefront].currency} · ` : ''}{searchResults.length} products</Text>
                  {searchTicket && appliedPriceLabel(searchSnapshot.priceRange, SHOP_STOREFRONTS[searchTicket.storefront].currency) && <Text style={styles.priceFilterApplied} accessibilityLiveRegion="polite">{appliedPriceLabel(searchSnapshot.priceRange, SHOP_STOREFRONTS[searchTicket.storefront].currency)}</Text>}
                  <Text style={styles.sectionSubtitle}>{pageRetrievalLabel(searchSnapshot.firstRetrievedAt, searchSnapshot.latestRetrievedAt)}</Text>
                </View>
                {searchResults.length > 0 && <Text style={styles.resultBadge}>RETRIEVED OFFERS</Text>}
              </View>
              <View style={layout.shopGrid ? styles.productGrid : undefined}>{searchResults.map((product) => {
                const directOffer = preferredRetailerOffer(product);
                const directOfferLabel = directOffer ? offerHandoffLabel(directOffer) : 'a current retailer';
                return (
                <View key={product.id} style={[styles.productCard, layout.shopGrid && styles.productGridItem]}>
                  <View style={styles.productHeading}>
                    <Pressable accessibilityRole="link" accessibilityLabel={`Open ${product.title} at ${directOfferLabel}`} accessibilityHint="Checks this exact product before opening the retailer. The retailer confirms final price and checkout." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product, searchTicket)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [styles.productThumbnailLink, pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}>
                        <ProductThumbnail key={`${product.id}-${product.imageUrl ?? ''}`} imageUrl={product.imageUrl} />
                    </Pressable>
                    <View style={styles.productInfo}>
                      <Text style={styles.productBrand}>{productLabel(product.brand)}</Text>
                      <Pressable accessibilityRole="link" accessibilityLabel={`Open ${product.title} at ${directOfferLabel}`} accessibilityHint="Checks this exact product before opening the retailer. The retailer confirms final price and checkout." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product, searchTicket)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}>
                        <Text style={styles.productName}>{product.title}</Text>
                      </Pressable>
                      {directOffer && <Text style={styles.productLinkHint}>Shop at {directOfferLabel} ↗</Text>}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${saveTarget?.items.some((item) => item.id === product.id) ? 'Already saved' : 'Save'} ${product.title} to ${saveTarget?.name ?? 'Favourites'} on this device`}
                      accessibilityState={{ disabled: !mayChangeCollections || Boolean(saveTarget?.items.some((item) => item.id === product.id)) }}
                      onPress={() => void saveProduct(product, searchTicket)}
                      disabled={!mayChangeCollections || Boolean(saveTarget?.items.some((item) => item.id === product.id))}
                      style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, (!mayChangeCollections || Boolean(saveTarget?.items.some((item) => item.id === product.id))) && styles.disabled]}
                    >
                      <Text style={styles.saveButtonText}>{saveTarget?.items.some((item) => item.id === product.id) ? 'Saved' : '＋ Save'}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.offerSummary}>
                    <Text style={styles.offerSummaryLabel}>{product.offers.filter((offer) => isOfferWithinPriceRange(offer, searchSnapshot.priceRange, SHOP_STOREFRONTS[searchSnapshot.ticket.storefront].currency)).length ? `${product.offers.filter((offer) => isOfferWithinPriceRange(offer, searchSnapshot.priceRange, SHOP_STOREFRONTS[searchSnapshot.ticket.storefront].currency)).length} retailer offers found` : searchSnapshot.priceRange ? 'No retailer offers match this price range' : 'No retailer offers in this result'}</Text>
                      {product.offers.filter((offer) => isOfferWithinPriceRange(offer, searchSnapshot.priceRange, SHOP_STOREFRONTS[searchSnapshot.ticket.storefront].currency)).map((offer, index) => {
                      const status = offerSnapshotStatus(offer, verifiedByProduct[product.id], Boolean(availabilityUnconfirmedByProduct[product.id]));
                      return <View key={`${product.id}-${offer.domain}-${index}`} style={styles.offerRow}>
                        <View style={styles.offerRetailerInfo}><Text style={styles.offerDomain} numberOfLines={1}>{offer.domain}</Text><Text style={styles.commission}>{commissionLabel(offer.maxCommissionRate)}</Text></View>
                        <Text style={styles.offerPrice}>{formatPrice(offer.price, offer.currency)}</Text>
                        <Text style={[styles.availability, status.availability === 'InStock' ? styles.inStock : status.availability === 'OutOfStock' ? styles.outOfStock : styles.unknownStock]}>
                          {status.label}
                        </Text>
                      </View>;
                    })}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Recheck offers for ${product.title}`}
                      accessibilityState={{ disabled: refreshingProductId !== null, busy: refreshingProductId === product.id }}
                    onPress={() => void refreshProductOffers(product, searchTicket)}
                    disabled={refreshingProductId !== null}
                    style={({ pressed }) => [styles.refreshOffersButton, pressed && styles.pressed, refreshingProductId !== null && styles.disabled]}
                  >
                    {refreshingProductId === product.id ? <ActivityIndicator size="small" color={colors.link} /> : <Text style={styles.refreshGlyph}>↻</Text>}
                    <Text style={styles.refreshOffersText}>{refreshingProductId === product.id ? 'Checking offers…' : 'Refresh offers'}</Text>
                  </Pressable>
                  <VerifiedOffersCard product={product} verified={verifiedByProduct[product.id]?.repository && !verifiedByProduct[product.id].repository?.isCurrent() ? undefined : verifiedByProduct[product.id]} error={offerErrors[product.id]} refreshing={refreshingProductId === product.id} similarProducts={findSimilarInStockProducts(product, [...(similarByProduct[product.id] ?? []), ...(searchSnapshot?.products ?? []), ...(curatedCatalog?.products ?? [])])} similarVisible={Boolean(similarVisibleByProduct[product.id])} similarLoading={Boolean(similarLoadingByProduct[product.id])} similarError={similarErrorByProduct[product.id]} onFindSimilar={() => void toggleSimilarAlternatives(product, [...(searchSnapshot?.products ?? []), ...(curatedCatalog?.products ?? [])], searchTicket)} onOpenSimilar={(candidate) => openProductAtRetailer(candidate, storefrontFence.current.capture())} onOpen={openRetailer} />
                </View>
                );
              })}</View>
              {searchMoreError && <Text style={styles.offerError} accessibilityRole="alert" accessibilityLiveRegion="polite">{searchMoreError}</Text>}
              <Text style={styles.sectionSubtitle} accessibilityLiveRegion="polite" accessibilityState={{ busy: searchMoreLoading }}>{searchPageStatus}</Text>
              <NativeButton
                label={searchMoreLoading ? 'Loading more search results…' : searchSnapshot.nextPageToken ? searchMoreError ? 'Retry loading search results' : 'Load more search results' : searchSnapshot.stopReason === 'complete' ? 'No further page available' : searchSnapshot.stopReason === 'repeated-token' ? 'Search paused' : 'Search limit reached'}
                disabled={!storefrontReady || searching || searchMoreLoading || !searchSnapshot.nextPageToken}
                onPress={() => void loadMoreSearch()}
              />
            </View>
          )}
          </>}

          <View style={styles.collectionsSection}>
            <View style={styles.sectionHeadingRow}>
              <View style={styles.headingFlex}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Your collections</Text>
                <Text style={styles.sectionSubtitle}>{!storageReady ? 'Loading device collections…' : storageError ? 'Saved collections need verification' : `${collections.length}/${MAX_COLLECTIONS} saved on this device`}</Text>
              </View>
              <View style={styles.localBadge}><Text style={styles.localBadgeText}>LOCAL</Text></View>
            </View>

            {storageError && <>
              <View style={styles.errorCard} accessibilityRole="summary" accessibilityLiveRegion="polite">
                <Text style={styles.errorTitle}>Saved collections need review</Text>
                <Text style={styles.errorText}>{storageError}</Text>
                {hasCollections && <Text style={styles.errorText}>The list below is the last checked view and may be out of date.</Text>}
              </View>
              <NativeButton label={reloadingCollections ? 'Checking saved collections…' : 'Reload saved collections'} onPress={() => void reloadSavedCollections()} disabled={reloadingCollections} compact />
            </>}

            {!hasCollections && storageReady && !storageError && (
              <View style={styles.emptyCollection}><Text style={styles.emptyCollectionGlyph}>▤</Text><Text style={styles.emptyCollectionTitle}>Start a shortlist</Text><Text style={styles.emptyCollectionText}>Save a product to start Favourites, or create a named collection. Your lists stay on this device.</Text></View>
            )}

            {hasCollections && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.collectionPills}>
                {collections.map((collection) => {
                  const selected = collection.id === activeCollectionId;
                  return (
                    <Pressable
                      key={collection.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: !mayChangeCollections }}
                      accessibilityLabel={`${collection.name}, ${collection.items.length} products`}
                      onPress={() => selectCollection(collection)}
                      disabled={!mayChangeCollections}
                      style={({ pressed }) => [styles.collectionPill, selected && styles.collectionPillSelected, !mayChangeCollections && styles.disabled, pressed && styles.pressed]}
                    >
                      <Text style={[styles.collectionPillText, selected && styles.collectionPillTextSelected]} numberOfLines={1}>{collection.name}</Text>
                      <Text style={[styles.collectionCount, selected && styles.collectionCountSelected]}>{collection.items.length}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.collectionCreateRow}>
              <TextInput
                accessibilityLabel="New collection name"
                accessibilityHint={`Use up to ${MAX_COLLECTION_NAME_LENGTH} characters.`}
                value={collectionDraft}
                onChangeText={(value) => { if (!privateVisible || !repository.isCurrent() || !collectionsMountedRef.current || draftInputRevision !== draftInputRevisionRef.current) return; collectionDraftRef.current = value; setCollectionDraft(value); setCollectionNotice(null); }}
                onSubmitEditing={() => void createCollection()}
                placeholder="Create a collection"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                editable={mayChangeCollections && collections.length < MAX_COLLECTIONS}
                style={styles.collectionInput}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Create collection" accessibilityState={{ disabled: !mayChangeCollections || !collectionDraft.trim() || collections.length >= MAX_COLLECTIONS }} onPress={() => void createCollection()} disabled={!mayChangeCollections || !collectionDraft.trim() || collections.length >= MAX_COLLECTIONS} style={({ pressed }) => [styles.createButton, pressed && styles.pressed, (!mayChangeCollections || !collectionDraft.trim() || collections.length >= MAX_COLLECTIONS) && styles.disabled]}>
                <Text style={styles.createButtonText}>Create</Text>
              </Pressable>
            </View>

            {collectionNotice && <Text style={styles.collectionNotice} accessibilityLiveRegion="polite">{collectionNotice}</Text>}
            {isSavingCollections && <Text style={styles.savingText} accessibilityLiveRegion="polite">Saving on this device…</Text>}

            {retainedRenames.map((draft, index) => <View key={`${draft.collectionName}-${index}`} style={styles.errorCard}>
              <Text style={styles.errorTitle}>Unfinished name for {draft.collectionName}</Text>
              <Text style={styles.errorText}>This draft is kept separately and will not rename another collection.</Text>
              <TextInput accessibilityLabel={`Unfinished name for ${draft.collectionName}`} value={draft.value} editable={false} style={styles.collectionInput} />
            </View>)}

            {activeCollection && (
              <View style={styles.collectionCard}>
                <View style={styles.collectionHeader}>
                  <View style={styles.headingFlex}>
                    <Text style={styles.collectionTitle}>{activeCollection.name}</Text>
                    <Text style={styles.collectionSubtitle}>{activeCollection.items.length} saved {activeCollection.items.length === 1 ? 'product' : 'products'} · no retailer links saved</Text>
                  </View>
                  <Text style={styles.collectionIcon}>▤</Text>
                </View>

                <View style={styles.renameRow}>
                  <TextInput
                    accessibilityLabel={`Rename ${activeCollection.name}`}
                    accessibilityHint={`Use up to ${MAX_COLLECTION_NAME_LENGTH} characters.`}
                    value={renameDraft}
                    onChangeText={(value) => { if (!privateVisible || !repository.isCurrent() || !collectionsMountedRef.current || draftInputRevision !== draftInputRevisionRef.current || activeCollectionIdRef.current !== activeCollection.id) return; renameDraftRef.current = value; setRenameDraft(value); setCollectionNotice(null); }}
                    placeholder="Collection name"
                    placeholderTextColor={colors.muted}
                    editable={mayChangeCollections}
                    style={styles.renameInput}
                  />
                  <Pressable accessibilityRole="button" onPress={() => void renameCollection()} disabled={!mayChangeCollections || !renameDraft.trim() || renameDraft.trim() === activeCollection.name} style={({ pressed }) => [styles.renameButton, pressed && styles.pressed, (!mayChangeCollections || !renameDraft.trim() || renameDraft.trim() === activeCollection.name) && styles.disabled]}>
                    <Text style={styles.renameButtonText}>Rename</Text>
                  </Pressable>
                </View>

                {deletePending ? (
                  <View style={styles.confirmDelete} accessibilityRole="summary">
                    <Text style={styles.confirmDeleteText}>Delete “{activeCollection.name}” and its saved products from this device?</Text>
                    <View style={styles.confirmActions}>
                      <Pressable accessibilityRole="button" onPress={() => { if (canChangeCollections()) setDeletePending(false); }} disabled={!mayChangeCollections} style={styles.keepButton}><Text style={styles.keepButtonText}>Keep it</Text></Pressable>
                      <Pressable accessibilityRole="button" onPress={() => void deleteCollection()} disabled={!mayChangeCollections} style={[styles.deleteButton, !mayChangeCollections && styles.disabled]}><Text style={styles.deleteButtonText}>Delete list</Text></Pressable>
                    </View>
                  </View>
                ) : (
                  <Pressable accessibilityRole="button" onPress={() => { if (canChangeCollections()) setDeletePending(true); }} disabled={!mayChangeCollections} style={styles.deleteLink}><Text style={styles.deleteLinkText}>Delete this collection</Text></Pressable>
                )}

                {activeCollection.items.length === 0 ? (
                  <View style={styles.emptySaved}><Text style={styles.emptySavedText}>Your saved products will appear here. Search above to add one.</Text></View>
                ) : (
                  activeCollection.items.map((product) => (
                    <View key={product.id} style={styles.savedProductCard}>
                      <View style={styles.savedProductHeading}>
                        <Pressable accessibilityRole="link" accessibilityLabel={`Find and open the current retailer offer for ${product.title}`} accessibilityHint="Checks this exact saved product in your selected region before opening a retailer." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [styles.savedDot, pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}><Text style={styles.savedDotText}>✓</Text></Pressable>
                        <View style={styles.productInfo}>
                          <Text style={styles.productBrand}>{productLabel(product.brand)}</Text>
                          <Pressable accessibilityRole="link" accessibilityLabel={`Find and open the current retailer offer for ${product.title}`} accessibilityHint="Checks this exact saved product in your selected region before opening a retailer." accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null }} onPress={() => openProductAtRetailer(product)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}><Text style={styles.productName}>{product.title}</Text></Pressable>
                          <Text style={styles.productLinkHint}>Find current offers ↗</Text>
                        </View>
                        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${product.title} from ${activeCollection.name}`} onPress={() => void removeSavedProduct(product.id)} disabled={!mayChangeCollections} style={({ pressed }) => [styles.removeButton, pressed && styles.pressed, !mayChangeCollections && styles.disabled]}><Text style={styles.removeButtonText}>Remove</Text></Pressable>
                      </View>
                      <Text style={styles.savedStamp}>Saved {timestampLabel(product.savedAt)} · {product.storefront ? `from ${SHOP_STOREFRONTS[product.storefront].label}` : 'original storefront not recorded'}</Text>
                      <Text style={styles.savedPrice} accessibilityLabel={product.lastSeenPrice ? `Last seen price ${formatPrice(product.lastSeenPrice.amount, product.lastSeenPrice.currency)}, retrieved ${priceSnapshotLabel(product.lastSeenPrice.observedAt)}. Check current offers before buying.` : 'Price unavailable. Check current offers before buying.'}>
                        {product.lastSeenPrice ? `Last seen ${formatPrice(product.lastSeenPrice.amount, product.lastSeenPrice.currency)} · ${priceSnapshotLabel(product.lastSeenPrice.observedAt)}` : 'Price unavailable'}
                      </Text>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Check current ${SHOP_STOREFRONTS[storefront].label} offers for ${product.title}`} accessibilityState={{ disabled: !storefrontReady || refreshingProductId !== null, busy: refreshingProductId === product.id }} onPress={() => void refreshProductOffers(product)} disabled={!storefrontReady || refreshingProductId !== null} style={({ pressed }) => [styles.refreshOffersButton, pressed && styles.pressed, (!storefrontReady || refreshingProductId !== null) && styles.disabled]}>
                        {refreshingProductId === product.id ? <ActivityIndicator size="small" color={colors.link} /> : <Text style={styles.refreshGlyph}>↻</Text>}
                        <Text style={styles.refreshOffersText}>{refreshingProductId === product.id ? 'Checking offers…' : 'Check current price'}</Text>
                      </Pressable>
                      <VerifiedOffersCard product={product} verified={verifiedByProduct[product.id]?.repository && !verifiedByProduct[product.id].repository?.isCurrent() ? undefined : verifiedByProduct[product.id]} error={offerErrors[product.id]} refreshing={refreshingProductId === product.id} similarProducts={findSimilarInStockProducts(product, [...(similarByProduct[product.id] ?? []), ...(searchSnapshot?.products ?? []), ...(curatedCatalog?.products ?? [])])} similarVisible={Boolean(similarVisibleByProduct[product.id])} similarLoading={Boolean(similarLoadingByProduct[product.id])} similarError={similarErrorByProduct[product.id]} onFindSimilar={() => void toggleSimilarAlternatives(product, [...(searchSnapshot?.products ?? []), ...(curatedCatalog?.products ?? [])])} onOpenSimilar={(candidate) => openProductAtRetailer(candidate, storefrontFence.current.capture())} onOpen={openRetailer} />
                    </View>
                  ))
                )}
              </View>
            )}
          </View>

          <Text style={styles.disclosure}>Retailers set price, stock, shipping, and checkout. This app does not process purchases.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function VerifiedOffersCard({ product, verified, error, refreshing, similarProducts, similarVisible, similarLoading, similarError, onFindSimilar, onOpenSimilar, onOpen }: {
  product: Channel3Product | SavedProduct;
  verified: VerifiedOffers | undefined;
  error: string | undefined;
  refreshing: boolean;
  similarProducts: Channel3Product[];
  similarVisible: boolean;
  similarLoading: boolean;
  similarError: string | undefined;
  onFindSimilar: () => void;
  onOpenSimilar: (product: Channel3Product) => void;
  onOpen: (product: Channel3Product | SavedProduct, offer: Channel3Offer) => void;
}) {
  const styles = useAppearanceStyles(baseStyles);
  const reportedOffers = 'offers' in product ? product.offers : null;
  const hasInStockLink = reportedOffers?.some((offer) => offer.url && offer.availability === 'InStock') ?? false;
  if (!verified && !error && !similarVisible && hasInStockLink) return null;
  const offers = verified?.offers.filter((offer) => offer.availability === 'InStock') ?? [];
  return (
    <View style={styles.checkedOffers}>
      {error && <Text style={styles.offerError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      {verified && <><Text style={styles.checkedOffersTitle}>Channel3 offers · {SHOP_STOREFRONTS[verified.ticket.storefront].shortLabel}</Text>
      <Text style={styles.checkedOffersSubtitle}>Checked {timestampLabel(new Date(verified.verifiedAt).toISOString())} · Retailer stock can differ</Text>
      {offers.length === 0 ? <Text style={styles.noOfferText}>No offers reported in stock.</Text> : offers.map((offer, index) => (
        <View key={`${product.id}-fresh-${offer.domain}-${index}`} style={styles.checkedOfferRow}>
          <View style={styles.checkedOfferInfo}>
            <Text style={styles.offerDomain} numberOfLines={1}>Offer {index + 1} · {offerHandoffLabel(offer)}</Text>
            <Text style={styles.offerPrice}>{formatPrice(offer.price, offer.currency)} · Reported in stock</Text><Text style={styles.commission}>{commissionLabel(offer.maxCommissionRate)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open offer ${index + 1} from ${offerHandoffLabel(offer)} for ${product.title}, ${formatPrice(offer.price, offer.currency)}, reported in stock${Platform.OS === 'web' ? `. ${AFFILIATE_DISCLOSURE}` : ''}`}
            accessibilityHint={Platform.OS === 'web' ? undefined : AFFILIATE_DISCLOSURE}
            onPress={() => onOpen(product, offer)}
            disabled={refreshing}
            style={({ pressed }) => [styles.openRetailerButton, pressed && styles.pressed, refreshing && styles.disabled]}
          >
            <Text style={styles.openRetailerText}>Open ↗</Text>
          </Pressable>
        </View>
      ))}</>}
      {Boolean(reportedOffers?.length) && !hasInStockLink && !similarVisible && <Text style={styles.similarPanelCopy}>Sorry, no in-stock link is listed for this item.</Text>}
      {(verified || error || similarVisible || !hasInStockLink) && <Pressable accessibilityRole="button" accessibilityLabel={`Find similar in-stock items for ${product.title}`} accessibilityState={{ disabled: refreshing, expanded: similarVisible, busy: similarLoading }} onPress={onFindSimilar} disabled={refreshing} style={({ pressed }) => [styles.similarToggle, pressed && styles.pressed, refreshing && styles.disabled]}>
        <Text style={styles.similarToggleText}>{similarVisible ? 'Hide similar items' : reportedOffers?.length && !hasInStockLink ? 'Sold out? Find similar' : 'Find similar items'}</Text>
      </Pressable>}
      {similarVisible && <View style={styles.similarPanel}>
        <Text style={styles.similarPanelTitle}>Similar options · Channel3 stock</Text>
        <Text style={styles.similarPanelCopy}>Sorry, this item may be unavailable. Retailer stock can differ.</Text>
        {similarLoading ? <ActivityIndicator size="small" color={palette.blue} /> : similarProducts.length ? similarProducts.map((candidate) => {
          const offer = preferredRetailerOffer(candidate);
          if (!offer) return null;
          return <View key={`${product.id}-similar-${candidate.id}`} style={styles.similarRow}>
            <View style={styles.similarInfo}>
              <Text style={styles.similarName} numberOfLines={2}>{candidate.title}</Text>
              <Text style={styles.similarPrice}>{formatPrice(offer.price, offer.currency)} · Reported in stock</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Check and open ${candidate.title} at ${offerHandoffLabel(offer)}`} onPress={() => onOpenSimilar(candidate)} disabled={refreshing} style={({ pressed }) => [styles.openRetailerButton, pressed && styles.pressed, refreshing && styles.disabled]}>
              <Text style={styles.openRetailerText}>Check ↗</Text>
            </Pressable>
          </View>;
        }) : <Text style={styles.noOfferText}>{similarError ?? 'No similar in-stock items were found in the current list.'}</Text>}
      </View>}
    </View>
  );
}

const baseStyles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 34 },
  contentWide: { maxWidth: 1160 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, marginBottom: 22 },
  brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  paypalMark: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.blue },
  paypalMarkText: { color: palette.surface, fontSize: 22, fontWeight: '800', fontStyle: 'italic' },
  brandName: { color: palette.navy, fontSize: 15, fontWeight: '800', lineHeight: 18 },
  brandProduct: { color: palette.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  channelTag: { backgroundColor: palette.blueWash, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10 },
  channelTagText: { color: palette.blue, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  titleBlock: { marginBottom: 18 },
  kicker: { color: palette.blue, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  pageTitle: { color: palette.ink, fontSize: 34, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 7, maxWidth: 410 },
  storefrontCard: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 16, padding: 14, marginBottom: 14 },
  storefrontHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  storefrontTitle: { color: '#183550', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  storefrontDescription: { color: '#526B83', fontSize: 11, lineHeight: 17, marginTop: 2 },
  storefrontCurrency: { color: '#1A5FA8', backgroundColor: '#EAF3FE', overflow: 'hidden', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6, fontSize: 10, fontWeight: '800' },
  storefrontChoices: { flexDirection: 'row', gap: 8, marginTop: 12 },
  storefrontOption: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 11, borderWidth: 1, borderColor: '#DCE6F0', backgroundColor: '#F8FAFD' },
  storefrontOptionSelected: { borderColor: '#76ADE4', backgroundColor: '#EAF4FF' },
  storefrontOptionLabel: { color: '#536D87', fontSize: 13, fontWeight: '800' },
  storefrontOptionLabelSelected: { color: '#075DAF' },
  storefrontOptionCurrency: { color: '#526B83', fontSize: 11, fontWeight: '700' },
  storefrontFootnote: { color: '#526B83', fontSize: 11, lineHeight: 16, marginTop: 9 },
  storefrontNotice: { color: '#795419', backgroundColor: '#FFF7E8', overflow: 'hidden', borderRadius: 9, padding: 10, marginTop: 9, fontSize: 11, lineHeight: 16 },
  discoveryModes: { flexDirection: 'row', gap: 7, borderRadius: 15, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, padding: 4, marginBottom: 14 },
  discoveryModeOption: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: 'transparent' },
  discoveryModeSelected: { backgroundColor: palette.blueWash, borderColor: '#76ADE4' },
  discoveryModeText: { color: palette.muted, fontSize: 13, fontWeight: '800' },
  discoveryModeTextSelected: { color: palette.blue },
  privacyNotice: { backgroundColor: '#EDF5FD', borderWidth: 1, borderColor: '#DAE9F9', borderRadius: 16, padding: 13, marginBottom: 17 },
  privacyTitle: { color: '#2B5278', fontSize: 12, fontWeight: '800', marginBottom: 4 },
  privacyText: { color: '#536D87', fontSize: 11, lineHeight: 17 },
  curatedSection: { marginBottom: 17 },
  curatedBadge: { color: '#176CB9', backgroundColor: '#E5F2FF', borderRadius: 14, overflow: 'hidden', paddingVertical: 6, paddingHorizontal: 8, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  curatedChoices: { flexDirection: 'row', gap: 8, paddingVertical: 10 },
  retailerChoice: { minHeight: 48, minWidth: 110, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: '#DCE5F3', backgroundColor: '#FFFFFF' },
  curatedChoice: { width: 150, minWidth: 96, minHeight: 78, padding: 10, borderRadius: 15, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0E8F1' },
  curatedChoiceSelected: { backgroundColor: '#EDF6FF', borderColor: '#AFCFEF' },
  curatedSymbol: { color: '#6D86A0', fontSize: 16, fontWeight: '800', marginBottom: 3 },
  curatedChoiceLabel: { color: '#294965', fontSize: 14, fontWeight: '800' },
  curatedTextSelected: { color: '#176CB9' },
  curatedChoiceDescription: { color: '#526B83', fontSize: 12, lineHeight: 18, marginTop: 2 },
  searchCard: { backgroundColor: palette.surface, borderRadius: 20, padding: 17, borderWidth: 1, borderColor: palette.line, marginBottom: 17 },
  sectionTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' },
  sectionSubtitle: { color: '#74859A', fontSize: 12, lineHeight: 17, marginTop: 3 },
  searchInput: { minHeight: 48, borderWidth: 1, borderColor: palette.line, borderRadius: 13, backgroundColor: palette.ice, color: palette.ink, paddingHorizontal: 13, fontSize: 14, marginTop: 14 },
  priceFilterGroup: { borderWidth: 1, borderColor: '#E2E9F1', borderRadius: 13, backgroundColor: '#F8FAFD', padding: 12, marginTop: 10 },
  priceFilterTitle: { color: '#344E68', fontSize: 11, fontWeight: '800' },
  priceFilterFields: { flexDirection: 'row', gap: 9, marginTop: 9 },
  priceFilterField: { flex: 1, minWidth: 0 },
  priceFilterLabel: { color: '#60758B', fontSize: 10, fontWeight: '700', marginBottom: 5 },
  priceFilterInput: { minHeight: 44, borderWidth: 1, borderColor: '#DCE5EF', borderRadius: 10, backgroundColor: '#FFFFFF', color: palette.ink, paddingHorizontal: 11, fontSize: 13 },
  priceFilterHelp: { color: '#74859A', fontSize: 10, lineHeight: 15, marginTop: 8 },
  priceFilterApplied: { color: '#176CB9', fontSize: 12, lineHeight: 18, fontWeight: '800', marginTop: 4 },
  searchButton: { marginTop: 11 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  suggestion: { backgroundColor: '#F1F6FB', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 7 },
  suggestionText: { color: '#5A7189', fontSize: 10, fontWeight: '700' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.5 },
  loadingCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#E6ECF3' },
  loadingText: { color: '#62778C', fontSize: 12, fontWeight: '700' },
  errorCard: { backgroundColor: '#FFF7E8', borderRadius: 14, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: '#F3DFB9' },
  errorTitle: { color: '#725623', fontSize: 11, fontWeight: '800' },
  errorText: { color: '#806D4B', fontSize: 11, lineHeight: 16, marginTop: 4 },
  retryButton: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 48, marginTop: 4, paddingHorizontal: 4 },
  retryText: { color: '#0070E0', fontSize: 11, fontWeight: '800' },
  resultsSection: { marginBottom: 20 },
  sectionHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 11 },
  headingFlex: { flex: 1, minWidth: 0 },
  resultBadge: { color: '#2F7B63', backgroundColor: '#E4F5EE', overflow: 'hidden', borderRadius: 14, paddingVertical: 6, paddingHorizontal: 8, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  productCard: { backgroundColor: palette.surface, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: palette.line, marginBottom: 10 },
  productGrid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 10, alignItems: 'flex-start' },
  productGridItem: { width: '49%', marginBottom: 0 },
  productHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  productThumbnailLink: { width: 64, height: 64, flexShrink: 0, borderRadius: 13 },
  productGlyph: { width: 64, height: 64, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F9FC', overflow: 'hidden' },
  productImage: { width: '100%', height: '100%' },
  productGlyphText: { color: '#246DAA', fontSize: 18, fontWeight: '800' },
  productInfo: { flex: 1, minWidth: 0 },
  productBrand: { color: '#74869A', fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  productName: { color: '#1B3854', fontSize: 13, lineHeight: 18, fontWeight: '800', marginTop: 2 },
  productLinkHint: { color: '#176CB9', fontSize: 9, lineHeight: 13, marginTop: 3 },
  saveButton: { minHeight: 48, justifyContent: 'center', backgroundColor: '#EDF5FD', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  saveButtonText: { color: '#176CB9', fontSize: 10, fontWeight: '800' },
  offerSummary: { backgroundColor: '#F8FAFC', borderRadius: 13, padding: 10, marginTop: 12 },
  offerSummaryLabel: { color: '#5E7286', fontSize: 10, fontWeight: '800', marginBottom: 7 },
  offerRetailerInfo: { flex: 1, minWidth: 0 },
  offerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#E9EEF4' },
  offerDomain: { color: '#526981', fontSize: 10, fontWeight: '700', flex: 1, minWidth: 55 },
  offerPrice: { color: '#1B3854', fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  availability: { fontSize: 8, fontWeight: '800' },
  inStock: { color: '#398164' },
  outOfStock: { color: '#9B635A' },
  unknownStock: { color: '#8A7550' },
  refreshOffersButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#F1F6FB', borderRadius: 12, marginTop: 10, paddingHorizontal: 10 },
  refreshGlyph: { color: '#0070E0', fontSize: 16, fontWeight: '800' },
  refreshOffersText: { color: '#286A9E', fontSize: 10, fontWeight: '800' },
  offerError: { color: '#8A4F35', fontSize: 11, lineHeight: 16, marginTop: 8 },
  checkedOffers: { backgroundColor: '#F0F8F5', borderRadius: 13, padding: 10, marginTop: 10, borderWidth: 1, borderColor: '#D7EDE4' },
  checkedOffersTitle: { color: '#3E715F', fontSize: 10, fontWeight: '800' },
  checkedOffersSubtitle: { color: '#6E8A7F', fontSize: 9, lineHeight: 14, marginTop: 3, marginBottom: 6 },
  noOfferText: { color: '#806D4B', fontSize: 10, marginTop: 6 },
  similarToggle: { minHeight: 38, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 4, marginTop: 4 },
  similarToggleText: { color: palette.blue, fontSize: 10, fontWeight: '800' },
  similarPanel: { backgroundColor: palette.canvas, borderRadius: 10, borderWidth: 1, borderColor: palette.line, padding: 9, marginTop: 4 },
  similarPanelTitle: { color: palette.ink, fontSize: 10, fontWeight: '800' },
  similarPanelCopy: { color: palette.muted, fontSize: 9, lineHeight: 14, marginTop: 3, marginBottom: 4 },
  similarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: palette.line, paddingVertical: 7 },
  similarInfo: { flex: 1, minWidth: 0 },
  similarName: { color: palette.ink, fontSize: 10, fontWeight: '700' },
  similarPrice: { color: palette.muted, fontSize: 9, marginTop: 3 },
  commission: { fontSize: 10, color: '#175F9E', fontWeight: '800', marginTop: 4 },
  commissionLegend: { color: '#175F9E', fontSize: 10, fontWeight: '800', marginTop: 7 },
  checkedOfferRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: '#DDEDE6', paddingVertical: 7 },
  checkedOfferInfo: { flex: 1, minWidth: 0 },
  openRetailerButton: { minHeight: 48, justifyContent: 'center', backgroundColor: palette.blue, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8 },
  openRetailerText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  collectionsSection: { marginBottom: 16 },
  localBadge: { backgroundColor: '#EEF2F7', borderRadius: 14, paddingHorizontal: 8, paddingVertical: 6 },
  localBadgeText: { color: '#708196', fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  emptyCollection: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: '#E6ECF3', padding: 19, marginBottom: 11 },
  emptyCollectionGlyph: { color: '#6B88A5', fontSize: 22, marginBottom: 5 },
  emptyCollectionTitle: { color: '#24425F', fontSize: 13, fontWeight: '800' },
  emptyCollectionText: { maxWidth: 285, textAlign: 'center', color: '#75879A', fontSize: 10, lineHeight: 16, marginTop: 5 },
  collectionPills: { gap: 7, paddingVertical: 3, marginBottom: 10 },
  collectionPill: { maxWidth: 220, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 11, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DEE6EF' },
  collectionPillSelected: { backgroundColor: '#EAF4FD', borderColor: '#B7D7F3' },
  collectionPillText: { color: '#62778C', fontSize: 10, fontWeight: '700', maxWidth: 150 },
  collectionPillTextSelected: { color: '#176CB9' },
  collectionCount: { color: '#8292A5', fontSize: 9, fontWeight: '800' },
  collectionCountSelected: { color: '#176CB9' },
  collectionCreateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  collectionInput: { flex: 1, minHeight: 43, borderWidth: 1, borderColor: '#DCE5EE', borderRadius: 12, backgroundColor: '#FFFFFF', color: '#203B56', paddingHorizontal: 11, fontSize: 12 },
  createButton: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15, borderRadius: 12, backgroundColor: '#0070E0' },
  createButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  collectionNotice: { color: '#8A5A42', fontSize: 10, lineHeight: 15, marginVertical: 5 },
  savingText: { color: '#74859A', fontSize: 10, marginBottom: 6 },
  collectionCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 14, borderWidth: 1, borderColor: '#E6ECF3', marginTop: 8 },
  collectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  collectionTitle: { color: '#183550', fontSize: 15, fontWeight: '800' },
  collectionSubtitle: { color: '#7A899B', fontSize: 10, marginTop: 3 },
  collectionIcon: { color: '#66829E', fontSize: 19 },
  renameRow: { flexDirection: 'row', gap: 7 },
  renameInput: { flex: 1, minHeight: 39, borderWidth: 1, borderColor: '#E0E7EF', borderRadius: 11, backgroundColor: '#FBFCFE', color: '#334F6A', paddingHorizontal: 10, fontSize: 11 },
  renameButton: { minHeight: 39, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 11, backgroundColor: '#EDF5FD' },
  renameButtonText: { color: '#176CB9', fontSize: 10, fontWeight: '800' },
  deleteLink: { alignSelf: 'flex-start', marginTop: 8, marginBottom: 3, paddingVertical: 4 },
  deleteLinkText: { color: '#9C6258', fontSize: 10, fontWeight: '700' },
  confirmDelete: { backgroundColor: '#FFF5F2', borderRadius: 12, padding: 10, marginTop: 9 },
  confirmDeleteText: { color: '#7A4C45', fontSize: 10, lineHeight: 15 },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 9 },
  keepButton: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10, backgroundColor: '#FFFFFF' },
  keepButtonText: { color: '#6D7885', fontSize: 9, fontWeight: '800' },
  deleteButton: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10, backgroundColor: '#B74F3E' },
  deleteButtonText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  emptySaved: { padding: 13, backgroundColor: '#F8FAFC', borderRadius: 12, marginTop: 9 },
  emptySavedText: { color: '#8291A1', fontSize: 10, lineHeight: 15, textAlign: 'center' },
  savedProductCard: { paddingTop: 11, marginTop: 8, borderTopWidth: 1, borderTopColor: '#ECF0F4' },
  savedProductHeading: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  savedDot: { width: 32, height: 32, borderRadius: 11, backgroundColor: '#EAF5F0', alignItems: 'center', justifyContent: 'center' },
  savedDotText: { color: '#478369', fontSize: 13, fontWeight: '800' },
  removeButton: { padding: 7 },
  removeButtonText: { color: '#8B6C65', fontSize: 9, fontWeight: '700' },
  savedStamp: { color: '#8A99A8', fontSize: 9, marginTop: 5, marginLeft: 41 },
  savedPrice: { color: '#183550', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 5, marginLeft: 41 },
  disclosure: { color: '#8A98A7', fontSize: 10, lineHeight: 15, textAlign: 'center', paddingHorizontal: 8, marginTop: 4 },
});
