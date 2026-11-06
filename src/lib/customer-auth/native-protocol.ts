import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Proposed protocol foundation only. No route, session store or provider is enabled. */
export const NATIVE_AUTH_LIMITS = Object.freeze({ bodyBytes: 2048, returnUrlBytes: 512, handoffMs: 300_000, codeMs: 60_000, sessionMs: 1_800_000 });
export type NativePlatform = "android" | "ios";
export type NativeHandoffInput = { state: string; codeChallenge: string; codeChallengeMethod: "S256"; platform: NativePlatform };
export type NativeExchangeInput = { handoff: string; code: string; state: string; codeVerifier: string };
export type NativeCancelInput = { handoff: string; codeVerifier: string };
export type NativeLinkPolicy = Readonly<{ origin: string; android: string; ios: string }>;

export class NativeProtocolError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_link_policy" | "unavailable_attempt" = "invalid_input") {
    super("Native sign-in validation failed");
    this.name = "NativeProtocolError";
  }
}
function invalid(): never { throw new NativeProtocolError(); }

export function isCanonicalNativeHandle(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}
export function newNativeHandle(): string { return randomBytes(32).toString("base64url"); }
export function hashNativeHandle(value: string): string {
  if (!isCanonicalNativeHandle(value)) invalid();
  return createHash("sha256").update(value, "ascii").digest("hex");
}
export function nativeS256Challenge(verifier: string): string {
  if (!isCanonicalNativeHandle(verifier)) invalid();
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
/** Equal-length decoded secret material only; malformed encodings fail before comparison. */
export function equalNativeHandles(left: unknown, right: unknown): boolean {
  if (!isCanonicalNativeHandle(left) || !isCanonicalNativeHandle(right)) return false;
  return timingSafeEqual(Buffer.from(left, "base64url"), Buffer.from(right, "base64url"));
}

/** Flat string-only JSON avoids JSON.parse's silent last-key-wins behavior. */
function parseStringObject(raw: unknown, keys: readonly string[]): Record<string, string> {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > NATIVE_AUTH_LIMITS.bodyBytes) invalid();
  const result: Record<string, string> = Object.create(null);
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  let offset = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(raw[offset] ?? "") && offset < raw.length) offset++; };
  const string = (): string => {
    space(); token.lastIndex = offset;
    const match = token.exec(raw);
    if (!match) invalid();
    offset = token.lastIndex;
    return JSON.parse(match[0]) as string;
  };
  space(); if (raw[offset++] !== "{") invalid(); space();
  if (raw[offset] !== "}") {
    while (true) {
      const key = string();
      if (!keys.includes(key) || Object.hasOwn(result, key)) invalid();
      space(); if (raw[offset++] !== ":") invalid();
      result[key] = string(); space();
      if (raw[offset] !== ",") break;
      offset++;
    }
  }
  if (raw[offset++] !== "}") invalid(); space();
  if (offset !== raw.length || Object.keys(result).length !== keys.length) invalid();
  return result;
}
function requireHandles(value: Record<string, string>, keys: readonly string[]): void {
  for (const key of keys) if (!isCanonicalNativeHandle(value[key])) invalid();
}
export function parseNativeHandoffBody(raw: unknown): NativeHandoffInput {
  const value = parseStringObject(raw, ["state", "codeChallenge", "codeChallengeMethod", "platform"]);
  requireHandles(value, ["state", "codeChallenge"]);
  if (value.codeChallengeMethod !== "S256" || (value.platform !== "android" && value.platform !== "ios")) invalid();
  return { state: value.state, codeChallenge: value.codeChallenge, codeChallengeMethod: "S256", platform: value.platform };
}
export function parseNativeExchangeBody(raw: unknown): NativeExchangeInput {
  const value = parseStringObject(raw, ["handoff", "code", "state", "codeVerifier"]);
  requireHandles(value, ["handoff", "code", "state", "codeVerifier"]);
  return { handoff: value.handoff, code: value.code, state: value.state, codeVerifier: value.codeVerifier };
}
export function parseNativeCancelBody(raw: unknown): NativeCancelInput {
  const value = parseStringObject(raw, ["handoff", "codeVerifier"]);
  requireHandles(value, ["handoff", "codeVerifier"]);
  return { handoff: value.handoff, codeVerifier: value.codeVerifier };
}
/** This protocol's fields need no escaping. Reject noncanonical form encodings. */
function parseCanonicalParameters(raw: string, keys: readonly string[]): Record<string, string> {
  if (!raw || Buffer.byteLength(raw, "utf8") > NATIVE_AUTH_LIMITS.bodyBytes || /[^A-Za-z0-9_=&-]/.test(raw)) invalid();
  const values: Record<string, string> = Object.create(null);
  for (const pair of raw.split("&")) {
    const parts = pair.split("=");
    if (parts.length !== 2 || !keys.includes(parts[0]) || Object.hasOwn(values, parts[0]) || !isCanonicalNativeHandle(parts[1])) invalid();
    values[parts[0]] = parts[1];
  }
  if (Object.keys(values).length !== keys.length) invalid();
  return values;
}
export function parseNativeAuthorizeForm(raw: unknown): { handoff: string; formToken: string } {
  if (typeof raw !== "string") invalid();
  const value = parseCanonicalParameters(raw, ["handoff", "formToken"]);
  return { handoff: value.handoff, formToken: value.formToken };
}

