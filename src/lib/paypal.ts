import "server-only";

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
const PAYPAL_VERIFICATION_TIMEOUT_MS = 6_000;

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function accessToken(signal: AbortSignal): Promise<string> {
  const now = Date.now() / 1000;
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("paypal credentials are not configured");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`,
  ).toString("base64");

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!res.ok) throw new Error(`paypal auth failed: ${res.status}`);
  const data = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof data.access_token !== "string" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new Error("paypal auth response was invalid");
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  };
  return cachedToken.token;
}

async function call<T>(
  method: string,
  path: string,
  body: BodyInit,
  signal: AbortSignal,
): Promise<T> {
  const token = await accessToken(signal);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`paypal ${method} ${path} -> ${res.status}`);
  }
  return json as T;
}

export interface WebhookVerifyHeaders {
  transmission_id: string;
  transmission_time: string;
  cert_url: string;
  auth_algo: string;
  transmission_sig: string;
  webhook_id: string;
}

export function verifyWebhook(
  headers: WebhookVerifyHeaders,
  rawWebhookEvent: Uint8Array,
) {
  const prefix = Buffer.from(
    `${JSON.stringify(headers).slice(0, -1)},"webhook_event":`,
    "utf8",
  );
  const body = Buffer.concat([prefix, rawWebhookEvent, Buffer.from("}")]);

  return call<{ verification_status: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    body,
    AbortSignal.timeout(PAYPAL_VERIFICATION_TIMEOUT_MS),
  );
}
