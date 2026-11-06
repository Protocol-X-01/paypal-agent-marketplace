import "server-only";

import { createHmac } from "node:crypto";
import * as oidc from "openid-client";

import { issuerFor, type AuthConfig, type AuthEnvironment } from "./config";
import type { AccountType, CustomerIdentity, LoginTransaction } from "./store";

const MAX_PROVIDER_BYTES = 1024 * 1024;
const ENDPOINT_PATHS = {
  authorization_endpoint: new Set(["/signin/authorize", "/connect", "/connect/"]),
  token_endpoint: new Set(["/v1/oauth2/token", "/v1/identity/openidconnect/tokenservice"]),
  userinfo_endpoint: new Set(["/v1/oauth2/token/userinfo", "/v1/identity/openidconnect/userinfo", "/v1/identity/oauth2/userinfo"]),
  jwks_uri: new Set(["/v1/oauth2/certs"]),
} as const;

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
    const response = await transport(input, { ...(init as unknown as RequestInit), redirect: "error", cache: "no-store" });
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_PROVIDER_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Identity response is too large");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let total = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); return; }
          total += next.value.byteLength;
          if (total > MAX_PROVIDER_BYTES) {
            await reader.cancel().catch(() => {});
            controller.error(new Error("Identity response is too large"));
            return;
          }
          controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      async cancel() { await reader.cancel().catch(() => {}); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
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

/** Optional transport is injected only by local synthetic tests. */
export async function discoverProvider(config: AuthConfig, transport: typeof fetch = fetch): Promise<oidc.Configuration> {
  const provider = await oidc.discovery(
    new URL(issuerFor(config.environment)),
    config.clientId,
    { client_secret: config.clientSecret, id_token_signed_response_alg: "RS256" },
    oidc.ClientSecretBasic(config.clientSecret),
    { [oidc.customFetch]: providerFetch(config.environment, transport), timeout: 5 },
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

export async function beginAuthorization(provider: oidc.Configuration, config: AuthConfig, surface: AuthorizationSurface = "web") {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const scope = config.accountAttributes ? "openid https://uri.paypal.com/services/paypalattributes" : "openid";
  const location = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: authorizationCallback(config, surface),
    scope, response_type: "code", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  return { location: location.href, transaction: { state, nonce, verifier } };
}

export async function completeAuthorization(provider: oidc.Configuration, currentUrl: URL, transaction: LoginTransaction, config: AuthConfig, surface: AuthorizationSurface = "web"): Promise<CustomerIdentity> {
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
  // The library verifies the userinfo subject against the validated ID token.
  const profile = await oidc.fetchUserInfo(provider, tokens.access_token, claims.sub);
  return { accountType: normalizeAccountType(profile.account_type), dataScope: deriveDataScope(config, provider.serverMetadata().issuer, claims.sub) };
}
