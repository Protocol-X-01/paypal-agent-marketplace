import "server-only";

import { isIP } from "node:net";

const WINDOW_MS = 60_000;
const MAX_RATE_ENTRIES = 2_000;
const MAX_ACTIVE_CLIENT_KEYS = 2_000;

export type ClientRequestBucket = "channel3" | "coingecko" | "binance-intraday";
export type ClientConcurrencyBucket =
  | "binance-intraday"
  | "paypal-webhook-verification"
  | "marketplace-search-body";

type RateEntry = { startedAt: number; count: number };
type ConcurrencyMap = Map<string, number>;

type RequestLimitsGlobal = typeof globalThis & {
  __paypalMarketsClientRequestRates?: Map<ClientRequestBucket, Map<string, RateEntry>>;
  __paypalMarketsClientActiveSlots?: Map<ClientConcurrencyBucket, ConcurrencyMap>;
};

const globalForLimits = globalThis as RequestLimitsGlobal;
const requestRates = (globalForLimits.__paypalMarketsClientRequestRates ??= new Map());
const activeSlots = (globalForLimits.__paypalMarketsClientActiveSlots ??= new Map());

export function getTrustedClientAddress(request: Request): string {
  // Render's Cloudflare edge overwrites this header. X-Forwarded-For can
  // preserve caller-supplied entries, so it is not safe as a limiter key.
  const candidate = request.headers.get("cf-connecting-ip")?.trim();
  return candidate && isIP(candidate) ? candidate : "unknown";
}

export function takeClientRequestLimit(
  request: Request,
  bucket: ClientRequestBucket,
  limit: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(now) || now < 0) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  const address = getTrustedClientAddress(request);
  let bucketRates = requestRates.get(bucket);
  const current = bucketRates?.get(address);
  if (current && now - current.startedAt < WINDOW_MS) {
    if (current.count >= limit) {
      const retryAfterSeconds = Math.min(60, Math.max(1, Math.ceil((current.startedAt + WINDOW_MS - now) / 1000)));
      return { allowed: false, retryAfterSeconds };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucketRates ??= new Map();
  if (bucketRates.size >= MAX_RATE_ENTRIES) {
    for (const [entryAddress, entry] of bucketRates) {
      if (now - entry.startedAt >= WINDOW_MS) bucketRates.delete(entryAddress);
    }
  }
  if (bucketRates.size >= MAX_RATE_ENTRIES) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  requestRates.set(bucket, bucketRates);
  bucketRates.set(address, { startedAt: now, count: 1 });
  return { allowed: true, retryAfterSeconds: 0 };
}

export function acquireClientSlot(
  request: Request,
  bucket: ClientConcurrencyBucket,
  limit: number,
): (() => void) | null {
  if (!Number.isSafeInteger(limit) || limit < 1) return null;

  return acquireClientSlotForAddress(getTrustedClientAddress(request), bucket, limit);
}

export function acquireClientSlotForAddress(
  address: string,
  bucket: ClientConcurrencyBucket,
  limit: number,
): (() => void) | null {
  if (!address || !Number.isSafeInteger(limit) || limit < 1) return null;

  let bucketSlots = activeSlots.get(bucket);
  const current = bucketSlots?.get(address) ?? 0;
  if (current >= limit) return null;
  bucketSlots ??= new Map();
  if (!bucketSlots.has(address) && bucketSlots.size >= MAX_ACTIVE_CLIENT_KEYS) return null;

  activeSlots.set(bucket, bucketSlots);
  bucketSlots.set(address, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = bucketSlots?.get(address) ?? 0;
    if (active <= 1) bucketSlots?.delete(address);
    else bucketSlots?.set(address, active - 1);
    if (bucketSlots?.size === 0) activeSlots.delete(bucket);
  };
}
