import { isCanonicalCustomerDataScope, isCanonicalCustomerHandle, validateCustomerAuthorizationUrl, validateCustomerSessionLinkConfig, type CustomerSessionLinkConfig, type NativePlatform } from './customer-session-links';
export type NativeAccountType = 'personal' | 'business' | 'unknown';
export type NativeSessionIdentity = { accountType: NativeAccountType; dataScope: string; expiresAt: number };
export type ValidatedNativeSession = NativeSessionIdentity & { authenticated: true };
/** Exchange expiry is provisional. Call session(token) before exposing or persisting verified identity. */
export type ProvisionalNativeExchange = NativeSessionIdentity & { sessionToken: string };
export type NativeHandoffInput = { state: string; codeChallenge: string; codeChallengeMethod: 'S256'; platform: NativePlatform };
export type NativeExchangeInput = { handoff: string; code: string; state: string; codeVerifier: string };
export type NativeCancelInput = { handoff: string; codeVerifier: string };
export type NativeHandoffResult = { handoff: string; authorizationUrl: string; expiresIn: 300; expiresAt: number };
export type CustomerSessionErrorCode = 'invalid_input' | 'invalid_response' | 'unauthorized' | 'unavailable' | 'rate_limited' | 'timeout';
export class CustomerSessionError extends Error {
  constructor(readonly code: CustomerSessionErrorCode, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(code === 'rate_limited' ? 'Please wait before trying sign-in again.' : code === 'timeout' ? 'The sign-in request timed out.' : 'Sign-in could not be verified.');
    this.name = 'CustomerSessionError';
  }
}
function invalid(code: CustomerSessionErrorCode = 'invalid_input'): never { throw new CustomerSessionError(code); }
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function handles(value: Record<string, unknown>, keys: readonly string[]) { for (const key of keys) if (!isCanonicalCustomerHandle(value[key])) invalid(); }
function time(value: number): number { if (!Number.isSafeInteger(value) || value < 0 || value > 8_639_999_998_200_000) invalid('invalid_response'); return value; }
function identity(value: Record<string, unknown>): { accountType: NativeAccountType; dataScope: string } {
  if (!['personal', 'business', 'unknown'].includes(value.accountType as string) || !isCanonicalCustomerDataScope(value.dataScope)) invalid('invalid_response');
  return { accountType: value.accountType as NativeAccountType, dataScope: value.dataScope };
}
/** Successful wire shapes are flat ASCII scalars. Reject duplicate decoded fields, nested objects and unknown values. */
function parseWire(raw: string): Record<string, unknown> {
  let offset = 0;
  const result: Record<string, unknown> = Object.create(null);
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const whitespace = () => { while (offset < raw.length && /[ \t\r\n]/.test(raw[offset])) offset++; };
  const string = () => { whitespace(); token.lastIndex = offset; const found = token.exec(raw); if (!found) invalid('invalid_response'); offset = token.lastIndex; return JSON.parse(found[0]) as string; };
  whitespace(); if (raw[offset++] !== '{') invalid('invalid_response'); whitespace();
  if (raw[offset] !== '}') {
    while (true) {
      const key = string(); if (Object.prototype.hasOwnProperty.call(result, key)) invalid('invalid_response');
      whitespace(); if (raw[offset++] !== ':') invalid('invalid_response'); whitespace();
      if (raw[offset] === '"') result[key] = string();
      else {
        const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(offset));
        if (!scalar) invalid('invalid_response'); offset += scalar[0].length; result[key] = JSON.parse(scalar[0]);
      }
      whitespace(); if (raw[offset] !== ',') break; offset++;
    }
  }
  if (raw[offset++] !== '}') invalid('invalid_response'); whitespace();
  if (offset !== raw.length) invalid('invalid_response');
  return result;
}
const BASE = '/api/auth/native';
const BODY_LIMIT = 2048;
/** Inject an HTTPS adapter honoring redirect:error, credentials:omit and streaming (e.g. Expo fetch).
 * Expo native ignores cache/referrerPolicy options: explicit cache headers complement server no-store;
 * native requests supply no Referer. These headers are not an independent native cache-policy override.
 * Byte limits bound accepted JS data, not native allocations before cancellation. No automatic retries.
 */
