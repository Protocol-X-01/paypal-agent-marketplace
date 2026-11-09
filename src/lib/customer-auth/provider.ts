import "server-only";

import { createHmac } from "node:crypto";
import * as oidc from "openid-client";

import { issuerFor, type AuthConfig, type AuthEnvironment } from "./config";
import type { AccountType, CustomerIdentity, LoginTransaction } from "./store";

const MAX_PROVIDER_BYTES = 1024 * 1024;
const PROVIDER_TIMEOUT_SECONDS = 5;
const ENDPOINT_PATHS = {
  authorization_endpoint: new Set(["/signin/authorize", "/connect", "/connect/"]),
  token_endpoint: new Set(["/v1/oauth2/token", "/v1/identity/openidconnect/tokenservice"]),
  userinfo_endpoint: new Set(["/v1/oauth2/token/userinfo", "/v1/identity/openidconnect/userinfo", "/v1/identity/oauth2/userinfo"]),
  jwks_uri: new Set(["/v1/oauth2/certs"]),
} as const;

/** PayPal's documented server-side authorization-code and user-info contract. */
export type PayPalProvider = {
  protocol: "paypal-code-userinfo";
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  fetch: oidc.CustomFetch;
};

/** The OIDC shape remains for the isolated legacy metadata simulations only. */
export type CustomerAuthProvider = PayPalProvider | oidc.Configuration;

function allowedHosts(environment: AuthEnvironment): ReadonlySet<string> {
  return new Set(environment === "live"
    ? ["www.paypal.com", "api.paypal.com", "api-m.paypal.com"]
    : ["www.sandbox.paypal.com", "api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
}

function checkedUrl(value: string, environment: AuthEnvironment): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts(environment).has(url.hostname) ||
      url.username || url.password || url.port || url.hash) throw new Error("Untrusted identity endpoint");
  return url;
}

/** Fetch only trusted PayPal hosts, without redirects or an unbounded response. */
function providerFetch(environment: AuthEnvironment, transport: typeof fetch): oidc.CustomFetch {
  return async (input, init) => {
    checkedUrl(input, environment);
    const deadline = AbortSignal.timeout(PROVIDER_TIMEOUT_SECONDS * 1000);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const timedOut = () => new Error("Identity request timed out or was canceled");
    const cancelBody = (body: ReadableStream<Uint8Array> | null) => {
      try { void body?.cancel().catch(() => {}); } catch { /* Best effort only. */ }
    };
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(timedOut());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let complete = false;
    try {
      // A transport may ignore abort and resolve late; release any late body
      // without waiting for its cancellation to settle.
      const pending = Promise.resolve().then(() => {
        if (signal.aborted) throw timedOut();
        return transport(input, { ...(init as unknown as RequestInit), signal, redirect: "error", cache: "no-store" });
      }).then((response) => {
        if (signal.aborted) { cancelBody(response.body); throw timedOut(); }
        return response;
      });
      const response = await Promise.race([pending, aborted]);
      if (signal.aborted) { cancelBody(response.body); throw timedOut(); }
      const declared = response.headers.get("content-length");
      if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_PROVIDER_BYTES) {
        cancelBody(response.body);
        throw new Error("Identity response is too large");
      }
      if (!response.body) return response;
      reader = response.body.getReader();
      const activeReader = reader;
      const read = async () => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          if (signal.aborted) throw timedOut();
          const next = await activeReader.read();
          if (signal.aborted) throw timedOut();
          if (next.done) { complete = true; break; }
          if (next.value.byteLength > MAX_PROVIDER_BYTES - total) throw new Error("Identity response is too large");
          total += next.value.byteLength;
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      };
      const body = await Promise.race([read(), aborted]);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (reader) {
        if (!complete) {
          try { void reader.cancel().catch(() => {}); } catch { /* Best effort only. */ }
        }
        try { reader.releaseLock(); } catch { /* A pending read may still be unwinding. */ }
      }
    }
  };
}

function apiHostFor(environment: AuthEnvironment): string {
  return environment === "live" ? "api-m.paypal.com" : "api-m.sandbox.paypal.com";
}

