import * as SecureStore from 'expo-secure-store';
import type { createCustomerStorageFence, CustomerStorageLease } from './customer-storage-scope';

export const MAX_VENMO_CONTACTS = 5;
export const MAX_CONTACT_DISPLAY_NAME_LENGTH = 36;
export const MAX_CONTACT_HANDLE_LENGTH = 40;

const STORAGE_KEY = 'paypal-markets.venmo-contacts.v1';
const MAX_STORAGE_CHARACTERS = 1_400;
const MAX_STORAGE_BYTES = 1_500;

export type VenmoContact = {
  id: string;
  displayName: string;
  handle: string;
};

export type VenmoContactsReadResult =
  | { status: 'ready'; contacts: VenmoContact[] }
  | { status: 'corrupt'; snapshot: VenmoContactsCorruptSnapshot; changed?: boolean }
  | { status: 'unavailable' };

/** Opaque, repository-owned reference; unreadable bytes are never returned to the UI. */
export type VenmoContactsCorruptSnapshot = object;
export type VenmoContactsForgetBaseline =
  | { status: 'ready'; contacts: VenmoContact[] }
  | { status: 'corrupt'; snapshot: VenmoContactsCorruptSnapshot };

export type VenmoContactsMutationResult =
  | VenmoContactsReadResult
  | { status: 'conflict' | 'duplicate' | 'limit'; contacts: VenmoContact[] }
  | { status: 'invalid-name' | 'invalid-handle' };

type StoredContacts = {
  version: 1;
  contacts: VenmoContact[];
};

let contactsMutationQueue: Promise<void> = Promise.resolve();

function withContactsMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = contactsMutationQueue.then(operation, operation);
  contactsMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function containsControlOrUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return true;
    }
  }
  return false;
}

function normalizeDisplayName(value: string): string | null {
  if (containsControlOrUnpairedSurrogate(value)) return null;
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(normalized).length;
  if (!normalized || length > MAX_CONTACT_DISPLAY_NAME_LENGTH) return null;
  return normalized;
}

function normalizeHandle(value: string): string | null {
  const normalized = value.startsWith('@') ? value.slice(1) : value;
  if (normalized.length < 1 || normalized.length > MAX_CONTACT_HANDLE_LENGTH) return null;
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function isValidContact(value: unknown): value is VenmoContact {
  if (!isRecord(value) || !hasExactlyKeys(value, ['id', 'displayName', 'handle'])) return false;
  if (typeof value.id !== 'string' || !/^contact-[a-z0-9-]{1,48}$/.test(value.id)) return false;
  if (typeof value.displayName !== 'string' || normalizeDisplayName(value.displayName) !== value.displayName) return false;
  if (typeof value.handle !== 'string' || normalizeHandle(value.handle) !== value.handle) return false;
  return true;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function decodeContacts(raw: string): VenmoContact[] | null {
  if (raw.length > MAX_STORAGE_CHARACTERS || utf8ByteLength(raw) > MAX_STORAGE_BYTES) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !hasExactlyKeys(parsed, ['version', 'contacts']) || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.contacts) || parsed.contacts.length > MAX_VENMO_CONTACTS) return null;
    if (!parsed.contacts.every(isValidContact)) return null;

    const contacts = parsed.contacts as VenmoContact[];
    const ids = new Set(contacts.map((contact) => contact.id));
    const handles = new Set(contacts.map((contact) => contact.handle.toLowerCase()));
    if (ids.size !== contacts.length || handles.size !== contacts.length) return null;
    return contacts;
  } catch {
    return null;
  }
}

function encodeContacts(contacts: VenmoContact[]): string | null {
  const payload: StoredContacts = { version: 1, contacts };
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_STORAGE_CHARACTERS || utf8ByteLength(encoded) > MAX_STORAGE_BYTES) return null;
  return encoded;
}

function createContactId(existing: VenmoContact[]): string {
  let id = '';
  do {
    const suffix = Math.floor(Math.random() * 0x1_0000_0000).toString(36).padStart(7, '0');
    id = `contact-${Date.now().toString(36)}-${suffix}`;
  } while (existing.some((contact) => contact.id === id));
  return id;
}