function canonicalHttps(value: unknown): URL {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > NATIVE_AUTH_LIMITS.returnUrlBytes || /[^\x21-\x7e]|[?#]/.test(value)) throw new NativeProtocolError("invalid_link_policy");
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeProtocolError("invalid_link_policy"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      url.href !== value || url.hostname.endsWith(".") || url.hostname === "localhost" ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) || !url.hostname.includes(".") || url.hostname.length > 253 ||
      url.hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^[0-9.]+$/.test(url.hostname) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || url.pathname.includes("//")) throw new NativeProtocolError("invalid_link_policy");
  return url;
}
/** Trusted configuration validation, NOT proof of deployed app-link ownership/association. */
export function validateNativeLinkPolicy(input: NativeLinkPolicy): NativeLinkPolicy {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "android,ios,origin") throw new NativeProtocolError("invalid_link_policy");
  const originUrl = canonicalHttps(`${input.origin}/`);
  if (originUrl.origin !== input.origin || originUrl.pathname !== "/") throw new NativeProtocolError("invalid_link_policy");
  for (const platform of ["android", "ios"] as const) {
    const target = canonicalHttps(input[platform]);
    if (target.origin !== input.origin || target.pathname === "/") throw new NativeProtocolError("invalid_link_policy");
    // Reserve enough bytes for both fixed-length return parameters.
    if (Buffer.byteLength(`${target.href}?code=${"A".repeat(43)}&state=${"A".repeat(43)}`, "utf8") > NATIVE_AUTH_LIMITS.returnUrlBytes) throw new NativeProtocolError("invalid_link_policy");
  }
  return Object.freeze({ origin: input.origin, android: input.android, ios: input.ios });
}
function returnTarget(policy: NativeLinkPolicy, platform: NativePlatform): string {
  const checked = validateNativeLinkPolicy(policy);
  if (platform !== "android" && platform !== "ios") invalid();
  return checked[platform];
}
export function buildNativeReturnUrl(policy: NativeLinkPolicy, platform: NativePlatform, code: string, state: string): string {
  if (!isCanonicalNativeHandle(code) || !isCanonicalNativeHandle(state)) invalid();
  return `${returnTarget(policy, platform)}?code=${code}&state=${state}`;
}
export function parseNativeReturnUrl(raw: unknown, policy: NativeLinkPolicy, platform: NativePlatform, expectedState: string): { code: string; state: string } {
  const target = returnTarget(policy, platform);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > NATIVE_AUTH_LIMITS.returnUrlBytes || !raw.startsWith(`${target}?`)) invalid();
  const value = parseCanonicalParameters(raw.slice(target.length + 1), ["code", "state"]);
  if (!equalNativeHandles(value.state, expectedState)) invalid();
  return { code: value.code, state: value.state };
}

function timestamp(value: number): void {
  // Date's representable range is narrower than Number's safe-integer range.
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) invalid();
}
function expiry(now: number, duration: number): number {
  timestamp(now); const result = now + duration; timestamp(result); return result;
}
export function nativeHandoffExpiry(now: number): number { return expiry(now, NATIVE_AUTH_LIMITS.handoffMs); }
export function nativeSessionExpiry(now: number): number { return expiry(now, NATIVE_AUTH_LIMITS.sessionMs); }
export function nativeCodeExpiry(now: number, handoffExpiresAt: number): number {
  timestamp(handoffExpiresAt);
  const maximum = nativeHandoffExpiry(now);
  if (handoffExpiresAt <= now || handoffExpiresAt > maximum) invalid();
  return Math.min(expiry(now, NATIVE_AUTH_LIMITS.codeMs), handoffExpiresAt);
}
export type NativeExchangeRecord = {
  status: "pending" | "authorizing" | "ready" | "consumed" | "cancelled" | "superseded";
  handoffExpiresAt: number;
  codeExpiresAt: number;
  contextHash: string;
  familyGeneration: number;
  codeHash: string;
  handoffHash: string;
  state: string;
  codeChallenge: string;
};
function equalDigest(left: string, right: string): boolean {
  return typeof left === "string" && typeof right === "string" && /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
/** Call inside a future atomic store transaction and consume there. This pure check cannot prevent replay alone. */
export function assertNativeExchangeReady(record: NativeExchangeRecord, input: NativeExchangeInput, now: number, contextHash: string, familyGeneration: number): void {
  try {
    timestamp(now); timestamp(record.handoffExpiresAt); timestamp(record.codeExpiresAt);
    if (record.status !== "ready" || record.handoffExpiresAt <= now || record.codeExpiresAt <= now ||
        record.codeExpiresAt > record.handoffExpiresAt || record.handoffExpiresAt > nativeHandoffExpiry(now) ||
        record.codeExpiresAt > expiry(now, NATIVE_AUTH_LIMITS.codeMs) ||
        !Number.isSafeInteger(familyGeneration) || familyGeneration < 0 || record.familyGeneration !== familyGeneration ||
        !equalDigest(record.contextHash, contextHash) || !equalDigest(record.handoffHash, hashNativeHandle(input.handoff)) ||
        !equalDigest(record.codeHash, hashNativeHandle(input.code)) ||
        !equalNativeHandles(record.state, input.state) || !equalNativeHandles(record.codeChallenge, nativeS256Challenge(input.codeVerifier))) {
      throw new NativeProtocolError("unavailable_attempt");
    }
  } catch { throw new NativeProtocolError("unavailable_attempt"); }
}