/** Construct fixed endpoints from the selected PayPal environment; no discovery or caller URL is trusted. */
export function createPayPalProvider(config: AuthConfig, transport: typeof fetch = fetch): PayPalProvider {
  const issuer = issuerFor(config.environment);
  const authorizationEndpoint = checkedUrl(`${issuer}/connect`, config.environment);
  const apiOrigin = `https://${apiHostFor(config.environment)}`;
  const tokenEndpoint = checkedUrl(`${apiOrigin}/v1/oauth2/token`, config.environment);
  const userinfoEndpoint = checkedUrl(`${apiOrigin}/v1/identity/openidconnect/userinfo`, config.environment);
  if (authorizationEndpoint.pathname !== "/connect" ||
      tokenEndpoint.pathname !== "/v1/oauth2/token" ||
      userinfoEndpoint.pathname !== "/v1/identity/openidconnect/userinfo") {
    throw new Error("Unsupported PayPal endpoint configuration");
  }
  return {
    protocol: "paypal-code-userinfo",
    issuer,
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    userinfoEndpoint: userinfoEndpoint.href,
    fetch: providerFetch(config.environment, transport),
  };
}

function isPayPalProvider(provider: CustomerAuthProvider): provider is PayPalProvider {
  return "protocol" in provider && provider.protocol === "paypal-code-userinfo";
}

function checkMetadata(config: oidc.Configuration, environment: AuthEnvironment): void {
  const metadata = config.serverMetadata();
  if (metadata.issuer !== issuerFor(environment) ||
      !metadata.response_types_supported?.includes("code") ||
      !metadata.code_challenge_methods_supported?.includes("S256") ||
      !metadata.id_token_signing_alg_values_supported?.includes("RS256") ||
      !metadata.token_endpoint_auth_methods_supported?.includes("client_secret_basic")) {
    throw new Error("Identity provider metadata is unsupported");
  }
  for (const key of Object.keys(ENDPOINT_PATHS) as Array<keyof typeof ENDPOINT_PATHS>) {
    const value = metadata[key];
    if (typeof value !== "string") throw new Error("Identity endpoint is unavailable");
    const url = checkedUrl(value, environment);
    if (url.search || !ENDPOINT_PATHS[key].has(url.pathname)) throw new Error("Identity endpoint is unsupported");
    const authHost = environment === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
    if ((key === "authorization_endpoint") !== (url.hostname === authHost)) throw new Error("Identity endpoint host is unsupported");
  }
}

/** @deprecated Retained for legacy synthetic OIDC fixtures; runtime uses createPayPalProvider. */
export async function discoverProvider(config: AuthConfig, transport: typeof fetch = fetch): Promise<oidc.Configuration> {
  const provider = await oidc.discovery(
    new URL(issuerFor(config.environment)),
    config.clientId,
    { client_secret: config.clientSecret, id_token_signed_response_alg: "RS256" },
    oidc.ClientSecretBasic(config.clientSecret),
    { [oidc.customFetch]: providerFetch(config.environment, transport), timeout: PROVIDER_TIMEOUT_SECONDS },
  );
  checkMetadata(provider, config.environment);
  oidc.enableNonRepudiationChecks(provider);
  return provider;
}

export function normalizeAccountType(value: unknown): AccountType {
  if (value === "PERSONAL") return "personal";
  return value === "BUSINESS" ? "business" : "unknown";
}

export function deriveDataScope(config: AuthConfig, issuer: string, subject: string): string {
  const input = JSON.stringify(["paypal-markets-customer-data-scope-v1", config.environment, issuer, config.clientId, subject]);
  return `v1_${createHmac("sha256", Buffer.from(config.subjectHmacKey, "base64url")).update(input).digest("base64url")}`;
}

export type AuthorizationSurface = "web" | "native";

/** Fixed registered callbacks only; callers cannot supply a redirect destination. */
export function authorizationCallback(config: AuthConfig, surface: AuthorizationSurface = "web"): string {
  if (surface !== "web" && surface !== "native") throw new Error("Unsupported identity surface");
  return `${config.origin}${surface === "native" ? "/api/auth/native/paypal/callback" : "/api/auth/paypal/callback"}`;
}

export async function beginAuthorization(provider: CustomerAuthProvider, config: AuthConfig, surface: AuthorizationSurface = "web") {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const scope = config.accountAttributes ? "openid https://uri.paypal.com/services/paypalattributes" : "openid";
  if (isPayPalProvider(provider)) {
    // PayPal's published manual flow documents code/state and the confidential
    // server exchange; it does not document PKCE or an ID-token nonce.
    const location = new URL(provider.authorizationEndpoint);
    location.searchParams.set("flowEntry", "static");
    location.searchParams.set("client_id", config.clientId);
    location.searchParams.set("response_type", "code");
    location.searchParams.set("scope", scope);
    location.searchParams.set("redirect_uri", authorizationCallback(config, surface));
    location.searchParams.set("state", state);
    // Keep the current database transaction shape until its separately managed
    // schema can be migrated; these compatibility values are not sent to PayPal.
    return { location: location.href, transaction: { state, nonce, verifier } };
  }
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const location = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: authorizationCallback(config, surface),
    scope, response_type: "code", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  return { location: location.href, transaction: { state, nonce, verifier } };
}

