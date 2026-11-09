/** Pure destination/lease foundation; no storage, authentication or migration occurs here. */
export type CustomerStorageScope = Readonly<{ kind: 'hold' } | { kind: 'guest' } | { kind: 'owner'; dataScope: string }>;
export type PrivateStorageResource = 'portfolioSecure' | 'legacyPortfolio' | 'venmoContacts' | 'channel3Collections' | 'businessThresholds';
export type WritableStorageScope = Exclude<CustomerStorageScope, { kind: 'hold' }>;
export const GUEST_PRIVATE_STORAGE_KEYS = Object.freeze({
  portfolioSecure: 'paypal-markets.mobile.manual-holdings.secure.v1',
  legacyPortfolio: 'paypal-markets.mobile.manual-holdings.v1',
  venmoContacts: 'paypal-markets.venmo-contacts.v1',
  channel3Collections: 'paypal-markets.mobile.channel3-collections.v1',
  businessThresholds: 'paypal-markets.mobile.business-thresholds.v1',
});
export const PUBLIC_STORAGE_KEYS = Object.freeze({
  displayCurrency: 'paypal-markets.mobile.display-currency.v1',
  shopStorefront: 'paypal-markets.mobile.shop-storefront.v1',
});
/** 32 bytes produce 43 base64url characters with the final two unused bits zero. */
export function isCanonicalCustomerDataScope(value: unknown): value is string {
  return typeof value === 'string' && /^v1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}
function checkedScope(value: CustomerStorageScope): CustomerStorageScope {
  if (!value || typeof value !== 'object') throw new Error('Invalid customer storage scope.');
  const keys = Object.keys(value).sort().join(',');
  if (value.kind === 'hold' && keys === 'kind') return Object.freeze({ kind: 'hold' });
  if (value.kind === 'guest' && keys === 'kind') return Object.freeze({ kind: 'guest' });
  if (value.kind === 'owner' && keys === 'dataScope,kind' && isCanonicalCustomerDataScope(value.dataScope)) return Object.freeze({ kind: 'owner', dataScope: value.dataScope });
  throw new Error('Invalid customer storage scope.');
}
/** Owner input must come from a freshly verified server session, not a local preference. */
export function privateStorageKey(resource: PrivateStorageResource, scope: CustomerStorageScope): string | null {
  if (!Object.prototype.hasOwnProperty.call(GUEST_PRIVATE_STORAGE_KEYS, resource)) throw new Error('Unknown private storage resource.');
  const checked = checkedScope(scope);
  if (checked.kind === 'hold') return null;
  const guestKey = GUEST_PRIVATE_STORAGE_KEYS[resource];
  if (checked.kind === 'guest') return guestKey;
  // Legacy migration/recovery belongs exclusively to the existing guest workspace.
  if (resource === 'legacyPortfolio') return null;
  return `${guestKey.slice(0, -3)}.owner.${checked.dataScope}.v1`;
}
/** Public cache names are independent of identity; callers still validate market support. */
export function publicOverviewCacheKey(currency: string): string {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid public cache selection.');
  return `paypal-markets.mobile.market-overview.v2.${currency}`;
}
export function publicChartCacheKey(currency: string, coinId: string, days: number): string {
  publicOverviewCacheKey(currency);
  if (typeof coinId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(coinId) || ![1, 7, 30, 90, 365].includes(days)) throw new Error('Invalid public cache selection.');
  return `paypal-markets.mobile.chart.${currency}.${coinId}.${days}.v2`;
}
export type CustomerStorageLease = Readonly<{
  scope: WritableStorageScope;
  resource: PrivateStorageResource;
  key: string;
  generation: number;
}>;
/**
 * Capture before enqueueing. Check immediately before every native read/write/delete,
 * after every await, and before publishing results. Never recompute a destination from
 * a new identity inside queued work. This fence cannot retract an already-issued native
 * write or provide cross-runtime compare-and-swap. Keep storage queues, read-back/conflict
 * handling and immutable captured keys. No lease exists during a privacy hold.
 */
export function createCustomerStorageFence(initial: CustomerStorageScope = { kind: 'hold' }) {
  let scope = checkedScope(initial);
  let generation = 0;
  let issued = new WeakSet<object>();
  function transition(next: CustomerStorageScope): void {
    // Invalid transitions also fail closed and revoke every outstanding lease.
    scope = Object.freeze({ kind: 'hold' });
    issued = new WeakSet<object>();
    if (generation === Number.MAX_SAFE_INTEGER) throw new Error('Customer storage generation exhausted.');
    generation++;
    scope = checkedScope(next);
  }
  function capture(resource: PrivateStorageResource): CustomerStorageLease | null {
    const key = privateStorageKey(resource, scope);
    if (key === null || scope.kind === 'hold') return null;
    const lease: CustomerStorageLease = Object.freeze({ scope, resource, key, generation });
    issued.add(lease);
    return lease;
  }
  function isCurrent(lease: CustomerStorageLease | null | undefined): boolean {
    return !!lease && issued.has(lease) && scope.kind !== 'hold' && lease.generation === generation;
  }
  return { current: (): CustomerStorageScope => scope, transition, invalidate: (): void => transition({ kind: 'hold' }), capture, isCurrent };
}
