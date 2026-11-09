import { tryCollectionLock } from "./collection-lock";
import type { LocalDataStorage } from "./customer-session-storage";

export const VENMO_CONTACTS_STORAGE_KEY = "paypal-markets-venmo-contacts-v1";
export const MAX_VENMO_CONTACTS = 5;
export const MAX_CONTACT_DISPLAY_NAME_LENGTH = 36;
export const MAX_CONTACT_HANDLE_LENGTH = 40;

const MAX_STORAGE_CHARACTERS = 1_400;
const MAX_STORAGE_BYTES = 1_500;

export type VenmoContact = {
  id: string;
  displayName: string;
  handle: string;
};

export type VenmoContactsReadResult =
  | { status: "ready"; contacts: VenmoContact[] }
  | { status: "corrupt" | "unavailable" };

export type VenmoContactsMutationResult =
  | VenmoContactsReadResult
  | { status: "conflict" | "duplicate" | "limit" | "busy"; contacts: VenmoContact[] }
  | { status: "unsupported" }
  | { status: "invalid-name" | "invalid-handle" };

export type VenmoContactsForgetCorruptResult =
  | { status: "forgotten" }
  | { status: "changed"; contacts: VenmoContact[] }
  | { status: "busy" | "unsupported" | "unavailable" };

type StoredContacts = { version: 1; contacts: VenmoContact[] };
type MutationDecision = { status: "ready" | "conflict" | "duplicate" | "limit"; contacts: VenmoContact[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function containsControlOrUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return true;
  }
  return false;
}

export function normalizeVenmoContactName(value: string): string | null {
  if (containsControlOrUnpairedSurrogate(value)) return null;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return normalized && Array.from(normalized).length <= MAX_CONTACT_DISPLAY_NAME_LENGTH ? normalized : null;
}

export function normalizeVenmoContactHandle(value: string): string | null {
  const normalized = value.startsWith("@") ? value.slice(1) : value;
  if (normalized.length < 1 || normalized.length > MAX_CONTACT_HANDLE_LENGTH) return null;
  return /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function isValidContact(value: unknown): value is VenmoContact {
  return isRecord(value)
    && hasExactlyKeys(value, ["id", "displayName", "handle"])
    && typeof value.id === "string"
    && /^contact-[a-z0-9-]{1,48}$/.test(value.id)
    && typeof value.displayName === "string"
    && normalizeVenmoContactName(value.displayName) === value.displayName
    && typeof value.handle === "string"
    && normalizeVenmoContactHandle(value.handle) === value.handle;
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
    if (!isRecord(parsed) || !hasExactlyKeys(parsed, ["version", "contacts"]) || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.contacts) || parsed.contacts.length > MAX_VENMO_CONTACTS || !parsed.contacts.every(isValidContact)) return null;
    const contacts = parsed.contacts as VenmoContact[];
    if (new Set(contacts.map((contact) => contact.id)).size !== contacts.length) return null;
    if (new Set(contacts.map((contact) => contact.handle.toLowerCase())).size !== contacts.length) return null;
    return contacts;
  } catch {
    return null;
  }
}

function encodeContacts(contacts: VenmoContact[]): string | null {
  const encoded = JSON.stringify({ version: 1, contacts } satisfies StoredContacts);
  return encoded.length <= MAX_STORAGE_CHARACTERS && utf8ByteLength(encoded) <= MAX_STORAGE_BYTES ? encoded : null;
}

function createContactId(existing: VenmoContact[]): string {
  let id = "";
  do {
    const randomPart = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().toLowerCase().replaceAll("-", "")
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    id = `contact-${randomPart}`;
  } while (existing.some((contact) => contact.id === id));
  return id;
}