/** Bind repositories to one generation. Recreate after scope changes; never retarget old callbacks. */
export function createVenmoContactsRepository(fence: Pick<ReturnType<typeof createCustomerStorageFence>, 'capture' | 'isCurrent'>) {
  const anchor = fence.capture('venmoContacts');
  const corruptSnapshots = new WeakMap<VenmoContactsCorruptSnapshot, { raw: string; lease: CustomerStorageLease }>();
  const usedForgetBaselines = new WeakSet<object>();
  const capture = () => fence.isCurrent(anchor) ? fence.capture('venmoContacts') : null;
  const valid = (lease: CustomerStorageLease | null): lease is CustomerStorageLease => fence.isCurrent(anchor) && fence.isCurrent(lease);
  const unavailable = (): VenmoContactsReadResult => ({ status: 'unavailable' });
  function unreadable(raw: string, lease: CustomerStorageLease, changed = false): VenmoContactsReadResult {
    const snapshot = Object.freeze({});
    corruptSnapshots.set(snapshot, { raw, lease });
    return changed ? { status: 'corrupt', snapshot, changed: true } : { status: 'corrupt', snapshot };
  }
  async function rawRead(lease: CustomerStorageLease | null): Promise<{ raw: string | null } | null> {
    if (!valid(lease)) return null;
    if (!(await SecureStore.isAvailableAsync()) || !valid(lease)) return null;
    const raw = await SecureStore.getItemAsync(lease.key);
    return valid(lease) ? { raw } : null;
  }
  async function read(lease: CustomerStorageLease | null): Promise<VenmoContactsReadResult> {
    try {
      const result = await rawRead(lease);
      if (!result || !valid(lease)) return unavailable();
      if (result.raw === null) return { status: 'ready', contacts: [] };
      const contacts = decodeContacts(result.raw);
      return contacts ? { status: 'ready', contacts } : unreadable(result.raw, lease);
    } catch { return unavailable(); }
  }
  async function write(lease: CustomerStorageLease | null, expected: VenmoContact[], next: VenmoContact[]): Promise<VenmoContactsMutationResult> {
    const current = await read(lease);
    if (!valid(lease)) return unavailable();
    if (current.status !== 'ready') return current;
    if (JSON.stringify(current.contacts) !== JSON.stringify(expected)) return unavailable();
    if (next.length > MAX_VENMO_CONTACTS || !next.every(isValidContact)) return unavailable();
    const encoded = encodeContacts(next);
    if (encoded === null) return { status: 'limit', contacts: current.contacts };
    try {
      if (!valid(lease)) return unavailable();
      await SecureStore.setItemAsync(lease.key, encoded, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      if (!valid(lease)) return unavailable();
      const saved = await SecureStore.getItemAsync(lease.key);
      if (!valid(lease) || saved !== encoded) return unavailable();
      return { status: 'ready', contacts: next };
    } catch { return unavailable(); }
  }
  return {
    isCurrent: () => fence.isCurrent(anchor),
    loadVenmoContacts(): Promise<VenmoContactsReadResult> { return read(capture()); },
    addVenmoContact(displayNameInput: string, handleInput: string): Promise<VenmoContactsMutationResult> {
      const lease = capture();
      return withContactsMutationLock(async () => {
        if (!valid(lease)) return unavailable();
        const displayName = normalizeDisplayName(displayNameInput);
        if (displayName === null) return { status: 'invalid-name' };
        const handle = normalizeHandle(handleInput);
        if (handle === null) return { status: 'invalid-handle' };
        const current = await read(lease);
        if (!valid(lease)) return unavailable();
        if (current.status !== 'ready') return current;
        if (current.contacts.some(c => c.handle.toLowerCase() === handle.toLowerCase())) return { status: 'duplicate', contacts: current.contacts };
        if (current.contacts.length >= MAX_VENMO_CONTACTS) return { status: 'limit', contacts: current.contacts };
        return write(lease, current.contacts, [...current.contacts, { id: createContactId(current.contacts), displayName, handle }]);
      });
    },
    updateVenmoContact(original: VenmoContact, displayNameInput: string, handleInput: string): Promise<VenmoContactsMutationResult> {
      const lease = capture();
      // Snapshot the row before it enters the queue; callers may hold the same object.
      const baseline = isValidContact(original) ? { ...original } : null;
      return withContactsMutationLock(async () => {
        if (!valid(lease)) return unavailable();
        const displayName = normalizeDisplayName(displayNameInput);
        if (displayName === null) return { status: 'invalid-name' };
        const handle = normalizeHandle(handleInput);
        if (handle === null) return { status: 'invalid-handle' };
        const current = await read(lease);
        if (!valid(lease)) return unavailable();
        if (current.status !== 'ready') return current;
        const existing = baseline ? current.contacts.find((contact) => contact.id === baseline.id) : undefined;
        if (!baseline || !existing || existing.displayName !== baseline.displayName || existing.handle !== baseline.handle) {
          return { status: 'conflict', contacts: current.contacts };
        }
        if (current.contacts.some((contact) => contact.id !== baseline.id && contact.handle.toLowerCase() === handle.toLowerCase())) {
          return { status: 'duplicate', contacts: current.contacts };
        }
        if (existing.displayName === displayName && existing.handle === handle) return current;
        const next = current.contacts.map((contact) => contact.id === baseline.id ? { ...contact, displayName, handle } : contact);
        return write(lease, current.contacts, next);
      });
    },
    removeVenmoContact(original: VenmoContact): Promise<VenmoContactsMutationResult> {
      const lease = capture();
      const baseline = isValidContact(original) ? { ...original } : null;
      return withContactsMutationLock(async () => {
        const current = await read(lease);
        if (!valid(lease)) return unavailable();
        if (current.status !== 'ready') return current;
        const existing = baseline ? current.contacts.find((contact) => contact.id === baseline.id) : undefined;
        if (!baseline || !existing || existing.displayName !== baseline.displayName || existing.handle !== baseline.handle) {
          return { status: 'conflict', contacts: current.contacts };
        }
        return write(lease, current.contacts, current.contacts.filter((contact) => contact.id !== baseline.id));
      });
    },
    forgetVenmoContacts(expected: VenmoContactsForgetBaseline): Promise<VenmoContactsMutationResult> {
      const lease = capture();
      if (!expected || typeof expected !== 'object' || usedForgetBaselines.has(expected)) return Promise.resolve(unavailable());
      usedForgetBaselines.add(expected);
      const baseline = expected?.status === 'ready' && Array.isArray(expected.contacts) && expected.contacts.every(isValidContact)
        ? expected.contacts.map((contact) => ({ ...contact })) : null;
      const corruptBaseline = expected?.status === 'corrupt' && expected.snapshot && typeof expected.snapshot === 'object'
        ? corruptSnapshots.get(expected.snapshot) : undefined;
      return withContactsMutationLock(async () => {
        try {
          if (!valid(lease) || (!baseline && (!corruptBaseline || !valid(corruptBaseline.lease)))) return unavailable();
          const first = await rawRead(lease);
          if (!first || !valid(lease)) return unavailable();
          const classifyChange = (raw: string | null): VenmoContactsMutationResult => {
            if (raw === null) return { status: 'conflict', contacts: [] };
            const contacts = decodeContacts(raw);
            return contacts ? { status: 'conflict', contacts } : unreadable(raw, lease, true);
          };
          if (baseline) {
            const observed = first.raw === null ? [] : decodeContacts(first.raw);
            if (!observed || JSON.stringify(observed) !== JSON.stringify(baseline)) return classifyChange(first.raw);
          } else if (first.raw !== corruptBaseline!.raw) {
            return classifyChange(first.raw);
          }
          const current = await rawRead(lease);
          if (!current || !valid(lease)) return unavailable();
          if (current.raw !== first.raw) return classifyChange(current.raw);
          await SecureStore.deleteItemAsync(lease.key);
          if (!valid(lease)) return unavailable();
          const saved = await SecureStore.getItemAsync(lease.key);
          if (!valid(lease) || saved !== null) return unavailable();
          return { status: 'ready', contacts: [] };
        } catch { return unavailable(); }
      });
    },
  };
}
// Compatibility wrappers stay permanently in the original guest namespace.
const guestLease: CustomerStorageLease = Object.freeze({ scope: Object.freeze({ kind: 'guest' as const }), resource: 'venmoContacts', key: STORAGE_KEY, generation: 0 });
const guestRepository = createVenmoContactsRepository({ capture: () => guestLease, isCurrent: lease => lease === guestLease });
export const { loadVenmoContacts, addVenmoContact, updateVenmoContact, removeVenmoContact, forgetVenmoContacts } = guestRepository;
