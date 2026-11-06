export type DataScope = "guest" | `v1_${string}`;
export type ScopeLease = { readonly id: string; readonly scope: DataScope; active: boolean };
export type LocalDataStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createScopeLease(scope: string, id: string): ScopeLease {
  if (scope !== "guest" && !/^v1_[A-Za-z0-9_-]{43}$/.test(scope)) throw new Error("Invalid local data scope");
  return { scope: scope as DataScope, id, active: true };
}

export function revokeScopeLease(lease: ScopeLease | null) { if (lease) lease.active = false; }

function assertActive(lease: ScopeLease) {
  if (!lease.active) throw new Error("Session changed; local data access is suspended");
}

export function scopedStorageKey(lease: ScopeLease, key: string): string {
  assertActive(lease);
  return lease.scope === "guest" ? key : `${key}::${lease.scope}`;
}

export function decodeScopeStorageKey(lease: ScopeLease, key: string | null): string | null | undefined {
  if (!lease.active) return undefined;
  if (key === null) return null;
  if (lease.scope === "guest") return key.includes("::v1_") ? undefined : key;
  const suffix = `::${lease.scope}`;
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : undefined;
}

/** No fallback, repair, enumeration or migration; revoked callers cannot reach storage. */
export function createScopedStorage(getNative: () => LocalDataStorage, lease: ScopeLease): LocalDataStorage {
  return {
    getItem(key) { const actual = scopedStorageKey(lease, key); return getNative().getItem(actual); },
    setItem(key, value) { const actual = scopedStorageKey(lease, key); getNative().setItem(actual, value); },
    removeItem(key) { const actual = scopedStorageKey(lease, key); getNative().removeItem(actual); },
  };
}
