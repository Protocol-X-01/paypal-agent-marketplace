import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type * as oidc from "openid-client";

import { authContextFingerprint, readAuthConfig, type AuthConfig } from "./config";
import { beginAuthorization, completeAuthorization, discoverProvider } from "./provider";
import { createPostgresStore, type AuthStore } from "./store";

const SESSION_COOKIE = "__Host-paypal-markets-session";
const TRANSACTION_COOKIE = "__Host-paypal-markets-login";
const SESSION_SECONDS = 30 * 60;
const TRANSACTION_SECONDS = 5 * 60;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

type Dependencies = {
  config(): AuthConfig | null;
  store(config: AuthConfig): AuthStore;
  provider(config: AuthConfig): Promise<oidc.Configuration>;
};

function randomHandle(): string { return randomBytes(32).toString("base64url"); }
function hashHandle(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function cookieValue(request: NextRequest, name: string): string | null {
  const value = request.cookies.get(name)?.value;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value ? value : null;
}
function protect(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
function unavailable(): NextResponse {
  return protect(NextResponse.json({ error: "sign_in_unavailable" }, { status: 503 }));
}
function forbidden(): NextResponse {
  return protect(NextResponse.json({ error: "origin_not_allowed" }, { status: 403 }));
}
function clearCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}
function callbackRedirect(config: AuthConfig, success: boolean): NextResponse {
  const target = new URL("/dashboard", config.origin);
  if (!success) target.searchParams.set("auth", "failed");
  target.hash = "account";
  // A delayed callback must not clear a newer sign-in transaction cookie.
  return protect(NextResponse.redirect(target, 303));
}

function limited(handler: (request: NextRequest) => Promise<NextResponse>, maximum: number) {
  let active = 0;
  return async (request: NextRequest): Promise<NextResponse> => {
    if (active >= maximum) return unavailable();
    active += 1;
    try { return await handler(request); } finally { active -= 1; }
  };
}

/** Dependency injection is used for isolated local tests; routes use only runtime dependencies. */
export function createAuthController(dependencies: Dependencies) {
  const handlers = {
    async start(request: NextRequest): Promise<NextResponse> {
      const config = dependencies.config();
      if (!config) return unavailable();
      if (request.headers.get("origin") !== config.origin) return forbidden();
      try {
        const store = dependencies.store(config);
        if (!(await store.ready())) return unavailable();
        const provider = await dependencies.provider(config);
        const { location, transaction } = await beginAuthorization(provider, config);
        const handle = randomHandle();
        const session = cookieValue(request, SESSION_COOKIE);
        const previousTransaction = cookieValue(request, TRANSACTION_COOKIE);
        await store.createTransaction(hashHandle(handle), authContextFingerprint(config), transaction,
          session ? hashHandle(session) : null, previousTransaction ? hashHandle(previousTransaction) : null);
        const response = protect(NextResponse.redirect(location, 303));
        response.cookies.set(TRANSACTION_COOKIE, handle, { ...COOKIE_OPTIONS, maxAge: TRANSACTION_SECONDS });
        return response;
      } catch {
        return unavailable();
      }
    },

    async callback(request: NextRequest): Promise<NextResponse> {
      const config = dependencies.config();
      if (!config) return unavailable();
      const handle = cookieValue(request, TRANSACTION_COOKIE);
      if (!handle || request.nextUrl.search.length > 4096) return callbackRedirect(config, false);
      try {
        const store = dependencies.store(config);
        const transaction = await store.consumeTransaction(hashHandle(handle), authContextFingerprint(config));
        if (!transaction) return callbackRedirect(config, false);
        const provider = await dependencies.provider(config);
        const callbackUrl = new URL(`/api/auth/paypal/callback${request.nextUrl.search}`, config.origin);
        const identity = await completeAuthorization(provider, callbackUrl, transaction, config);
        const nextHandle = randomHandle();
        const previous = cookieValue(request, SESSION_COOKIE);
        await store.createSession(hashHandle(nextHandle), authContextFingerprint(config), identity,
          hashHandle(handle), previous ? hashHandle(previous) : null);
        const response = callbackRedirect(config, true);
        response.cookies.set(SESSION_COOKIE, nextHandle, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
        return response;
      } catch {
        return callbackRedirect(config, false);
      }
    },

    async session(request: NextRequest): Promise<NextResponse> {
      const config = dependencies.config();
      const handle = cookieValue(request, SESSION_COOKIE);
      if (!config) return handle ? unavailable() : protect(NextResponse.json({ authenticated: false, loginAvailable: false }));
      try {
        const store = dependencies.store(config);
        if (!(await store.ready())) return handle ? unavailable() : protect(NextResponse.json({ authenticated: false, loginAvailable: false }));
        const identity = handle ? await store.readSession(hashHandle(handle), authContextFingerprint(config)) : null;
        let loginAvailable = false;
        try { await dependencies.provider(config); loginAvailable = true; } catch { /* provider unavailable */ }
        return protect(NextResponse.json(identity ? { authenticated: true, loginAvailable, ...identity } : { authenticated: false, loginAvailable }));
      } catch {
        return handle ? unavailable() : protect(NextResponse.json({ authenticated: false, loginAvailable: false }));
      }
    },

    async logout(request: NextRequest): Promise<NextResponse> {
      const config = dependencies.config();
      if (!config) return unavailable();
      if (request.headers.get("origin") !== config.origin) return forbidden();
      const handle = cookieValue(request, SESSION_COOKIE);
      const transaction = cookieValue(request, TRANSACTION_COOKIE);
      try {
        if (handle || transaction) await dependencies.store(config).logout(
          handle ? hashHandle(handle) : null, transaction ? hashHandle(transaction) : null);
        const response = protect(new NextResponse(null, { status: 204 }));
        clearCookie(response, SESSION_COOKIE);
        clearCookie(response, TRANSACTION_COOKIE);
        return response;
      } catch {
        return unavailable();
      }
    },
  };
  // Separate limits keep public session polling from consuming logout capacity.
  return {
    start: limited(handlers.start, 8),
    callback: limited(handlers.callback, 8),
    session: limited(handlers.session, 16),
    logout: limited(handlers.logout, 4),
  };
}

let storeCache: { fingerprint: string; store: ReturnType<typeof createPostgresStore> } | null = null;
function runtimeStore(config: AuthConfig): AuthStore {
  const fingerprint = createHash("sha256").update(config.databaseUrl).digest("hex");
  if (!storeCache || storeCache.fingerprint !== fingerprint) {
    const previous = storeCache;
    storeCache = { fingerprint, store: createPostgresStore({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true } }) };
    if (previous) void previous.store.close().catch(() => {});
  }
  return storeCache.store;
}

let providerCache: { fingerprint: string; until: number; value: Promise<oidc.Configuration> } | null = null;
function runtimeProvider(config: AuthConfig): Promise<oidc.Configuration> {
  const fingerprint = createHash("sha256").update(JSON.stringify([config.environment, config.clientId, config.clientSecret])).digest("hex");
  if (providerCache && providerCache.fingerprint === fingerprint && providerCache.until > Date.now()) return providerCache.value;
  const entry = { fingerprint, until: Date.now() + 5 * 60_000, value: discoverProvider(config) };
  providerCache = entry;
  // Briefly cache failures to avoid a provider outage triggering a request storm.
  void entry.value.catch(() => { if (providerCache === entry) entry.until = Date.now() + 15_000; });
  return entry.value;
}

export const customerAuth = createAuthController({
  config: () => readAuthConfig(process.env),
  store: runtimeStore,
  provider: runtimeProvider,
});
