import type { ValidatedNativeSession } from './customer-session-client';
import { isCanonicalCustomerHandle, isCanonicalCustomerDataScope, validateCustomerSessionLinkConfig, type CustomerSessionLinkConfig } from './customer-session-links';

export const CUSTOMER_SESSION_STORAGE_KEY = 'paypal-markets.mobile.native-auth.secure.v1';
const KEY = CUSTOMER_SESSION_STORAGE_KEY;
const MAX_BYTES = 1900;
/** Runtime must bind this interface to native, device-only, when-unlocked secure
 * storage. This declaration does not establish OS security. Never bind web storage. */
export type CustomerSessionSecureAdapter = {
  kind: 'native-secure-device-only';
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};
export type StoredSessionCandidate = Readonly<{ sessionToken: string; accountType: 'personal' | 'business' | 'unknown'; dataScope: string; expiresAt: number; verifiedAt: number }>;
export type StoredPendingSignIn = Readonly<{ state: string; codeVerifier: string; createdAt: number; expiresAt: number; handoff?: string }>;
export type RevocationRetry = Readonly<{ kind: 'session'; sessionToken: string; expiresAt: number } | { kind: 'handoff'; handoff: string; codeVerifier: string; attemptExpiresAt: number }>;
export type CustomerAuthEnvelope = Readonly<{ version: 1; binding: string; session: StoredSessionCandidate | null; pending: StoredPendingSignIn | null; revocations: readonly RevocationRetry[] }>;
/** Opaque lease: obtaining a readable candidate never proves current authentication. */
export type CustomerAuthSnapshot = Readonly<{ value: CustomerAuthEnvelope }>;
export type CustomerAuthStorageResult = { status: 'ready'; snapshot: CustomerAuthSnapshot } | { status: 'corrupt' | 'unavailable' | 'stale' | 'conflict' | 'invalid' | 'configuration-mismatch' | 'unconfirmed' };
type Coordinator = { queue: Promise<void>; generation: number; identity: object };
const coordinators = new WeakMap<CustomerSessionSecureAdapter, Coordinator>();
const record = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_639_999_998_200_000;
function validSession(v: unknown): v is StoredSessionCandidate {
  return record(v, ['sessionToken', 'accountType', 'dataScope', 'expiresAt', 'verifiedAt']) && isCanonicalCustomerHandle(v.sessionToken) && ['personal', 'business', 'unknown'].includes(v.accountType as string) && isCanonicalCustomerDataScope(v.dataScope) && time(v.verifiedAt) && time(v.expiresAt) && v.expiresAt > v.verifiedAt && v.expiresAt <= v.verifiedAt + 1800000;
}
function validPending(v: unknown): v is StoredPendingSignIn {
  return record(v, ['state', 'codeVerifier', 'createdAt', 'expiresAt', ...(v && typeof v === 'object' && Object.hasOwn(v, 'handoff') ? ['handoff'] : [])]) && isCanonicalCustomerHandle(v.state) && isCanonicalCustomerHandle(v.codeVerifier) && time(v.createdAt) && time(v.expiresAt) && v.expiresAt === v.createdAt + 300000 && (!Object.hasOwn(v, 'handoff') || isCanonicalCustomerHandle(v.handoff));
}
function validRetry(v: unknown): v is RevocationRetry {
  if (record(v, ['kind', 'sessionToken', 'expiresAt'])) return v.kind === 'session' && isCanonicalCustomerHandle(v.sessionToken) && time(v.expiresAt);
  return record(v, ['kind', 'handoff', 'codeVerifier', 'attemptExpiresAt']) && v.kind === 'handoff' && isCanonicalCustomerHandle(v.handoff) && isCanonicalCustomerHandle(v.codeVerifier) && time(v.attemptExpiresAt);
}
function validEnvelope(v: unknown): v is CustomerAuthEnvelope {
  if (!record(v, ['version', 'binding', 'session', 'pending', 'revocations']) || v.version !== 1 || typeof v.binding !== 'string' || !v.binding || v.binding.length > 1024 || /[^\x20-\x7e]/.test(v.binding) || (v.session !== null && !validSession(v.session)) || (v.pending !== null && !validPending(v.pending)) || !Array.isArray(v.revocations) || v.revocations.length > 2 || !v.revocations.every(validRetry)) return false;
  if (new Set(v.revocations.map(r => r.kind)).size !== v.revocations.length) return false;
  const retry = v.revocations.find(r => r.kind === 'handoff');
  if (retry && (!v.pending || retry.handoff !== v.pending.handoff || retry.codeVerifier !== v.pending.codeVerifier)) return false;
  const revokeSession = v.revocations.find(r => r.kind === 'session');
  return !revokeSession || !v.session || revokeSession.sessionToken !== v.session.sessionToken;
}
function encode(value: CustomerAuthEnvelope): string | null {
  if (!validEnvelope(value)) return null;
  const raw = JSON.stringify(value);
  return raw.length <= MAX_BYTES && /^[\x20-\x7e]*$/.test(raw) ? raw : null;
}
function decode(raw: string): CustomerAuthEnvelope | null {
  if (raw.length > MAX_BYTES || !/^[\x20-\x7e]*$/.test(raw)) return null;
  try { const value: unknown = JSON.parse(raw); return validEnvelope(value) && JSON.stringify(value) === raw ? value : null; } catch { return null; }
}
/** Presence-only disabled-config gate: recognize a confirmed empty envelope
 * without exposing its binding or any authentication material. */
