import "server-only";

import { createHmac } from "node:crypto";

export type AuthEnvironment = "sandbox" | "live";
export type AuthConfig = {
  environment: AuthEnvironment;
  origin: string;
  clientId: string;
  clientSecret: string;
  databaseUrl: string;
  subjectHmacKey: string;
  accountAttributes: boolean;
};

export function issuerFor(environment: AuthEnvironment): string {
  return environment === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
}

/** Binds pending transactions and sessions to the complete active login context. */
export function authContextFingerprint(config: AuthConfig): string {
  const input = JSON.stringify(["paypal-markets-auth-context-v1", config.environment, issuerFor(config.environment), config.clientId, config.clientSecret, config.origin, config.accountAttributes]);
  return createHmac("sha256", Buffer.from(config.subjectHmacKey, "base64url")).update(input).digest("hex");
}

/** Never log this configuration: it contains the database and OAuth secrets. */
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  if (env.PAYPAL_LOGIN_ENABLED !== "true") return null;
  const environment = env.PAYPAL_ENV;
  if (environment !== "sandbox" && environment !== "live") return null;
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const origin = env.AUTH_PUBLIC_ORIGIN;
  const databaseUrl = env.AUTH_SESSION_DATABASE_URL;
  const subjectHmacKey = env.AUTH_SUBJECT_HMAC_KEY;
  const attributes = env.PAYPAL_LOGIN_ACCOUNT_ATTRIBUTES;
  if (!clientId || !clientSecret || !origin || !databaseUrl || !subjectHmacKey ||
      clientId.length > 1024 || clientSecret.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(clientId + clientSecret) ||
      !/^[A-Za-z0-9_-]{43,86}$/.test(subjectHmacKey) ||
      (attributes !== undefined && attributes !== "true" && attributes !== "false")) return null;
  try {
    const site = new URL(origin);
    const database = new URL(databaseUrl);
    // An origin is not a route or a trusted value taken from request headers.
    if (site.protocol !== "https:" || site.origin !== origin || site.username || site.password ||
        site.pathname !== "/" || site.search || site.hash) return null;
    // Connection-string SSL options could override the verified TLS setting.
    if (!(["postgres:", "postgresql:"].includes(database.protocol)) || !database.hostname ||
        !database.username || database.pathname === "/" || database.search || database.hash) return null;
    const keyBytes = Buffer.from(subjectHmacKey, "base64url");
    if (keyBytes.length < 32 || keyBytes.length > 64 || keyBytes.toString("base64url") !== subjectHmacKey) return null;
    return { environment, origin, clientId, clientSecret, databaseUrl, subjectHmacKey, accountAttributes: attributes === "true" };
  } catch {
    return null;
  }
}