function sameContacts(left: VenmoContact[], right: VenmoContact[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Browser-only contact storage. Writes share the app-wide lock used by local-data reset. */
export function createWebVenmoContactsRepository(storage: LocalDataStorage) {
  function read(): VenmoContactsReadResult {
    try {
      const raw = storage.getItem(VENMO_CONTACTS_STORAGE_KEY);
      if (raw === null) return { status: "ready", contacts: [] };
      const contacts = decodeContacts(raw);
      return contacts ? { status: "ready", contacts } : { status: "corrupt" };
    } catch {
      return { status: "unavailable" };
    }
  }

  async function mutate(
    expected: VenmoContact[],
    change: (current: VenmoContact[]) => MutationDecision,
  ): Promise<VenmoContactsMutationResult> {
    const lockResult = await tryCollectionLock((): VenmoContactsMutationResult => {
      const current = read();
      if (current.status !== "ready") return current;
      if (!sameContacts(current.contacts, expected)) return { status: "conflict", contacts: current.contacts };

      const decision = change(current.contacts);
      if (decision.status !== "ready") return decision;
      if (decision.contacts.length > MAX_VENMO_CONTACTS) return { status: "limit", contacts: current.contacts };
      const encoded = encodeContacts(decision.contacts);
      if (encoded === null) return { status: "limit", contacts: current.contacts };

      try {
        storage.setItem(VENMO_CONTACTS_STORAGE_KEY, encoded);
        if (storage.getItem(VENMO_CONTACTS_STORAGE_KEY) !== encoded) return { status: "unavailable" };
        return { status: "ready", contacts: decision.contacts };
      } catch {
        return { status: "unavailable" };
      }
    });
    if (lockResult.kind === "acquired") return lockResult.value;
    if (lockResult.kind === "busy") return { status: "busy", contacts: expected };
    return lockResult.kind === "unsupported" ? { status: "unsupported" } : { status: "unavailable" };
  }

  return {
    loadVenmoContacts: read,
    async forgetUnreadableVenmoContacts(): Promise<VenmoContactsForgetCorruptResult> {
      const lockResult = await tryCollectionLock((): VenmoContactsForgetCorruptResult => {
        try {
          const raw = storage.getItem(VENMO_CONTACTS_STORAGE_KEY);
          if (raw === null) return { status: "changed", contacts: [] };
          const contacts = decodeContacts(raw);
          if (contacts !== null) return { status: "changed", contacts };
          storage.removeItem(VENMO_CONTACTS_STORAGE_KEY);
          if (storage.getItem(VENMO_CONTACTS_STORAGE_KEY) !== null) return { status: "unavailable" };
          return { status: "forgotten" };
        } catch {
          return { status: "unavailable" };
        }
      });
      if (lockResult.kind === "acquired") return lockResult.value;
      if (lockResult.kind === "busy") return { status: "busy" };
      return lockResult.kind === "unsupported" ? { status: "unsupported" } : { status: "unavailable" };
    },
    addVenmoContact(expected: VenmoContact[], displayNameInput: string, handleInput: string): Promise<VenmoContactsMutationResult> {
      const displayName = normalizeVenmoContactName(displayNameInput);
      if (!displayName) return Promise.resolve({ status: "invalid-name" });
      const handle = normalizeVenmoContactHandle(handleInput);
      if (!handle) return Promise.resolve({ status: "invalid-handle" });
      return mutate(expected, (current) => {
        if (current.some((contact) => contact.handle.toLowerCase() === handle.toLowerCase())) return { status: "duplicate", contacts: current };
        if (current.length >= MAX_VENMO_CONTACTS) return { status: "limit", contacts: current };
        return { status: "ready", contacts: [...current, { id: createContactId(current), displayName, handle }] };
      });
    },
    updateVenmoContact(expected: VenmoContact[], original: VenmoContact, displayNameInput: string, handleInput: string): Promise<VenmoContactsMutationResult> {
      const displayName = normalizeVenmoContactName(displayNameInput);
      if (!displayName) return Promise.resolve({ status: "invalid-name" });
      const handle = normalizeVenmoContactHandle(handleInput);
      if (!handle) return Promise.resolve({ status: "invalid-handle" });
      return mutate(expected, (current) => {
        const existing = current.find((contact) => contact.id === original.id);
        if (!existing || existing.displayName !== original.displayName || existing.handle !== original.handle) return { status: "conflict", contacts: current };
        if (current.some((contact) => contact.id !== original.id && contact.handle.toLowerCase() === handle.toLowerCase())) return { status: "duplicate", contacts: current };
        return { status: "ready", contacts: current.map((contact) => contact.id === original.id ? { ...contact, displayName, handle } : contact) };
      });
    },
    removeVenmoContact(expected: VenmoContact[], original: VenmoContact): Promise<VenmoContactsMutationResult> {
      return mutate(expected, (current) => {
        const existing = current.find((contact) => contact.id === original.id);
        if (!existing || existing.displayName !== original.displayName || existing.handle !== original.handle) return { status: "conflict", contacts: current };
        return { status: "ready", contacts: current.filter((contact) => contact.id !== original.id) };
      });
    },
  };
}