export function classifyCustomerSessionStoragePresence(raw: string | null): 'empty' | 'present' {
  if (raw === null) return 'empty';
  const value = decode(raw);
  return value && value.session === null && value.pending === null && value.revocations.length === 0 ? 'empty' : 'present';
}
function freeze(value: CustomerAuthEnvelope): CustomerAuthEnvelope {
  return Object.freeze({ ...value, session: value.session && Object.freeze({ ...value.session }), pending: value.pending && Object.freeze({ ...value.pending }), revocations: Object.freeze(value.revocations.map(r => Object.freeze({ ...r }))) });
}

/** One atomic small envelope. Local serialization is not a cross-process CAS:
 * runtime must share the same singleton adapter and own this key exclusively.
 * An already-issued native write cannot be withdrawn by invalidate(); post-write
 * invalidation returns stale and requires re-read, never a rollback overwrite. */
export function createCustomerSessionStorage(adapter: CustomerSessionSecureAdapter, config: CustomerSessionLinkConfig, options: { now?: () => number } = {}) {
  const binding = JSON.stringify(validateCustomerSessionLinkConfig(config));
  if (!adapter || adapter.kind !== 'native-secure-device-only' || binding.length > 1024) throw new Error('Secure sign-in storage is unavailable.');
  let shared = coordinators.get(adapter);
  if (!shared) { shared = { queue: Promise.resolve(), generation: 0, identity: Object.freeze({}) }; coordinators.set(adapter, shared); }
  const coordinator = shared;
  const now = options.now ?? Date.now;
  const leases = new WeakMap<CustomerAuthSnapshot, { raw: string | null; generation: number; verified: boolean }>();
  const blank = (): CustomerAuthEnvelope => ({ version: 1, binding, session: null, pending: null, revocations: [] });
  function snapshot(value: CustomerAuthEnvelope, raw: string | null, verified = false): CustomerAuthSnapshot {
    const result = Object.freeze({ value: freeze(value) }); leases.set(result, { raw, generation: coordinator.generation, verified }); return result;
  }
  function enqueue(operation: () => Promise<CustomerAuthStorageResult>): Promise<CustomerAuthStorageResult> {
    const pending = coordinator.queue.then(operation, operation).catch((): CustomerAuthStorageResult => ({ status: 'unavailable' }));
    coordinator.queue = pending.then(() => undefined, () => undefined); return pending;
  }
  async function current(): Promise<{ status: 'value'; value: CustomerAuthEnvelope; raw: string | null } | Exclude<CustomerAuthStorageResult, { status: 'ready' }>> {
    let raw: string | null; try { raw = await adapter.getItem(KEY); } catch { return { status: 'unavailable' }; }
    if (raw === null) return { status: 'value', value: blank(), raw };
    const value = decode(raw); if (!value) return { status: 'corrupt' };
    if (value.binding !== binding) return { status: 'configuration-mismatch' };
    return { status: 'value', value, raw };
  }
  function commit(base: CustomerAuthSnapshot, next: CustomerAuthEnvelope, verified = false): Promise<CustomerAuthStorageResult> {
    const lease = leases.get(base), raw = encode(next);
    if (!lease || raw === null) return Promise.resolve({ status: 'invalid' });
    return enqueue(async () => {
      if (lease.generation !== coordinator.generation) return { status: 'stale' };
      const c = await current(); if (c.status !== 'value') return c;
      if (lease.generation !== coordinator.generation) return { status: 'stale' };
      if (lease.raw !== c.raw) return { status: 'conflict' };
      try { await adapter.setItem(KEY, raw); } catch { coordinator.generation++; return { status: 'unavailable' }; }
      // Any old snapshots are invalid after an attempted successful write.
      const generation = ++coordinator.generation;
      let saved: string | null; try { saved = await adapter.getItem(KEY); } catch { return { status: 'unavailable' }; }
      if (generation !== coordinator.generation || generation !== lease.generation + 1) return { status: 'stale' };
      if (saved !== raw) return { status: 'conflict' };
      return { status: 'ready', snapshot: snapshot(next, raw, verified) };
    });
  }
  const invalid = (): Promise<CustomerAuthStorageResult> => Promise.resolve({ status: 'invalid' });
  return {
    /** Opaque in-process identity shared only by wrappers for the same adapter. */
    coordinationIdentity() { return coordinator.identity; },
    invalidate() { coordinator.generation++; },
    read(): Promise<CustomerAuthStorageResult> {
      const generation = coordinator.generation;
      return enqueue(async () => { const c = await current(); if (generation !== coordinator.generation) return { status: 'stale' }; return c.status === 'value' ? { status: 'ready', snapshot: snapshot(c.value, c.raw) } : c; });
    },
    savePending(base: CustomerAuthSnapshot, input: { state: string; codeVerifier: string; handoff?: string }): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base) || !input || typeof input !== 'object' || !record(input, ['state', 'codeVerifier', ...(Object.hasOwn(input, 'handoff') ? ['handoff'] : [])]) || !isCanonicalCustomerHandle(input.state) || !isCanonicalCustomerHandle(input.codeVerifier) || (input.handoff !== undefined && !isCanonicalCustomerHandle(input.handoff)) || base.value.revocations.length) return invalid();
      const old = base.value.pending, stamp = old?.createdAt ?? now();
      if (!time(stamp) || (old && (old.state !== input.state || old.codeVerifier !== input.codeVerifier || (old.handoff !== undefined && old.handoff !== input.handoff)))) return invalid();
      const pending: StoredPendingSignIn = { state: input.state, codeVerifier: input.codeVerifier, createdAt: stamp, expiresAt: stamp + 300000, ...(input.handoff ? { handoff: input.handoff } : {}) };
      return commit(base, { ...base.value, pending });
    },
    /** Runtime MUST persist and read back the handoff before opening its browser URL.
     * Under that ordering an unbound attempt cannot issue a session, even if its
     * creation response was lost. Never use this to discard a bound attempt. */
    discardUnboundPending(base: CustomerAuthSnapshot): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base) || !base.value.pending || base.value.pending.handoff !== undefined || base.value.revocations.length) return invalid();
      return commit(base, { ...base.value, pending: null });
    },
    /** Only pass the validated GET /session response, never provisional exchange data. */
    saveVerifiedSession(base: CustomerAuthSnapshot, sessionToken: string, server: ValidatedNativeSession): Promise<CustomerAuthStorageResult> {
      const stamp = now();
      if (!leases.has(base) || !record(server, ['authenticated', 'accountType', 'dataScope', 'expiresAt']) || server.authenticated !== true || !isCanonicalCustomerHandle(sessionToken) || !time(stamp) || !time(server.expiresAt) || server.expiresAt <= stamp || server.expiresAt > stamp + 1800000 || base.value.revocations.length) return invalid();
      const session: StoredSessionCandidate = { sessionToken, accountType: server.accountType, dataScope: server.dataScope, expiresAt: server.expiresAt, verifiedAt: stamp };
      // Keep the verifier on disk during write and independent read-back.
      return commit(base, { ...base.value, session }, true);
    },
    finishVerifiedSignIn(base: CustomerAuthSnapshot): Promise<CustomerAuthStorageResult> {
      if (!leases.get(base)?.verified || !base.value.session || base.value.session.expiresAt <= now()) return Promise.resolve({ status: 'unconfirmed' });
      return commit(base, { ...base.value, pending: null }, true);
    },
    queueSessionRevocation(base: CustomerAuthSnapshot): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base) || !base.value.session || base.value.revocations.some(r => r.kind === 'session')) return invalid();
      const session = base.value.session;
      return commit(base, { ...base.value, session: null, revocations: [...base.value.revocations, { kind: 'session', sessionToken: session.sessionToken, expiresAt: session.expiresAt }] });
    },
    queueHandoffCancellation(base: CustomerAuthSnapshot): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base)) return invalid();
      const pending = base.value.pending;
      if (!pending?.handoff || base.value.revocations.some(r => r.kind === 'handoff')) return invalid();
      // A successful exchange may have been lost: expiry here is not proof that
      // no issued family remains. Only confirmed cancellation removes this row.
      return commit(base, { ...base.value, revocations: [...base.value.revocations, { kind: 'handoff', handoff: pending.handoff, codeVerifier: pending.codeVerifier, attemptExpiresAt: pending.expiresAt }] });
    },
    /** Call only after server-confirmed logout (or independently verified family expiry). */
    confirmSessionRevoked(base: CustomerAuthSnapshot, token: string): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base) || !base.value.revocations.some(r => r.kind === 'session' && r.sessionToken === token)) return invalid();
      return commit(base, { ...base.value, revocations: base.value.revocations.filter(r => r.kind !== 'session') });
    },
    /** Call only after server-confirmed cancellation, not merely browser closure. */
    confirmHandoffCancelled(base: CustomerAuthSnapshot, handoff: string): Promise<CustomerAuthStorageResult> {
      if (!leases.has(base) || base.value.pending?.handoff !== handoff || !base.value.revocations.some(r => r.kind === 'handoff' && r.handoff === handoff)) return invalid();
      return commit(base, { ...base.value, pending: null, revocations: base.value.revocations.filter(r => r.kind !== 'handoff') });
    },
  };
}
