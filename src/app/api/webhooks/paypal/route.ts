import { verifyWebhook } from "@/lib/paypal";
import { acquireClientSlot } from "@/lib/request-limits";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_VERIFICATIONS = 8;
const VERIFICATION_RETRY_AFTER_SECONDS = 5;
const PAYPAL_CERT_HOSTS = new Set([
  "api.paypal.com",
  "api-m.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
]);

const TRANSMISSION_ID_PATTERN = /^(?!\d+$)\w+\S+$/;
const TRANSMISSION_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const SIGNATURE_PATTERN = /^\S+$/;

const globalForPayPalWebhook = globalThis as typeof globalThis & {
  __paypalWebhookVerificationsInFlight?: number;
};

function tryAcquireVerificationSlot(): boolean {
  const inFlight = globalForPayPalWebhook.__paypalWebhookVerificationsInFlight ?? 0;
  if (inFlight >= MAX_CONCURRENT_VERIFICATIONS) return false;
  globalForPayPalWebhook.__paypalWebhookVerificationsInFlight = inFlight + 1;
  return true;
}

function releaseVerificationSlot(): void {
  globalForPayPalWebhook.__paypalWebhookVerificationsInFlight = Math.max(
    0,
    (globalForPayPalWebhook.__paypalWebhookVerificationsInFlight ?? 1) - 1,
  );
}

interface VerificationHeaders {
  transmission_id: string;
  transmission_time: string;
  cert_url: string;
  auth_algo: string;
  transmission_sig: string;
}

type BodyReadResult =
  | { ok: true; raw: Buffer; value: unknown }
  | { ok: false; reason: "bad-request" | "timeout" | "too-large" };

function requiredHeader(
  headers: Headers,
  name: string,
  maxLength: number,
): string | null {
  const value = headers.get(name);
  if (
    value === null ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    return null;
  }
  return value;
}

function isPayPalCertificateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      PAYPAL_CERT_HOSTS.has(url.hostname.toLowerCase()) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/v1\/notifications\/certs\/[A-Za-z0-9-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function readVerificationHeaders(headers: Headers): VerificationHeaders | null {
  const transmissionId = requiredHeader(
    headers,
    "paypal-transmission-id",
    50,
  );
  const transmissionTime = requiredHeader(
    headers,
    "paypal-transmission-time",
    100,
  );
  const certUrl = requiredHeader(headers, "paypal-cert-url", 500);
  const authAlgo = requiredHeader(headers, "paypal-auth-algo", 100);
  const transmissionSig = requiredHeader(
    headers,
    "paypal-transmission-sig",
    500,
  );

  if (
    !transmissionId ||
    !TRANSMISSION_ID_PATTERN.test(transmissionId) ||
    !transmissionTime ||
    !TRANSMISSION_TIME_PATTERN.test(transmissionTime) ||
    !Number.isFinite(
      Date.parse(transmissionTime.replace("t", "T").replace(/z$/, "Z")),
    ) ||
    !certUrl ||
    !isPayPalCertificateUrl(certUrl) ||
    !authAlgo ||
    !/^[A-Za-z0-9]+$/.test(authAlgo) ||
    !transmissionSig ||
    !SIGNATURE_PATTERN.test(transmissionSig)
  ) {
    return null;
  }

  return {
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    cert_url: certUrl,
    auth_algo: authAlgo,
    transmission_sig: transmissionSig,
  };
}

async function readBoundedJson(request: Request): Promise<BodyReadResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, reason: "bad-request" };
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      return { ok: false, reason: "too-large" };
    }
    if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      return { ok: false, reason: "too-large" };
    }
  }

  if (!request.body) return { ok: false, reason: "bad-request" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, BODY_READ_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return { ok: false, reason: "timeout" };
      if (done) break;

      byteLength += value.byteLength;
      if (byteLength > MAX_WEBHOOK_BODY_BYTES) {
        // Some stream implementations never settle cancellation. Do not let
        // cleanup hold a verification slot after rejecting an oversized body.
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }

    const raw = Buffer.concat(chunks, byteLength);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    const value: unknown = JSON.parse(text);
    return { ok: true, raw, value };
  } catch {
    return timedOut
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "bad-request" };
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function jsonError(error: string, status: number, headers?: HeadersInit) {
  return Response.json({ error }, { status, headers });
}

function rejectRequest(
  request: Request,
  error: string,
  status: number,
  headers?: HeadersInit,
) {
  try {
    const cancellation = request.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The stream may already be locked or consumed; the response still stands.
  }
  return jsonError(error, status, headers);
}

export async function POST(request: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (
    !webhookId ||
    webhookId.length > 50 ||
    !/^[A-Za-z0-9]+$/.test(webhookId) ||
    !process.env.PAYPAL_CLIENT_ID ||
    !process.env.PAYPAL_CLIENT_SECRET
  ) {
    return rejectRequest(request, "webhook verification is not configured", 503);
  }

  const verificationHeaders = readVerificationHeaders(request.headers);
  if (!verificationHeaders) {
    return rejectRequest(request, "invalid PayPal headers", 400);
  }

  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return rejectRequest(request, "content type must be application/json", 415);
  }

  const releaseClientSlot = acquireClientSlot(request, "paypal-webhook-verification", 2);
  if (!releaseClientSlot) {
    return rejectRequest(
      request,
      "webhook verification is temporarily busy",
      503,
      { "Retry-After": String(VERIFICATION_RETRY_AFTER_SECONDS) },
    );
  }

  if (!tryAcquireVerificationSlot()) {
    releaseClientSlot();
    return rejectRequest(
      request,
      "webhook verification is temporarily busy",
      503,
      { "Retry-After": String(VERIFICATION_RETRY_AFTER_SECONDS) },
    );
  }

  try {
    const body = await readBoundedJson(request);
    if (!body.ok) {
      if (body.reason === "too-large") {
        return rejectRequest(request, "webhook body is too large", 413);
      }
      if (body.reason === "timeout") {
        return rejectRequest(request, "webhook body read timed out", 408);
      }
      return rejectRequest(request, "bad payload", 400);
    }

    if (
      !body.value ||
      typeof body.value !== "object" ||
      Array.isArray(body.value) ||
      typeof (body.value as Record<string, unknown>).event_type !== "string" ||
      !(body.value as Record<string, string>).event_type.trim()
    ) {
      return rejectRequest(request, "bad payload", 400);
    }

    try {
      const verification = await verifyWebhook(
        { ...verificationHeaders, webhook_id: webhookId },
        body.raw,
      );

      if (verification.verification_status !== "SUCCESS") {
        return rejectRequest(request, "verification failed", 400);
      }
    } catch {
      return rejectRequest(request, "verification service unavailable", 503);
    }

    // The current companion has no marketplace ledger or checkout. Acknowledge
    // verified deliveries without applying wallet credits or issuing payouts.
    return Response.json({ received: true, processed: false });
  } finally {
    releaseVerificationSlot();
    releaseClientSlot();
  }
}
