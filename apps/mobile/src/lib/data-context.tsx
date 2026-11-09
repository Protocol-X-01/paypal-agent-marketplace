import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { DEFAULT_DISPLAY_CURRENCY, isDisplayCurrency, type DisplayCurrency } from './currency';
import { commitHoldingInput, editHoldingInput, replaceHoldingInputs, type HoldingDrafts, type HoldingInputState } from './holding-input';
import { ASSETS, fetchIntradayCandles, fetchMarketCandles, fetchMarketChart, fetchMarketOverview, isMarketChart, isMarketOverview, type ChartDays, type CoinId, type IntradayCandles, type IntradayDays, type IntradayInterval, type MarketCandles, type MarketChart, type MarketOverview, type ResourceState } from './market';
import { createLatestCacheWriter, loadMarketResource, loadPreferenceWithTimeout, marketDataToPersist, reconcileCachedMarketData, reconcileMarketResponse, selectNetworkAlternative, writeMarketCacheIfNotOlder } from './market-resource';
import { createCustomerStorageFence } from './customer-storage-scope';
import { createGuardedPortfolioWriter } from './portfolio-persistence';

const CURRENCY_PREFERENCE_KEY = 'paypal-markets.mobile.display-currency.v1';
const OVERVIEW_CACHE_PREFIX = 'paypal-markets.mobile.market-overview.v2';
type StorageFence = ReturnType<typeof createCustomerStorageFence>;
const guestStorageFence = createCustomerStorageFence({ kind: 'guest' });

/** Immutable destinations: an issued native operation cannot be recalled on logout. */
function createPortfolioStorage(fence: StorageFence) {
  const secure = fence.capture('portfolioSecure');
  const legacy = fence.capture('legacyPortfolio');
  let mounted = true;
  const current = () => mounted && fence.isCurrent(secure);
  const check = () => { if (!current()) throw new Error('Portfolio identity changed.'); };
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    check();
    const result = await operation();
    check();
    return result;
  }
  return {
    current, activate: () => { mounted = true; }, deactivate: () => { mounted = false; },
    available: () => run(() => SecureStore.isAvailableAsync()),
    readSecure: () => run(() => SecureStore.getItemAsync(secure!.key)),
    writeSecure: (value: string) => run(() => SecureStore.setItemAsync(secure!.key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })),
    deleteSecure: () => run(() => SecureStore.deleteItemAsync(secure!.key)),
    readLegacy: () => run(() => legacy ? AsyncStorage.getItem(legacy.key) : Promise.resolve(null)),
    writeLegacy: (value: string) => run(() => {
      if (!legacy) throw new Error('Owner portfolio requires native secure storage.');
      return AsyncStorage.setItem(legacy.key, value);
    }),
    deleteLegacy: () => run(() => legacy ? AsyncStorage.removeItem(legacy.key) : Promise.resolve()),
    isGuest: !!legacy,
  };
}
type PortfolioStorage = ReturnType<typeof createPortfolioStorage>;
const MAX_MARKET_CACHE_CHARACTERS = 2 * 1024 * 1024;
const CURRENCY_LOAD_TIMEOUT_MS = 1_500;
const saveMarketCache = createLatestCacheWriter(saveNewerMarketCache);
const OLDER_MARKET_MESSAGE = 'A saved or previous view has a newer retrieval time. Device or service clocks may differ. You can show the latest response instead.';
const OLDER_CHART_MESSAGE = 'A saved or previous chart has a newer retrieval time. Device or service clocks may differ. You can show the latest response instead.';

type PortfolioStatus = 'loading' | 'saved' | 'saved-web' | 'saving' | 'recovery' | 'corrupt' | 'storage-unavailable' | 'save-unverified' | 'save-conflict';
type CurrencyStatus = 'loading' | 'default' | 'saving' | 'saved' | 'invalid' | 'unavailable';

type PortfolioSnapshotCopy =
  | { state: 'missing'; raw: null }
  | { state: 'unreadable'; raw: string }
  | { state: 'readable'; raw: string; holdings: Partial<Record<CoinId, string>> };

type PortfolioCopy = PortfolioSnapshotCopy | { state: 'unavailable' };

export interface PortfolioRecovery {
  secure: PortfolioCopy;
  legacy: PortfolioSnapshotCopy;
}

type PortfolioLoadResult = {
  status: 'saved' | 'saved-web' | 'recovery' | 'corrupt' | 'storage-unavailable';
  holdings?: Partial<Record<CoinId, string>>;
  recovery?: PortfolioRecovery;
  verifiedRaw?: string | null;
};

