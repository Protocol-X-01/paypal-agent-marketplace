import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authContextFingerprint, readAuthConfig, type AuthConfig } from "./config";
import { beginAuthorization, completeAuthorization, createPayPalProvider, type CustomerAuthProvider } from "./provider";
import { buildProviderCallbackUrl, parseProviderCallbackQuery } from "./provider-callback";
import { createPostgresStore, type AuthStore } from "./store";

import { consumeAuthRequestBudget, type AuthBudgetConsumer, type AuthBudgetOperation } from "./request-budget";

const SESSION_COOKIE = "__Host-paypal-markets-session";
const TRANSACTION_COOKIE = "__Host-paypal-markets-login";
const SESSION_SECONDS = 30 * 60;
const TRANSACTION_SECONDS = 5 * 60;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

type Dependencies = {
  webAdmission?: () => boolean;
  budget?: AuthBudgetConsumer;
  config(): AuthConfig | null;
  store(config: AuthConfig): AuthStore;
  provider(config: AuthConfig): Promise<CustomerAuthProvider>;
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

/** Operator acknowledgement only; does not verify deployed edge/logging behavior. */
export function webSignInAdmissionVerified(env: NodeJS.ProcessEnv): boolean {
  return env.PAYPAL_WEB_EDGE_CONTROLS_VERIFIED === "true" && env.PAYPAL_WEB_CALLBACK_REDACTION_VERIFIED === "true";
}

/** Dependency injection is used for isolated local tests; routes use only runtime dependencies. */
export function createAuthController(dependencies: Dependencies) {
  const admissionOpen = () => { try { return dependencies.webAdmission?.() === true; } catch { return false; } };
  const admit = async (config: AuthConfig, operation: AuthBudgetOperation): Promise<NextResponse | null> => {
    try {
      const result = await (dependencies.budget ?? consumeAuthRequestBudget)(config, operation);
      if (result.allowed) return null;
      const response = protect(NextResponse.json({ error: "rate_limited" }, { status: 429 }));
      response.headers.set("Retry-After", String(result.retryAfter)); return response;
    } catch { return unavailable(); }
  };
  const budgeted = (operation: AuthBudgetOperation, handler: (request: NextRequest) => Promise<NextResponse>) => async (request: NextRequest) => {
    const config = dependencies.config();
    if (config && (operation === "web.start" || operation === "web.callback") && !admissionOpen()) {
      if (operation === "web.start" && request.headers.get("origin") !== config.origin) return forbidden();
      return operation === "web.callback" ? callbackRedirect(config, false) : unavailable();
    }
    if (config && !(operation === "web.start" && request.headers.get("origin") !== config.origin)) {
      const denied = await admit(config, operation);
      if (denied) {
        if (operation !== "web.callback") return denied;
        // Never strand provider codes/state in the browser address bar on budget failure.
        const response = callbackRedirect(config, false);
        const retry = denied.headers.get("Retry-After"); if (retry) response.headers.set("Retry-After", retry);
        return response;
      }
    }
    return handler(request);
  };
  const handlers = {
    async start(request: NextRequest): Promise<NextResponse> {
      const config = dependencies.config();
      if (!config) return unavailable();
      if (request.headers.get("origin") !== config.origin) return forbidden();
      if (!admissionOpen()) return unavailable();
      try {
        const store = dependencies.store(config);
        if (!(await store.ready())) return unavailable();
        const provider = await dependencies.provider(config);
        const { location, transaction } = await beginAuthorization(provider, config);
        if (!admissionOpen()) return unavailable();
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
      if (!admissionOpen()) return callbackRedirect(config, false);
      const handle = cookieValue(request, TRANSACTION_COOKIE);
      if (!handle) return callbackRedirect(config, false);
      try {
        const rawCallback = new URL(`/api/auth/paypal/callback${request.nextUrl.search}`, config.origin);
        const query = parseProviderCallbackQuery(rawCallback);
        const store = dependencies.store(config);
        const transaction = await store.consumeTransaction(hashHandle(handle), authContextFingerprint(config), query.get("state")!);
        if (!transaction) return callbackRedirect(config, false);
        if (!query.get("code")) return callbackRedirect(config, false);
        const provider = await dependencies.provider(config);
        const callbackUrl = buildProviderCallbackUrl(`${config.origin}/api/auth/paypal/callback`, query);
        const identity = await completeAuthorization(provider, callbackUrl, transaction, config);
        if (!admissionOpen()) return callbackRedirect(config, false);
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
        if (admissionOpen()) {
          try { await dependencies.provider(config); loginAvailable = admissionOpen(); } catch { /* provider unavailable */ }
        }
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
  const cleanCallback = (handler: (request: NextRequest) => Promise<NextResponse>) => async (request: NextRequest) => {
    const config = dependencies.config();
    if (!config) return protect(new NextResponse(null, { status: 303, headers: { Location: "/dashboard?auth=failed#account" } }));
    const response = await handler(request);
    if (response.status < 400) return response;
    const clean = callbackRedirect(config, false), retry = response.headers.get("Retry-After");
    if (retry) clean.headers.set("Retry-After", retry); return clean;
  };
  // Separate limits keep public session polling from consuming logout capacity.
  return {
    start: limited(budgeted("web.start", handlers.start), 8),
    callback: cleanCallback(limited(budgeted("web.callback", handlers.callback), 8)),
    session: limited(budgeted("web.session", handlers.session), 16),
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

let providerCache: { fingerprint: string; until: number; value: Promise<CustomerAuthProvider> } | null = null;
function runtimeProvider(config: AuthConfig): Promise<CustomerAuthProvider> {
  const fingerprint = createHash("sha256").update(JSON.stringify([config.environment, config.clientId, config.clientSecret])).digest("hex");
  if (providerCache && providerCache.fingerprint === fingerprint && providerCache.until > Date.now()) return providerCache.value;
  const entry = { fingerprint, until: Date.now() + 5 * 60_000, value: Promise.resolve(createPayPalProvider(config)) };
  providerCache = entry;
  // Briefly cache failures to avoid a provider outage triggering a request storm.
  void entry.value.catch(() => { if (providerCache === entry) entry.until = Date.now() + 15_000; });
  return entry.value;
}

export const customerAuth = createAuthController({
  webAdmission: () => webSignInAdmissionVerified(process.env),
  config: () => readAuthConfig(process.env),
  store: runtimeStore,
  provider: runtimeProvider,
});
