import "server-only";
import { createHmac } from "node:crypto";
import type * as oidc from "openid-client";
import type { NativeAuthConfig } from "./native-config";
import { beginAuthorization, completeAuthorization } from "./provider";
import type { NativeAuthStore } from "./native-store";
import { NativeStoreError } from "./native-store";
import { buildNativeReturnUrl, equalNativeHandles, hashNativeHandle, isCanonicalNativeHandle, newNativeHandle, NativeProtocolError, parseNativeAuthorizeForm, parseNativeCancelBody, parseNativeExchangeBody, parseNativeHandoffBody } from "./native-protocol";

import { consumeAuthRequestBudget, type AuthBudgetConsumer, type AuthBudgetOperation } from "./request-budget";

const BASE = "/api/auth/native";
const BROWSER = "__Host-paypal-markets-native-browser";
const HANDOFF = "__Host-paypal-markets-native-handoff";
const COOKIE = "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300";
const CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com";
type Dependencies = {
  budget?: AuthBudgetConsumer;
  config(): NativeAuthConfig | null;
  store(config: NativeAuthConfig): NativeAuthStore;
  provider(config: NativeAuthConfig): Promise<oidc.Configuration>;
  begin?: typeof beginAuthorization;
  complete?: typeof completeAuthorization;
  now?: () => number;
};
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function headers(contentType?: string): Headers {
  const h = new Headers({ "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP });
  if (contentType) h.set("Content-Type", contentType); return h;
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: headers("application/json") }); }
function error(status: number, code: string): Response {
  const messages: Record<number, string> = { 400: "Invalid sign-in request.", 401: "Sign-in could not be verified.", 403: "This request is not allowed.", 409: "This sign-in attempt is unavailable.", 413: "The request is too large.", 415: "Unsupported request format.", 429: "Please wait before trying again.", 503: "Sign-in is unavailable." };
  const r = json({ error: { code, message: messages[status] ?? messages[503] } }, status);
  if (status === 429) r.headers.set("Retry-After", "60"); return r;
}
function fail(e: unknown): Response {
  if (e instanceof HttpError) return error(e.status, e.code);
  if (e instanceof NativeProtocolError) return error(400, "invalid_request");
  if (e instanceof NativeStoreError && e.code === "capacity") return error(429, "capacity_reached");
  return error(503, "sign_in_unavailable");
}
function empty(): Response { return new Response(null, { status: 204, headers: headers() }); }
function redirect(target: string): Response { const h = headers(); h.set("Location", target); return new Response(null, { status: 303, headers: h }); }
function html(body: string): Response { return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPal Markets sign-in</title><body><main>${body}</main></body></html>`, { headers: headers("text/html; charset=utf-8") }); }
function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie"); if (!raw || raw.length > 8192) return null;
  const found = raw.split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  return found[0].slice(name.length + 1);
}
function bearer(request: Request, required: boolean): string | null {
  const raw = request.headers.get("authorization");
  if (raw === null && !required) return null;
  const value = raw?.startsWith("Bearer ") ? raw.slice(7) : null;
  if (!isCanonicalNativeHandle(value)) throw new HttpError(401, "unauthorized"); return value;
}
function checkedUrl(request: Request, config: NativeAuthConfig, path: string, query = false): URL {
  const url = new URL(request.url);
  if (url.origin !== config.origin || url.pathname !== `${BASE}${path}` || url.hash || (!query && url.search)) throw new HttpError(400, "invalid_request");
  return url;
}
function exactQuery(url: URL, keys: string[], maximum = 2048): URLSearchParams {
  if (Buffer.byteLength(url.search, "utf8") > maximum) throw new HttpError(400, "invalid_request");
  const seen = new Set<string>();
  for (const [key] of url.searchParams) { if (!keys.includes(key) || seen.has(key)) throw new HttpError(400, "invalid_request"); seen.add(key); }
  return url.searchParams;
}
async function rawBody(request: Request, media: string | null, limit = 2048): Promise<string> {
  if (media && !new RegExp(`^${media.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:;\\s*charset=utf-8)?$`, "i").test(request.headers.get("content-type") ?? "")) throw new HttpError(415, "unsupported_media_type");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, "request_too_large");
  if (!request.body) return "";
  const reader = request.body.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const parts: Uint8Array[] = []; let count = 0;
    while (true) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength; if (count > limit) throw new HttpError(413, "request_too_large"); parts.push(next.value); }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); } catch { throw new HttpError(400, "invalid_request"); }
  };
  try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, "request_timeout")), 3000); })]); }
  finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
function mac(config: NativeAuthConfig, purpose: string, ...values: string[]): string {
  return createHmac("sha256", Buffer.from(config.subjectHmacKey, "base64url")).update(JSON.stringify(["paypal-markets-native-browser-v1", purpose, config.contextHash, ...values])).digest("base64url");
}
function signedBrowser(config: NativeAuthConfig, now: number): string {
  const h = newNativeHandle(), until = String(now + 300000); return `${h}.${until}.${mac(config, "cookie", h, until)}`;
}
function browserBinding(request: Request, config: NativeAuthConfig, now: number): { raw: string; handle: string } | null {
  const raw = cookie(request, BROWSER); if (!raw) return null; const parts = raw.split(".");
  if (parts.length !== 3 || !isCanonicalNativeHandle(parts[0]) || !/^\d{1,16}$/.test(parts[1])) return null;
  const until = Number(parts[1]);
  if (!Number.isSafeInteger(until) || until <= now || until > now + 300000 || !equalNativeHandles(parts[2], mac(config, "cookie", parts[0], parts[1]))) return null;
  return { raw, handle: parts[0] };
}
function limited(handler: (r: Request) => Promise<Response>, maximum: number) {
  let active = 0;
  return async (r: Request): Promise<Response> => {
    if (active >= maximum) return error(429, "busy"); active++;
    try { return await handler(r); } catch (e) { return fail(e); } finally { active--; }
  };
}

/** No HTTP dependency can provide redirect targets or identities. Runtime remains opt-in. */
export function createNativeAuthController(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const enabled = () => { const c = deps.config(); if (!c) throw new HttpError(503, "sign_in_unavailable"); return c; };
  const ready = async (c: NativeAuthConfig) => { const s = deps.store(c); if (!await s.ready()) throw new HttpError(503, "sign_in_unavailable"); return s; };
  const admit = async (config: NativeAuthConfig, operation: AuthBudgetOperation): Promise<Response | null> => {
    try {
      const result = await (deps.budget ?? consumeAuthRequestBudget)(config, operation);
      if (result.allowed) return null;
      const response = error(429, "rate_limited"); response.headers.set("Retry-After", String(result.retryAfter)); return response;
    } catch { return error(503, "sign_in_unavailable"); }
  };
  const budgeted = (operation: AuthBudgetOperation, handler: (request: Request) => Promise<Response>) => async (request: Request) => {
    const config = deps.config();
    if (config) {
      const denied = await admit(config, operation);
      if (denied) {
        if (operation !== "native.callback") return denied;
        const response = redirect(`${config.origin}${BASE}/failure`);
        const retry = denied.headers.get("Retry-After"); if (retry) response.headers.set("Retry-After", retry);
        return response;
      }
    }
    return handler(request);
  };
  const handlers = {
    async availability(request: Request) {
      const c = deps.config(); if (!c) return json({ loginAvailable: false });
      checkedUrl(request, c, "/availability");
      try {
        if (!await deps.store(c).ready()) return json({ loginAvailable: false });
        await deps.provider(c);
        return json({ loginAvailable: true });
      } catch { return json({ loginAvailable: false }); }
    },
    async handoffs(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/handoffs"); const previous = bearer(request, false);
      const input = parseNativeHandoffBody(await rawBody(request, "application/json")); const s = await ready(c);
      if (previous && !await s.readSession(hashNativeHandle(previous), c.contextHash)) throw new HttpError(401, "unauthorized");
      const h = newNativeHandle();
      try { await s.createHandoff(hashNativeHandle(h), c.contextHash, { state: input.state, challenge: input.codeChallenge, platform: input.platform }, previous ? hashNativeHandle(previous) : null); }
      catch (e) { if (e instanceof NativeStoreError && e.code === "unavailable") throw new HttpError(401, "unauthorized"); throw e; }
      return json({ handoff: h, authorizationUrl: `${c.origin}${BASE}/authorize?handoff=${h}`, expiresIn: 300 }, 201);
    },
    async authorizeGet(request: Request) {
      const c = enabled(); const params = exactQuery(checkedUrl(request, c, "/authorize", true), ["handoff"]);
      const h = params.get("handoff"); if (!isCanonicalNativeHandle(h)) throw new HttpError(400, "invalid_request");
      if (!await (await ready(c)).canStartHandoff(hashNativeHandle(h), c.contextHash)) throw new HttpError(400, "invalid_request");
      const binding = signedBrowser(c, now()); const token = mac(c, "form", binding, h);
      const r = html(`<h1>Sign in to PayPal Markets</h1><p>Continue to PayPal to sign in to the PayPal Markets application. This does not authorize payments or merchant reporting.</p><form method="post" action="${BASE}/authorize"><input type="hidden" name="handoff" value="${h}"><input type="hidden" name="formToken" value="${token}"><button type="submit">Continue to PayPal</button></form><p>Close this page and return to the app if you do not want to continue.</p>`);
      r.headers.append("Set-Cookie", `${BROWSER}=${binding}${COOKIE}`); return r;
    },
    async authorizePost(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/authorize");
      if (request.headers.get("origin") !== c.origin) throw new HttpError(403, "forbidden");
      const input = parseNativeAuthorizeForm(await rawBody(request, "application/x-www-form-urlencoded"));
      const browser = browserBinding(request, c, now());
      if (!browser || !equalNativeHandles(input.formToken, mac(c, "form", browser.raw, input.handoff))) throw new HttpError(403, "forbidden");
      const s = await ready(c); const p = await deps.provider(c);
      const auth = await (deps.begin ?? beginAuthorization)(p, c, "native");
      // Provider helper has validated metadata; independently constrain the final redirect.
      const location = new URL(auth.location), expectedHost = c.environment === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
      if (location.protocol !== "https:" || location.hostname !== expectedHost || location.port || location.username || location.password || location.hash || !["/signin/authorize", "/connect", "/connect/"].includes(location.pathname) || auth.location.length > 4096 || location.searchParams.get("redirect_uri") !== c.callback) throw new HttpError(503, "sign_in_unavailable");
      try { await s.claimHandoff(hashNativeHandle(input.handoff), c.contextHash, hashNativeHandle(browser.handle), auth.transaction); }
      catch (e) { if (e instanceof NativeStoreError && e.code === "unavailable") throw new HttpError(409, "attempt_unavailable"); throw e; }
      const r = redirect(auth.location); r.headers.append("Set-Cookie", `${HANDOFF}=${input.handoff}${COOKIE}`); return r;
    },
    async callback(request: Request) {
      const c = enabled(); const failure = () => redirect(`${c.origin}${BASE}/failure`);
      try {
        const url = checkedUrl(request, c, "/paypal/callback", true), q = exactQuery(url, ["code", "state", "error"], 4096);
        const state = q.get("state"), code = q.get("code"), providerError = q.get("error");
        if (!isCanonicalNativeHandle(state) || (code && providerError) || (!code && !providerError) || (code && (code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code))) || (providerError && providerError.length > 128)) return failure();
        const browser = browserBinding(request, c, now()), h = cookie(request, HANDOFF);
        if (!browser || !isCanonicalNativeHandle(h)) return failure();
        const s = await ready(c); const reservation = newNativeHandle();
        const stored = await s.reserveProvider(hashNativeHandle(h), c.contextHash, hashNativeHandle(browser.handle), state, hashNativeHandle(reservation));
        if (!stored || providerError) return failure();
        const p = await deps.provider(c); const identity = await (deps.complete ?? completeAuthorization)(p, new URL(`${c.callback}${url.search}`), stored.transaction, c, "native");
        const handoffCode = newNativeHandle();
        await s.completeProvider(hashNativeHandle(h), c.contextHash, hashNativeHandle(reservation), hashNativeHandle(handoffCode), identity);
        return redirect(buildNativeReturnUrl(c.links, stored.platform, handoffCode, stored.appState));
      } catch { return failure(); }
    },
    async exchange(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/exchange"); const input = parseNativeExchangeBody(await rawBody(request, "application/json"));
      const s = await ready(c), token = newNativeHandle();
      try {
        const result = await s.exchange(hashNativeHandle(input.handoff), c.contextHash, { state: input.state, verifier: input.codeVerifier, codeHash: hashNativeHandle(input.code), sessionHash: hashNativeHandle(token) });
        return json({ sessionToken: token, expiresIn: 1800, accountType: result.accountType, dataScope: result.dataScope });
      } catch (e) { if (e instanceof NativeStoreError && e.code === "unavailable") throw new HttpError(401, "unauthorized"); throw e; }
    },
    async cancel(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/cancel"); const input = parseNativeCancelBody(await rawBody(request, "application/json"));
      if (!await (await ready(c)).cancel(hashNativeHandle(input.handoff), c.contextHash, input.codeVerifier)) throw new HttpError(401, "unauthorized"); return empty();
    },
    async session(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/session"); const token = bearer(request, true)!;
      const value = await (await ready(c)).readSession(hashNativeHandle(token), c.contextHash);
      if (!value) throw new HttpError(401, "unauthorized"); return json({ authenticated: true, ...value });
    },
    async logout(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/logout"); const token = bearer(request, true)!;
      if (await rawBody(request, null, 0)) throw new HttpError(413, "request_too_large");
      if (!await (await ready(c)).logout(hashNativeHandle(token), c.contextHash)) throw new HttpError(401, "unauthorized"); return empty();
    },
    async failure(request: Request) {
      const c = enabled(); checkedUrl(request, c, "/failure");
      return html("<h1>Sign-in was not completed</h1><p>Return to PayPal Markets to cancel this attempt and try again. No payment was authorized.</p>");
    },
  };
  const cleanCallback = (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
    const config = deps.config();
    if (!config) return redirect(`${BASE}/failure`);
    const response = await handler(request);
    if (response.status < 400) return response;
    const clean = redirect(`${config.origin}${BASE}/failure`), retry = response.headers.get("Retry-After");
    if (retry) clean.headers.set("Retry-After", retry); return clean;
  };
  return { availability: limited(budgeted("native.availability", handlers.availability), 16), handoffs: limited(budgeted("native.handoffs", handlers.handoffs), 8), authorizeGet: limited(budgeted("native.authorizeGet", handlers.authorizeGet), 8), authorizePost: limited(budgeted("native.authorizePost", handlers.authorizePost), 8), callback: cleanCallback(limited(budgeted("native.callback", handlers.callback), 8)), exchange: limited(budgeted("native.exchange", handlers.exchange), 8), cancel: limited(handlers.cancel, 4), session: limited(budgeted("native.session", handlers.session), 16), logout: limited(handlers.logout, 4), failure: limited(handlers.failure, 8) };
}