interface DataContextValue {
  overview: ResourceState<MarketOverview>;
  refreshOverview: () => void;
  showLatestOverviewResponse: () => void;
  currency: DisplayCurrency;
  currencyReady: boolean;
  currencyStatus: CurrencyStatus;
  setCurrency: (currency: DisplayCurrency) => void;
  holdings: Partial<Record<CoinId, string>>;
  holdingDrafts: HoldingDrafts;
  setHolding: (coinId: CoinId, value: string) => void;
  commitHolding: (coinId: CoinId) => boolean;
  commitAllHoldings: () => void;
  retryPortfolioSave: () => Promise<boolean>;
  loadSavedPortfolio: () => Promise<boolean>;
  forgetHoldings: () => Promise<boolean>;
  portfolioRecovery: PortfolioRecovery | null;
  resolvePortfolioRecovery: (source: 'secure' | 'legacy') => Promise<boolean>;
  portfolioReady: boolean;
  portfolioStatus: PortfolioStatus;
}

export interface ChartResourceState extends ResourceState<MarketChart> {
  retry: () => void;
  showLatestResponse: () => void;
}

const DataContext = createContext<DataContextValue | null>(null);

function parseCached<T>(value: string | null, isValid: (candidate: unknown) => candidate is T): T | null {
  if (!value || value.length > MAX_MARKET_CACHE_CHARACTERS) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMarketCacheForKey(key: string, raw: string | null): MarketOverview | MarketChart | null {
  const overview = parseCached(raw, isMarketOverview);
  if (overview && key === `${OVERVIEW_CACHE_PREFIX}.${overview.currency}`) return overview;
  const chart = parseCached(raw, isMarketChart);
  if (chart && key === `paypal-markets.mobile.chart.${chart.currency}.${chart.coinId}.${chart.days}.v2`) return chart;
  return null;
}

async function saveNewerMarketCache(key: string, value: string): Promise<void> {
  const incoming = parseMarketCacheForKey(key, value);
  if (!incoming) return;
  await writeMarketCacheIfNotOlder(
    incoming,
    async () => parseMarketCacheForKey(key, await AsyncStorage.getItem(key)),
    () => AsyncStorage.setItem(key, value),
  );
}

function isHoldings(value: unknown): value is Partial<Record<CoinId, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const allowedIds = new Set(ASSETS.map((asset) => asset.id));
  return Object.entries(value).every(([key, amount]) =>
    allowedIds.has(key as CoinId) &&
    typeof amount === 'string' &&
    amount.length <= 32 &&
    /^\d*(?:\.\d{0,10})?$/.test(amount),
  );
}