export function createCustomerSessionClient(config: CustomerSessionLinkConfig, deps: { fetch: typeof fetch; now?: () => number; timeoutMs?: number }) {
  let checked: CustomerSessionLinkConfig;
  try { checked = validateCustomerSessionLinkConfig(config); } catch { return invalid(); }
  if (!deps || typeof deps.fetch !== 'function') invalid();
  const now = deps.now ?? Date.now, timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) invalid();
  async function request(path: string, method: 'GET' | 'POST', expectedStatus: number, body?: object, token?: string) {
    if (token !== undefined && !isCanonicalCustomerHandle(token)) invalid();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && (payload.length > BODY_LIMIT || /[^\x00-\x7f]/.test(payload))) invalid();
    const startedAt = time(now()), abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const receivedTime = () => { const value = time(now()); if (value < startedAt) invalid('invalid_response'); return value; };
    const work = async () => {
      const url = `${checked.origin}${BASE}${path}`;
      const response = await deps.fetch(url, { method, headers: { Accept: 'application/json', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }, body: payload, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal });
      if (abort.signal.aborted) { void response.body?.cancel().catch(() => {}); invalid('timeout'); }
      if (response.redirected || (response.url && response.url !== url)) { void response.body?.cancel().catch(() => {}); invalid('invalid_response'); }
      if (response.status !== expectedStatus) {
        void response.body?.cancel().catch(() => {});
        const retry = response.headers.get('retry-after');
        const retryAfter = retry && /^\d{1,5}$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 86400 ? Number(retry) : undefined;
        throw new CustomerSessionError(response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : 'unavailable', response.status, retryAfter);
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > (expectedStatus === 204 ? 0 : BODY_LIMIT))) { void response.body?.cancel().catch(() => {}); invalid('invalid_response'); }
      if (expectedStatus === 204) {
        // Expo returns a lazy stream even for 204; prove it is empty under the same deadline.
        if (response.body !== null) {
          if (!response.body?.getReader) invalid('invalid_response');
          activeReader = response.body.getReader();
          while (true) {
            const next = await activeReader.read();
            if (next.done) break;
            if (next.value.byteLength !== 0) invalid('invalid_response');
          }
        }
        return { value: null, startedAt, receivedAt: receivedTime() };
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || !response.body?.getReader) { void response.body?.cancel().catch(() => {}); invalid('invalid_response'); }
      activeReader = response.body.getReader();
      let raw = '', count = 0;
      while (true) {
        const next = await activeReader.read(); if (next.done) break;
        count += next.value.byteLength; if (count > BODY_LIMIT) invalid('invalid_response');
        for (const byte of next.value) { if (byte > 127) invalid('invalid_response'); raw += String.fromCharCode(byte); }
      }
      if (declared !== null && Number(declared) !== count) invalid('invalid_response');
      return { value: parseWire(raw), startedAt, receivedAt: receivedTime() };
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new CustomerSessionError('timeout')); }, timeoutMs); })]);
    } catch (error) { if (error instanceof CustomerSessionError) throw error; throw new CustomerSessionError('unavailable'); }
    finally { if (timer) clearTimeout(timer); abort.abort(); void activeReader?.cancel().catch(() => {}); }
  }
  return {
    async availability(): Promise<{ loginAvailable: boolean }> {
      const { value } = await request('/availability', 'GET', 200);
      if (!record(value, ['loginAvailable']) || typeof value.loginAvailable !== 'boolean') invalid('invalid_response');
      return { loginAvailable: value.loginAvailable };
    },
    async createHandoff(input: NativeHandoffInput, previousToken?: string): Promise<NativeHandoffResult> {
      if (!record(input, ['state', 'codeChallenge', 'codeChallengeMethod', 'platform'])) invalid();
      handles(input, ['state', 'codeChallenge']);
      if (input.codeChallengeMethod !== 'S256' || !['android', 'ios'].includes(input.platform as string)) invalid();
      const { value, startedAt, receivedAt } = await request('/handoffs', 'POST', 201, input, previousToken);
      if (!record(value, ['handoff', 'authorizationUrl', 'expiresIn']) || !isCanonicalCustomerHandle(value.handoff) || value.expiresIn !== 300 || receivedAt >= startedAt + 300_000) invalid('invalid_response');
      let authorizationUrl: string; try { authorizationUrl = validateCustomerAuthorizationUrl(value.authorizationUrl, value.handoff, checked); } catch { return invalid('invalid_response'); }
      return { handoff: value.handoff, authorizationUrl, expiresIn: 300, expiresAt: startedAt + 300_000 };
    },
    async exchange(input: NativeExchangeInput): Promise<ProvisionalNativeExchange> {
      if (!record(input, ['handoff', 'code', 'state', 'codeVerifier'])) invalid(); handles(input, ['handoff', 'code', 'state', 'codeVerifier']);
      const { value, startedAt, receivedAt } = await request('/exchange', 'POST', 200, input);
      if (!record(value, ['sessionToken', 'expiresIn', 'accountType', 'dataScope']) || !isCanonicalCustomerHandle(value.sessionToken) || value.expiresIn !== 1800 || receivedAt >= startedAt + 1_800_000) invalid('invalid_response');
      return { sessionToken: value.sessionToken, ...identity(value), expiresAt: startedAt + 1_800_000 };
    },
    async session(token: string): Promise<ValidatedNativeSession> {
      if (!isCanonicalCustomerHandle(token)) invalid();
      const { value, receivedAt } = await request('/session', 'GET', 200, undefined, token);
      if (!record(value, ['authenticated', 'accountType', 'dataScope', 'expiresAt']) || value.authenticated !== true || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)) invalid('invalid_response');
      const expiresAt = Date.parse(value.expiresAt);
      if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== value.expiresAt || expiresAt <= receivedAt || expiresAt > receivedAt + 1_800_000) invalid('invalid_response');
      return { authenticated: true, ...identity(value), expiresAt };
    },
    async cancel(input: NativeCancelInput): Promise<void> {
      if (!record(input, ['handoff', 'codeVerifier'])) invalid(); handles(input, ['handoff', 'codeVerifier']);
      await request('/cancel', 'POST', 204, input);
    },
    async logout(token: string): Promise<void> {
      if (!isCanonicalCustomerHandle(token)) invalid(); await request('/logout', 'POST', 204, undefined, token);
    },
  };
}
