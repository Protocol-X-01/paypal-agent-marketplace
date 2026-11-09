/** All cooperating collection writes and local-view resets use this lock. */
export const COLLECTION_LOCK_NAME = "paypal-markets-shopping-collections-v1";
export const SHOPPING_LISTS_STORAGE_KEY = "paypal-markets-shopping-lists-v1";
export const COLLECTIONS_CHANGED_EVENT = "paypal-markets-collections-changed";

export type CollectionLockResult<T> =
  | { kind: "acquired"; value: T }
  | { kind: "busy" | "unsupported" | "unavailable" };

function lockManager(): LockManager | null {
  try {
    if (typeof window === "undefined" || window.isSecureContext !== true) return null;
    const locks = window.navigator?.locks;
    return locks && typeof locks.request === "function" ? locks : null;
  } catch {
    return null;
  }
}

export function collectionLocksAvailable(): boolean {
  return lockManager() !== null;
}

/** Do not wait indefinitely or fall back to an unlocked write. */
export async function tryCollectionLock<T>(operation: () => T): Promise<CollectionLockResult<Awaited<T>>> {
  const locks = lockManager();
  if (!locks) return { kind: "unsupported" };
  try {
    return await locks.request(COLLECTION_LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) =>
      lock ? { kind: "acquired", value: await operation() } : { kind: "busy" },
    );
  } catch {
    return { kind: "unavailable" };
  }
}