function parseHoldings(raw: string | null): Partial<Record<CoinId, string>> | null {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHoldings(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function describeCopy(raw: string | null): PortfolioSnapshotCopy {
  if (raw === null) return { state: 'missing', raw: null };
  const holdings = parseHoldings(raw);
  return holdings === null ? { state: 'unreadable', raw } : { state: 'readable', raw, holdings };
}

function makeRecovery(secureRaw: string | null, legacyRaw: string | null): PortfolioRecovery {
  return {
    secure: describeCopy(secureRaw),
    legacy: describeCopy(legacyRaw),
  };
}

function readableHoldings(copy: PortfolioCopy): Partial<Record<CoinId, string>> | null {
  return copy.state === 'readable' ? copy.holdings : null;
}

async function loadPortfolio(io: PortfolioStorage): Promise<PortfolioLoadResult> {
  try {
    const legacyRaw = await io.readLegacy();
    if (Platform.OS === 'web') {
      if (!io.isGuest) return { status: 'storage-unavailable' };
      const legacyHoldings = parseHoldings(legacyRaw);
      return legacyHoldings === null
        ? { status: 'corrupt' }
        : { status: 'saved-web', holdings: legacyHoldings, verifiedRaw: legacyRaw };
    }

    if (!(await io.available())) {
      const legacyHoldings = parseHoldings(legacyRaw);
      if (legacyRaw === null) return { status: 'storage-unavailable' };
      if (legacyHoldings === null) return { status: 'corrupt' };
      return {
        status: 'recovery',
        holdings: legacyHoldings,
        recovery: { secure: { state: 'unavailable' }, legacy: { state: 'readable', raw: legacyRaw, holdings: legacyHoldings } },
      };
    }

    const secureRaw = await io.readSecure();
    if (secureRaw !== null) {
      const secureHoldings = parseHoldings(secureRaw);
      if (secureHoldings === null) {
        const legacyHoldings = parseHoldings(legacyRaw);
        return legacyHoldings === null
          ? { status: 'corrupt' }
          : {
            status: 'recovery',
            holdings: legacyHoldings,
            recovery: makeRecovery(secureRaw, legacyRaw),
          };
      }

      if (legacyRaw !== null) {
        // Keep every duplicate or divergent legacy snapshot until the user
        // confirms which one to retain. AsyncStorage has no compare-and-delete.
        return {
          status: 'recovery',
          holdings: secureHoldings,
          recovery: makeRecovery(secureRaw, legacyRaw),
        };
      }

      return { status: 'saved', holdings: secureHoldings, verifiedRaw: secureRaw };
    }

    const legacyHoldings = parseHoldings(legacyRaw);
    if (legacyHoldings === null) return { status: 'corrupt' };
    if (legacyRaw === null) return { status: 'saved', holdings: {}, verifiedRaw: null };

    const encoded = JSON.stringify(legacyHoldings);
    let saved: string | null;
    try {
      await io.writeSecure(encoded);
      saved = await io.readSecure();
    } catch {
      const currentSecure = await io.readSecure();
      return {
        status: 'recovery',
        holdings: legacyHoldings,
        recovery: makeRecovery(currentSecure, legacyRaw),
      };
    }
    const verified = parseHoldings(saved);
    if (saved !== encoded || verified === null || JSON.stringify(verified) !== JSON.stringify(legacyHoldings)) {
      return {
        status: 'recovery',
        holdings: legacyHoldings,
        recovery: makeRecovery(saved, legacyRaw),
      };
    }

    // Migration is verified, but leave the plaintext older copy in place until
    // the user confirms the encrypted copy in the recovery panel.
    return {
      status: 'recovery',
      holdings: verified,
      recovery: makeRecovery(saved, legacyRaw),
    };
  } catch {
    return { status: 'storage-unavailable' };
  }
}

async function savePortfolio(io: PortfolioStorage, holdings: Partial<Record<CoinId, string>>): Promise<Extract<PortfolioStatus, 'saved' | 'saved-web'>> {
  const encoded = JSON.stringify(holdings);
  if (Platform.OS === 'web') {
    await io.writeLegacy(encoded);
    if (await io.readLegacy() !== encoded) throw new Error('Portfolio save could not be verified.');
    return 'saved-web';
  }

  if (!(await io.available())) throw new Error('Secure storage is unavailable.');
  await io.writeSecure(encoded);
  if (await io.readSecure() !== encoded) throw new Error('Secure portfolio save could not be verified.');
  return 'saved';
}

async function readPortfolioRaw(io: PortfolioStorage): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (!io.isGuest) throw new Error('Owner portfolio requires native secure storage.');
    return io.readLegacy();
  }
  if (!(await io.available())) throw new Error('Secure storage is unavailable.');
  return io.readSecure();
}