async function completePayPalAuthorization(provider: PayPalProvider, currentUrl: URL, transaction: LoginTransaction, config: AuthConfig, surface: AuthorizationSurface): Promise<CustomerIdentity> {
  const callback = new URL(authorizationCallback(config, surface));
  if (currentUrl.origin !== callback.origin || currentUrl.pathname !== callback.pathname ||
      currentUrl.username || currentUrl.password || currentUrl.hash) throw new Error("Unexpected identity callback");
  const stateValues = currentUrl.searchParams.getAll("state");
  const codeValues = currentUrl.searchParams.getAll("code");
  const code = codeValues[0];
  if (stateValues.length !== 1 || stateValues[0] !== transaction.state || codeValues.length !== 1 ||
      !code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code) || currentUrl.searchParams.has("error")) {
    throw new Error("Unexpected identity callback parameters");
  }
  const issuerValues = currentUrl.searchParams.getAll("iss");
  if (issuerValues.length > 1 || (issuerValues.length === 1 && issuerValues[0] !== provider.issuer)) {
    throw new Error("Unexpected identity issuer");
  }

  const tokenUrl = checkedUrl(provider.tokenEndpoint, config.environment);
  const userinfoUrl = checkedUrl(provider.userinfoEndpoint, config.environment);
  if (tokenUrl.hostname !== apiHostFor(config.environment) || tokenUrl.pathname !== "/v1/oauth2/token" ||
      userinfoUrl.hostname !== apiHostFor(config.environment) || userinfoUrl.pathname !== "/v1/identity/openidconnect/userinfo") {
    throw new Error("Unsupported PayPal identity endpoint");
  }

  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback.href });
  const formEncode = (value: string) => new URLSearchParams([['value', value]]).toString().slice("value=".length);
  const basic = Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`, "utf8").toString("base64");
  const tokenResponse = await provider.fetch(tokenUrl.href, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (tokenResponse.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(tokenResponse.headers.get("content-type") ?? "")) {
    throw new Error("PayPal token exchange failed");
  }
  const tokens: unknown = await tokenResponse.json();
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("PayPal token response is invalid");
  const tokenRecord = tokens as Record<string, unknown>;
  const accessToken = tokenRecord.access_token;
  const grantedScope = tokenRecord.scope;
  if (typeof accessToken !== "string" || accessToken.length < 1 || accessToken.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(accessToken) || typeof tokenRecord.token_type !== "string" ||
      tokenRecord.token_type.toLowerCase() !== "bearer" || typeof grantedScope !== "string" ||
      grantedScope.length > 1024 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(grantedScope) ||
      !grantedScope.split(" ").includes("openid")) {
    throw new Error("PayPal token response is incomplete");
  }

  userinfoUrl.searchParams.set("schema", "openid");
  const profileResponse = await provider.fetch(userinfoUrl.href, {
    method: "GET",
    redirect: "manual",
    body: undefined,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (profileResponse.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(profileResponse.headers.get("content-type") ?? "")) {
    throw new Error("PayPal user-info request failed");
  }
  const profile: unknown = await profileResponse.json();
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("PayPal user-info response is invalid");
  const subject = (profile as Record<string, unknown>).sub;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 255) throw new Error("PayPal subject is invalid");
  return {
    accountType: normalizeAccountType((profile as Record<string, unknown>).account_type),
    dataScope: deriveDataScope(config, provider.issuer, subject),
  };
}

export async function completeAuthorization(provider: CustomerAuthProvider, currentUrl: URL, transaction: LoginTransaction, config: AuthConfig, surface: AuthorizationSurface = "web"): Promise<CustomerIdentity> {
  if (isPayPalProvider(provider)) return completePayPalAuthorization(provider, currentUrl, transaction, config, surface);
  const callback = new URL(authorizationCallback(config, surface));
  if (currentUrl.origin !== callback.origin || currentUrl.pathname !== callback.pathname ||
      currentUrl.username || currentUrl.password || currentUrl.hash) throw new Error("Unexpected identity callback");
  const tokens = await oidc.authorizationCodeGrant(provider, currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.verifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || typeof tokens.access_token !== "string") {
    throw new Error("Identity response is incomplete");
  }
  // Legacy synthetic OIDC fixtures verify the userinfo subject against the ID token.
  const profile = await oidc.fetchUserInfo(provider, tokens.access_token, claims.sub);
  return { accountType: normalizeAccountType(profile.account_type), dataScope: deriveDataScope(config, provider.serverMetadata().issuer, claims.sub) };
}
