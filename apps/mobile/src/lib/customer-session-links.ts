/** Pure link/encoding checks. Trusted configuration is not proof of deployed app-link association. */
export { isCanonicalCustomerDataScope } from './customer-storage-scope';
export type NativePlatform = 'android' | 'ios';
export type CustomerSessionLinkConfig = Readonly<{ origin: string; androidReturnUrl: string; iosReturnUrl: string }>;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function isCanonicalCustomerHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}
/** Encodes already-generated cryptographic bytes; never generates randomness. */
export function encodeCustomerHandle(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Invalid native sign-in input.');
  let value = '', buffer = 0, bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; value += ALPHABET[(buffer >>> bits) & 63]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits) value += ALPHABET[(buffer << (6 - bits)) & 63];
  return value;
}
function bad(): never { throw new Error('Invalid native sign-in link.'); }
function fixedUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 512 || /[^\x21-\x7e]|[?#]/.test(value)) bad();
  let url: URL; try { url = new URL(value); } catch { return bad(); }
  if (url.protocol !== 'https:' || url.href !== value || url.username || url.password || url.port || url.hostname.length > 253 || !url.hostname.includes('.') || /^[0-9.]+$/.test(url.hostname) ||
    url.hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || url.pathname.includes('//')) bad();
  return url;
}
export function validateCustomerSessionLinkConfig(input: CustomerSessionLinkConfig): CustomerSessionLinkConfig {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'androidReturnUrl,iosReturnUrl,origin' || typeof input.origin !== 'string') bad();
  const origin = fixedUrl(`${input.origin}/`);
  if (origin.origin !== input.origin || origin.pathname !== '/') bad();
  for (const field of ['androidReturnUrl', 'iosReturnUrl'] as const) {
    const target = fixedUrl(input[field]);
    if (target.origin !== input.origin || target.pathname === '/' || `${target.href}?code=${'A'.repeat(43)}&state=${'A'.repeat(43)}`.length > 512) bad();
  }
  return Object.freeze({ origin: input.origin, androidReturnUrl: input.androidReturnUrl, iosReturnUrl: input.iosReturnUrl });
}
export function validateCustomerAuthorizationUrl(value: unknown, handoff: string, config: CustomerSessionLinkConfig): string {
  const checked = validateCustomerSessionLinkConfig(config);
  if (!isCanonicalCustomerHandle(handoff) || typeof value !== 'string' || value.length > 512 || value !== `${checked.origin}/api/auth/native/authorize?handoff=${handoff}`) bad();
  return value;
}
export function parseCustomerSessionReturnUrl(value: unknown, platform: NativePlatform, expectedState: string, config: CustomerSessionLinkConfig): { code: string; state: string } {
  const checked = validateCustomerSessionLinkConfig(config);
  if (platform !== 'android' && platform !== 'ios') bad();
  const target = platform === 'android' ? checked.androidReturnUrl : checked.iosReturnUrl;
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith(`${target}?`) || !isCanonicalCustomerHandle(expectedState)) bad();
  const raw = value.slice(target.length + 1);
  if (/[^A-Za-z0-9_=&-]/.test(raw)) bad();
  const values: Record<string, string> = Object.create(null);
  for (const pair of raw.split('&')) {
    const parts = pair.split('=');
    if (parts.length !== 2 || !['code', 'state'].includes(parts[0]) || Object.prototype.hasOwnProperty.call(values, parts[0]) || !isCanonicalCustomerHandle(parts[1])) bad();
    values[parts[0]] = parts[1];
  }
  if (Object.keys(values).length !== 2 || values.state !== expectedState) bad();
  return { code: values.code, state: values.state };
}