export function DataProvider({ children, storageFence = guestStorageFence, storageRevision = 0 }: React.PropsWithChildren<{ storageFence?: StorageFence; storageRevision?: number }>) {
  const io = useMemo(() => ({ ...createPortfolioStorage(storageFence), revision: storageRevision }), [storageFence, storageRevision]);
  const [hydratedStorage, setHydratedStorage] = useState<PortfolioStorage | null>(null);
  const privateVisible = hydratedStorage === io && io.current();
  const writer = useMemo(() => createGuardedPortfolioWriter(
    () => readPortfolioRaw(io),
    async (snapshot) => { await savePortfolio(io, JSON.parse(snapshot) as Partial<Record<CoinId, string>>); },
  ), [io]);
  const [currency, setCurrencyState] = useState<DisplayCurrency>(DEFAULT_DISPLAY_CURRENCY);
  const [currencyReady, setCurrencyReady] = useState(false);
  const [currencyStatus, setCurrencyStatus] = useState<CurrencyStatus>('loading');
  const [storedOverview, setStoredOverview] = useState<{ key: DisplayCurrency; value: ResourceState<MarketOverview> }>({
    key: DEFAULT_DISPLAY_CURRENCY,
    value: { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null },
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [holdings, setHoldings] = useState<Partial<Record<CoinId, string>>>({});
  const [holdingDrafts, setHoldingDrafts] = useState<HoldingDrafts>({});
  const holdingInputs = useRef<HoldingInputState>(replaceHoldingInputs({}));
  const [portfolioReady, setPortfolioReady] = useState(false);
  const [portfolioStatus, setPortfolioStatus] = useState<PortfolioStatus>('loading');
  const [portfolioRecovery, setPortfolioRecovery] = useState<PortfolioRecovery | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const portfolioRevision = useRef(0);
  const portfolioRetrying = useRef(false);
  const firstPortfolioSave = useRef(true);
  const currencySaveQueue = useRef<Promise<void>>(Promise.resolve());
  const currencyRevision = useRef(0);
  const currencyMounted = useRef(false);
  const currencySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const replaceAllHoldings = useCallback((next: Partial<Record<CoinId, string>>) => {
    const inputs = replaceHoldingInputs(next);
    holdingInputs.current = inputs;
    setHoldings(inputs.holdings);
    setHoldingDrafts(inputs.drafts);
  }, []);

  const overview = currencyReady && storedOverview.key === currency
    ? storedOverview.value
    : { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null };

  useEffect(() => {
    currencyMounted.current = true;
    const cancel = loadPreferenceWithTimeout(
      () => AsyncStorage.getItem(CURRENCY_PREFERENCE_KEY),
      (stored) => {
        if (stored === null) setCurrencyStatus('default');
        else if (isDisplayCurrency(stored)) {
          setCurrencyState(stored);
          setCurrencyStatus('saved');
        } else setCurrencyStatus('invalid');
        setCurrencyReady(true);
      },
      () => {
        setCurrencyStatus('unavailable');
        setCurrencyReady(true);
      },
      CURRENCY_LOAD_TIMEOUT_MS,
    );
    return () => {
      cancel();
      currencyMounted.current = false;
      if (currencySaveTimer.current !== null) clearTimeout(currencySaveTimer.current);
    };
  }, []);

  const setCurrency = useCallback((next: DisplayCurrency) => {
    if (!currencyReady || !isDisplayCurrency(next)) return;
    setCurrencyState(next);
    setCurrencyStatus('saving');
    const revision = ++currencyRevision.current;
    if (currencySaveTimer.current !== null) clearTimeout(currencySaveTimer.current);
    currencySaveTimer.current = setTimeout(() => {
      if (currencyMounted.current && revision === currencyRevision.current) setCurrencyStatus('unavailable');
    }, CURRENCY_LOAD_TIMEOUT_MS);
    const finish = (status: 'saved' | 'unavailable') => {
      if (!currencyMounted.current || revision !== currencyRevision.current) return;
      if (currencySaveTimer.current !== null) clearTimeout(currencySaveTimer.current);
      currencySaveTimer.current = null;
      setCurrencyStatus(status);
    };
    currencySaveQueue.current = currencySaveQueue.current.catch(() => undefined).then(async () => {
      await AsyncStorage.setItem(CURRENCY_PREFERENCE_KEY, next);
      if (await AsyncStorage.getItem(CURRENCY_PREFERENCE_KEY) !== next) throw new Error('Currency preference could not be verified.');
    }).then(() => finish('saved')).catch(() => finish('unavailable'));
  }, [currencyReady]);

  const refreshOverview = useCallback(() => {
    setStoredOverview((current) => current.key === currency
      ? { key: currency, value: { ...current.value, loading: true, error: null, cacheReady: false, networkAlternative: null, networkSelected: false } }
      : current);
    setRefreshKey((value) => value + 1);
  }, [currency]);

  const showLatestOverviewResponse = useCallback(() => {
    setStoredOverview((current) => current.key === currency
      ? { key: currency, value: selectNetworkAlternative(current.value) }
      : current);
  }, [currency]);

  useEffect(() => {
    if (!currencyReady) return;
    const controller = new AbortController();
    const cacheKey = `${OVERVIEW_CACHE_PREFIX}.${currency}`;
    const cancel = loadMarketResource({
      readCache: async () => {
        const cached = parseCached(await AsyncStorage.getItem(cacheKey), isMarketOverview);
        return cached?.currency === currency ? cached : null;
      },
      fetchFresh: () => fetchMarketOverview(currency, controller.signal),
      onCache: (cached, loading, error, fresh) => setStoredOverview((current) => {
        const previous = current.key === currency ? current.value : { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null };
        return { key: currency, value: reconcileCachedMarketData(previous, cached, loading, error, fresh, OLDER_MARKET_MESSAGE, 'Market data is temporarily unavailable.') };
      }),
      onFresh: (fresh) => {
        setStoredOverview((current) => {
          const previous = current.key === currency ? current.value : null;
          return { key: currency, value: reconcileMarketResponse(previous?.data ?? null, fresh, OLDER_MARKET_MESSAGE, previous?.cacheReady === true) };
        });
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Market data is temporarily unavailable.';
        setStoredOverview((current) => current.key === currency
          ? { key: currency, value: { ...current.value, loading: false, stale: Boolean(current.value.data), error: message, networkAlternative: null } }
          : { key: currency, value: { data: null, loading: false, stale: false, error: message, cacheReady: false, networkAlternative: null } });
      },
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [currency, currencyReady, refreshKey]);

  useEffect(() => {
    const { key, value } = storedOverview;
    const data = marketDataToPersist(value);
    if (currencyReady && key === currency && data) {
      saveMarketCache(`${OVERVIEW_CACHE_PREFIX}.${key}`, JSON.stringify(data));
    }
  }, [currency, currencyReady, storedOverview]);

  useEffect(() => {
    let active = true;
    io.activate();
    portfolioRevision.current += 1;
    portfolioRetrying.current = false;
    firstPortfolioSave.current = true;
    // The render mask hides previous private state until this adapter hydrates.
    void loadPortfolio(io).then((result) => {
      if (!active || !io.current()) return;
      setHydratedStorage(io);
      if (result.status === 'saved' || result.status === 'saved-web') writer.reset(result.verifiedRaw ?? null);
      replaceAllHoldings(result.holdings ?? {});
      setPortfolioStatus(result.status);
      setPortfolioRecovery(result.recovery ?? null);
      setPortfolioReady(result.status === 'saved' || result.status === 'saved-web');
    });
    return () => {
      active = false;
      io.deactivate();
    };
  }, [io, writer, replaceAllHoldings]);

  useEffect(() => {
    if (!privateVisible || !io.current() || !portfolioReady) return;
    if (firstPortfolioSave.current) {
      firstPortfolioSave.current = false;
      return;
    }
    let active = true;
    const snapshot = JSON.stringify(holdings);
    const revision = portfolioRevision.current;
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (!io.current()) return;
        const result = await writer.save(snapshot);
        if (!active || !io.current() || revision !== portfolioRevision.current) return;
        if (result === 'saved') setPortfolioStatus(Platform.OS === 'web' ? 'saved-web' : 'saved');
        else {
          setPortfolioReady(false);
          setPortfolioStatus(result === 'conflict' ? 'save-conflict' : 'save-unverified');
        }
      });
    return () => {
      active = false;
    };
  }, [holdings, portfolioReady, privateVisible, io, writer]);

  const setHolding = useCallback((coinId: CoinId, value: string) => {
    if (!privateVisible || !io.current() || !portfolioReady) return;
    const inputs = editHoldingInput(holdingInputs.current, coinId, value);
    holdingInputs.current = inputs;
    setHoldingDrafts(inputs.drafts);
  }, [portfolioReady, privateVisible, io]);

  const commitHolding = useCallback((coinId: CoinId): boolean => {
    if (!privateVisible || !io.current() || !portfolioReady) return false;
    const result = commitHoldingInput(holdingInputs.current, coinId);
    if (!result.accepted) return false;
    holdingInputs.current = result.state;
    if (result.changed) {
      portfolioRevision.current += 1;
      setPortfolioStatus('saving');
      setHoldings(result.state.holdings);
    }
    return true;
  }, [portfolioReady, privateVisible, io]);

  const commitAllHoldings = useCallback(() => {
    for (const asset of ASSETS) commitHolding(asset.id);
  }, [commitHolding]);

  const retryPortfolioSave = useCallback(async () => {
    if (!privateVisible || !io.current() || portfolioRetrying.current || (portfolioStatus !== 'save-unverified' && portfolioStatus !== 'save-conflict')) return false;
    portfolioRetrying.current = true;
    const revision = ++portfolioRevision.current;
    setPortfolioStatus('saving');
    const snapshot = JSON.stringify(holdingInputs.current.holdings);
    const attempt = saveQueue.current.catch(() => undefined).then(() => writer.retry(snapshot));
    saveQueue.current = attempt.then(() => undefined, () => undefined);
    const result = await attempt;
    if (!io.current()) return false;
    portfolioRetrying.current = false;
    if (!io.current() || revision !== portfolioRevision.current) return false;
    if (result !== 'saved') {
      setPortfolioStatus(result === 'conflict' ? 'save-conflict' : 'save-unverified');
      return false;
    }
    firstPortfolioSave.current = true;
    setPortfolioStatus(Platform.OS === 'web' ? 'saved-web' : 'saved');
    setPortfolioReady(true);
    return true;
  }, [portfolioStatus, privateVisible, io, writer]);

  const loadSavedPortfolio = useCallback(async () => {
    if (!privateVisible || !io.current() || portfolioRetrying.current || portfolioStatus !== 'save-conflict') return false;
    portfolioRetrying.current = true;
    const revision = ++portfolioRevision.current;
    setPortfolioStatus('saving');
    try {
      await saveQueue.current.catch(() => undefined);
      const raw = await readPortfolioRaw(io);
      const saved = parseHoldings(raw);
      if (saved === null) throw new Error('Saved quantities could not be read.');
      if (!io.current() || revision !== portfolioRevision.current) return false;
      writer.reset(raw);
      replaceAllHoldings(saved);
      firstPortfolioSave.current = true;
      setPortfolioStatus(Platform.OS === 'web' ? 'saved-web' : 'saved');
      setPortfolioReady(true);
      return true;
    } catch {
      if (io.current() && revision === portfolioRevision.current) setPortfolioStatus('save-conflict');
      return false;
    } finally {
      if (io.current()) portfolioRetrying.current = false;
    }
  }, [portfolioStatus, replaceAllHoldings, privateVisible, io, writer]);

  const resolvePortfolioRecovery = useCallback(async (source: 'secure' | 'legacy') => {
    if (!privateVisible || !io.current()) return false;
    const recovery = portfolioRecovery;
    const selectedCopy = recovery?.[source];
    const selectedHoldings = selectedCopy ? readableHoldings(selectedCopy) : null;
    if (!recovery || !selectedHoldings || recovery.secure.state === 'unavailable') return false;

    portfolioRevision.current += 1;
    setPortfolioReady(false);
    setPortfolioStatus('saving');
    try {
      await saveQueue.current.catch(() => undefined);
      if (!(await io.available())) throw new Error('Secure storage is unavailable.');

      const encoded = JSON.stringify(selectedHoldings);
      const currentSecure = await io.readSecure();
      if (source === 'secure') {
        const currentHoldings = parseHoldings(currentSecure);
        if (currentSecure !== recovery.secure.raw || currentSecure === null || currentHoldings === null || JSON.stringify(currentHoldings) !== encoded) {
          throw new Error('The secure copy changed. Reload the app before choosing a copy.');
        }
      } else {
        const currentLegacy = await io.readLegacy();
        const currentHoldings = parseHoldings(currentLegacy);
        if (
          currentLegacy !== recovery.legacy.raw ||
          currentLegacy === null ||
          currentHoldings === null ||
          JSON.stringify(currentHoldings) !== encoded ||
          currentSecure !== recovery.secure.raw
        ) {
          throw new Error('The older copy changed. Reload the app before choosing a copy.');
        }
        await io.writeSecure(encoded);
      }

      const verified = await io.readSecure();
      const verifiedHoldings = parseHoldings(verified);
      if (verified !== encoded || verifiedHoldings === null || JSON.stringify(verifiedHoldings) !== encoded) {
        throw new Error('The chosen copy could not be verified in secure storage.');
      }

      const latestLegacy = await io.readLegacy();
      if (latestLegacy !== recovery.legacy.raw) {
        throw new Error('The older copy changed. Reload the app before choosing a copy.');
      }
      if (latestLegacy !== null) {
        await io.deleteLegacy();
        if (await io.readLegacy() !== null) {
          throw new Error('The older browser copy remains stored.');
        }
      }

      if (!io.current()) return false;
      replaceAllHoldings(selectedHoldings);
      writer.reset(verified);
      setPortfolioRecovery(null);
      setPortfolioStatus('saved');
      setPortfolioReady(true);
      firstPortfolioSave.current = true;
      return true;
    } catch {
      if (!io.current()) return false;
      try {
        const [secureAvailable, legacyRaw] = await Promise.all([
          io.available(),
          io.readLegacy(),
        ]);
        if (!io.current()) return false;
        if (!secureAvailable) {
          const legacy = describeCopy(legacyRaw);
          const refreshedRecovery: PortfolioRecovery = { secure: { state: 'unavailable' }, legacy };
          setPortfolioRecovery(refreshedRecovery);
          const legacyHoldings = readableHoldings(legacy);
          if (legacyHoldings) replaceAllHoldings(legacyHoldings);
        } else {
          const secureRaw = await io.readSecure();
          if (!io.current()) return false;
          const refreshedRecovery = makeRecovery(secureRaw, legacyRaw);
          const secureHoldings = readableHoldings(refreshedRecovery.secure);
          setPortfolioRecovery(refreshedRecovery);
          if (secureHoldings) replaceAllHoldings(secureHoldings);
        }
        setPortfolioStatus('recovery');
      } catch {
        if (!io.current()) return false;
        setPortfolioStatus('recovery');
      }
      return false;
    }
  }, [portfolioRecovery, replaceAllHoldings, privateVisible, io, writer]);

  const forgetHoldings = useCallback(async () => {
    if (!privateVisible || !io.current()) return false;
    portfolioRevision.current += 1;
    setPortfolioReady(false);
    setPortfolioStatus('saving');
    try {
      await saveQueue.current.catch(() => undefined);
      if (Platform.OS === 'web') {
        if (!io.isGuest) throw new Error('Owner portfolio requires native secure storage.');
        await io.deleteLegacy();
        if (await io.readLegacy() !== null) throw new Error('Browser portfolio data remains stored.');
      } else {
        if (!(await io.available())) throw new Error('Secure storage is unavailable.');
        await io.deleteSecure();
        await io.deleteLegacy();
        const [secureRaw, legacyRaw] = await Promise.all([
          io.readSecure(),
          io.readLegacy(),
        ]);
        if (secureRaw !== null || legacyRaw !== null) throw new Error('Portfolio data remains stored.');
      }
      if (!io.current()) return false;
      firstPortfolioSave.current = true;
      writer.reset(null);
      replaceAllHoldings({});
      setPortfolioRecovery(null);
      setPortfolioStatus(Platform.OS === 'web' ? 'saved-web' : 'saved');
      setPortfolioReady(true);
      return true;
    } catch {
      if (!io.current()) return false;
      if (Platform.OS === 'web') {
        setPortfolioStatus('storage-unavailable');
        return false;
      }
      try {
        const [secureAvailable, legacyRaw] = await Promise.all([
          io.available(),
          io.readLegacy(),
        ]);
        const secureRaw = secureAvailable ? await io.readSecure() : null;
        if (!io.current()) return false;
        const refreshedRecovery: PortfolioRecovery = secureAvailable
          ? makeRecovery(secureRaw, legacyRaw)
          : { secure: { state: 'unavailable' }, legacy: describeCopy(legacyRaw) };
        setPortfolioRecovery(refreshedRecovery);
        const visibleHoldings = readableHoldings(refreshedRecovery.secure) ?? readableHoldings(refreshedRecovery.legacy);
        if (visibleHoldings) replaceAllHoldings(visibleHoldings);
        setPortfolioStatus('recovery');
      } catch {
        if (!io.current()) return false;
        setPortfolioStatus(portfolioRecovery ? 'recovery' : 'storage-unavailable');
      }
      return false;
    }
  }, [portfolioRecovery, replaceAllHoldings, privateVisible, io, writer]);

  return (
    <DataContext.Provider value={{ overview, refreshOverview, showLatestOverviewResponse, currency, currencyReady, currencyStatus, setCurrency, holdings: privateVisible ? holdings : {}, holdingDrafts: privateVisible ? holdingDrafts : {}, setHolding, commitHolding, commitAllHoldings, retryPortfolioSave, loadSavedPortfolio, forgetHoldings, portfolioRecovery: privateVisible ? portfolioRecovery : null, resolvePortfolioRecovery, portfolioReady: privateVisible && portfolioReady, portfolioStatus: privateVisible ? portfolioStatus : 'loading' }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData(): DataContextValue {
  const context = useContext(DataContext);
  if (!context) throw new Error('useData must be used within DataProvider');
  return context;
}

export function useMarketChart(coinId: CoinId, days: ChartDays, currency: DisplayCurrency = DEFAULT_DISPLAY_CURRENCY, enabled = true): ChartResourceState {
  const [retryKey, setRetryKey] = useState(0);
  const requestKey = `${currency}:${coinId}:${days}`;
  const [storedState, setStoredState] = useState<{ key: string; value: ResourceState<MarketChart> }>({
    key: `${DEFAULT_DISPLAY_CURRENCY}:bitcoin:7`,
    value: { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null },
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const cacheKey = `paypal-markets.mobile.chart.${currency}.${coinId}.${days}.v2`;
    const cancel = loadMarketResource({
      readCache: async () => {
        const cached = parseCached(await AsyncStorage.getItem(cacheKey), isMarketChart);
        return cached?.coinId === coinId && cached.days === days && cached.currency === currency ? cached : null;
      },
      fetchFresh: () => fetchMarketChart(coinId, days, currency, controller.signal),
      onCache: (cached, loading, error, fresh) => setStoredState((current) => {
        const previous = current.key === requestKey ? current.value : { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null };
        return { key: requestKey, value: reconcileCachedMarketData(previous, cached, loading, error, fresh, OLDER_CHART_MESSAGE, 'This chart is temporarily unavailable.') };
      }),
      onFresh: (fresh) => {
        setStoredState((current) => {
          const previous = current.key === requestKey ? current.value : null;
          return { key: requestKey, value: reconcileMarketResponse(previous?.data ?? null, fresh, OLDER_CHART_MESSAGE, previous?.cacheReady === true) };
        });
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'This chart is temporarily unavailable.';
        setStoredState((current) => current.key === requestKey
          ? { key: requestKey, value: { ...current.value, loading: false, stale: Boolean(current.value.data), error: message, networkAlternative: null } }
          : { key: requestKey, value: { data: null, loading: false, stale: false, error: message, cacheReady: false, networkAlternative: null } });
      },
    });
    return () => {
      cancel();
      controller.abort();
    };
  }, [coinId, currency, days, enabled, requestKey, retryKey]);

  useEffect(() => {
    const { key, value } = storedState;
    const data = marketDataToPersist(value);
    if (enabled && key === requestKey && data) {
      saveMarketCache(`paypal-markets.mobile.chart.${currency}.${coinId}.${days}.v2`, JSON.stringify(data));
    }
  }, [coinId, currency, days, enabled, requestKey, storedState]);

  const value = enabled && storedState.key === requestKey
    ? storedState.value
    : { data: null, loading: true, stale: false, error: null, cacheReady: false, networkAlternative: null };
  const retry = useCallback(() => {
    setStoredState((current) => current.key === requestKey
      ? { key: requestKey, value: { ...current.value, loading: true, error: null, cacheReady: false, networkAlternative: null, networkSelected: false } }
      : current);
    setRetryKey((current) => current + 1);
  }, [requestKey]);

  const showLatestResponse = useCallback(() => {
    setStoredState((current) => current.key === requestKey
      ? { key: requestKey, value: selectNetworkAlternative(current.value) }
      : current);
  }, [requestKey]);

  return { ...value, retry, showLatestResponse };
}

/** Candle snapshots are kept in memory only; changing the key hides old data immediately. */
export function useMarketCandles(coinId: CoinId, days: ChartDays, currency: DisplayCurrency, enabled: boolean) {
  const [retryKey, setRetryKey] = useState(0);
  const requestKey = `${currency}:${coinId}:${days}:${retryKey}`;
  const [settled, setSettled] = useState<{ key: string; data: MarketCandles | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    fetchMarketCandles(coinId, days, currency, controller.signal).then(
      (data) => { if (active) setSettled({ key: requestKey, data, error: null }); },
      (error: unknown) => { if (active) setSettled({ key: requestKey, data: null, error: error instanceof Error ? error.message : 'Candlestick data is temporarily unavailable.' }); },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [coinId, currency, days, enabled, requestKey]);

  const current = enabled && settled?.key === requestKey ? settled : null;
  const retry = useCallback(() => setRetryKey((previous) => previous + 1), []);
  return { data: current?.data ?? null, error: current?.error ?? null, loading: enabled && !current, requestKey, retry };
}

/** Source, asset, interval and window are fenced independently of fiat preferences. */
export function useIntradayCandles(coinId: CoinId, interval: IntradayInterval | null, days: IntradayDays, enabled: boolean) {
  const [retryKey, setRetryKey] = useState(0);
  const requestKey = `binance:USDT:${coinId}:${interval ?? 'off'}:${days}:${retryKey}`;
  const [settled, setSettled] = useState<{ key: string; data: IntradayCandles | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !interval) return;
    const controller = new AbortController();
    let active = true;
    fetchIntradayCandles(coinId, interval, days, controller.signal).then(
      (data) => { if (active) setSettled({ key: requestKey, data, error: null }); },
      (error: unknown) => { if (active) setSettled({ key: requestKey, data: null, error: error instanceof Error ? error.message : 'Intraday candles are temporarily unavailable.' }); },
    );
    return () => { active = false; controller.abort(); };
  }, [coinId, days, enabled, interval, requestKey]);

  const current = enabled && interval && settled?.key === requestKey ? settled : null;
  const retry = useCallback(() => setRetryKey((previous) => previous + 1), []);
  return { data: current?.data ?? null, error: current?.error ?? null, loading: Boolean(enabled && interval && !current), requestKey, retry };
}
