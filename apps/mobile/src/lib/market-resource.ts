/**
 * Start the network request without waiting for optional device storage.
 * A late cache read is still compared with the network response.
 */
export function loadMarketResource<T>(options: {
  readCache: () => Promise<T | null>;
  fetchFresh: () => Promise<T>;
  onCache: (value: T | null, loading: boolean, error: unknown | null, fresh: T | null) => void;
  onFresh: (value: T) => void;
  onError: (error: unknown) => void;
}): () => void {
  let active = true;
  let network: 'pending' | 'success' | 'error' = 'pending';
  let networkError: unknown = null;
  let latestResponse: T | null = null;

  void Promise.resolve().then(options.readCache).then((cached) => {
    if (active) options.onCache(cached, network === 'pending', networkError, latestResponse);
  }).catch(() => {
    // Cache storage is optional; the live request runs independently.
  });

  void Promise.resolve().then(options.fetchFresh).then((fresh) => {
    if (!active) return;
    network = 'success';
    latestResponse = fresh;
    options.onFresh(fresh);
  }).catch((error: unknown) => {
    if (!active || network === 'success') return;
    network = 'error';
    networkError = error;
    options.onError(error);
  });

  return () => { active = false; };
}

/** A later response can come from an older server or intermediary cache. */
export function isOlderMarketData<T extends { retrievedAt: string }>(current: T | null, incoming: T): boolean {
  if (current === null) return false;
  const currentTime = Date.parse(current.retrievedAt);
  const incomingTime = Date.parse(incoming.retrievedAt);
  return Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime < currentTime;
}

export function reconcileMarketResponse<T extends { retrievedAt: string }>(current: T | null, incoming: T, olderMessage: string, cacheReady = false) {
  if (current !== null) {
    const currentTime = Date.parse(current.retrievedAt);
    const incomingTime = Date.parse(incoming.retrievedAt);
    if (Number.isFinite(currentTime) && Number.isFinite(incomingTime)) {
      if (incomingTime < currentTime) {
        return { data: current, loading: false, stale: true, error: olderMessage, cacheReady, networkAlternative: incoming, networkSelected: false };
      }
      if (incomingTime === currentTime) {
        return {
          data: current,
          loading: false,
          stale: true,
          error: 'The service returned no newer retrieval timestamp. It may be serving cached data; check the provider update and chart sample times.',
          cacheReady,
          networkAlternative: null,
          networkSelected: false,
        };
      }
    }
  }
  return { data: incoming, loading: false, stale: false, error: null, cacheReady, networkAlternative: null, networkSelected: false };
}

/** Reconcile a cache read even when the network finished first. */
export function reconcileCachedMarketData<T extends { retrievedAt: string }>(
  current: { data: T | null; loading: boolean; stale: boolean; error: string | null; cacheReady?: boolean; networkAlternative?: T | null; networkSelected?: boolean },
  cached: T | null,
  loading: boolean,
  error: unknown | null,
  fresh: T | null,
  olderMessage: string,
  unavailableMessage: string,
) {
  const ready = { ...current, cacheReady: true };
  if (current.networkSelected && fresh !== null && current.data === fresh) return ready;
  if (cached === null || (current.data !== null && !isOlderMarketData(cached, current.data))) return ready;
  if (fresh !== null && isOlderMarketData(cached, fresh)) {
    return { data: cached, loading: false, stale: true, error: olderMessage, cacheReady: true, networkAlternative: fresh, networkSelected: false };
  }
  return {
    data: cached,
    loading,
    stale: true,
    error: loading ? null : error instanceof Error ? error.message : unavailableMessage,
    cacheReady: true,
    networkAlternative: null,
    networkSelected: false,
  };
}

/** A customer may inspect an older response without replacing the saved view. */
export function selectNetworkAlternative<T>(state: { data: T | null; loading: boolean; stale: boolean; error: string | null; cacheReady?: boolean; networkAlternative?: T | null; networkSelected?: boolean }) {
  if (!state.networkAlternative) return state;
  return {
    ...state,
    data: state.networkAlternative,
    stale: true,
    error: 'Showing the latest response with an earlier retrieval time. The saved cache was not replaced; device or service clocks may differ.',
    networkAlternative: null,
    networkSelected: true,
  };
}

/** Only accepted live data may replace a known, successfully read disk snapshot. */
export function marketDataToPersist<T>(state: { data: T | null; loading: boolean; stale: boolean; error: string | null; cacheReady?: boolean }): T | null {
  return state.cacheReady === true && state.data !== null && !state.loading && !state.stale && !state.error ? state.data : null;
}

/** Recheck the saved timestamp immediately before a serialized cache write. */
export async function writeMarketCacheIfNotOlder<T extends { retrievedAt: string }>(
  incoming: T,
  read: () => Promise<T | null>,
  write: () => Promise<void>,
): Promise<boolean> {
  const saved = await read();
  if (saved !== null && isOlderMarketData(saved, incoming)) return false;
  await write();
  return true;
}

/** Do not replace newer in-memory data with an older disk snapshot. */
export function chooseNewestMarketData<T extends { retrievedAt: string }>(current: T | null, cached: T): T {
  if (current === null) return cached;
  const currentTime = Date.parse(current.retrievedAt);
  const cachedTime = Date.parse(cached.retrievedAt);
  return Number.isFinite(cachedTime) && (!Number.isFinite(currentTime) || cachedTime > currentTime)
    ? cached
    : current;
}

/** Serialize writes per key and coalesce waiting values so older writes cannot
 * finish after newer ones. A stalled cache never blocks a live market request. */
export function createLatestCacheWriter(write: (key: string, value: string) => Promise<void>) {
  const entries = new Map<string, { pending: string | null }>();
  return (key: string, value: string): void => {
    const existing = entries.get(key);
    if (existing) {
      existing.pending = value;
      return;
    }

    const entry = { pending: value as string | null };
    entries.set(key, entry);
    void (async () => {
      try {
        while (entry.pending !== null) {
          const next = entry.pending;
          entry.pending = null;
          try { await write(key, next); } catch { /* Optional cache. */ }
        }
      } finally {
        if (entries.get(key) === entry) entries.delete(key);
      }
    })();
  };
}

/** Resolve a preference read once, with a fallback if device storage stalls. */
export function loadPreferenceWithTimeout<T>(
  read: () => Promise<T>,
  onValue: (value: T) => void,
  onUnavailable: () => void,
  timeoutMs: number,
): () => void {
  let active = true;
  let settled = false;
  const timeout = setTimeout(() => {
    if (!active || settled) return;
    settled = true;
    onUnavailable();
  }, timeoutMs);
  void Promise.resolve().then(read).then((value) => {
    if (!active || settled) return;
    settled = true;
    clearTimeout(timeout);
    onValue(value);
  }).catch(() => {
    if (!active || settled) return;
    settled = true;
    clearTimeout(timeout);
    onUnavailable();
  });
  return () => { active = false; clearTimeout(timeout); };
}
