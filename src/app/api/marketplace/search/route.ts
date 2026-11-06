import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getChannel3Locale, search } from "@/lib/channel3";
import { takeChannel3RateLimit } from "@/lib/channel3-rate-limit";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";

const inputSchema = z.object({
  query: z.string().trim().min(2).max(120),
  limit: z.number().int().min(1).max(24).optional(),
  storefront: z.enum(["GB", "US"]).optional(),
});

const MAX_SEARCH_BODY_BYTES = 8 * 1024;
const BODY_READ_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_SEARCH_BODY_READS = 8;
const BODY_READ_RETRY_AFTER_SECONDS = 5;

const globalForSearch = globalThis as typeof globalThis & {
  __channel3SearchBodyReadsInFlight?: number;
};

function tryAcquireBodyReadSlot(): boolean {
  const inFlight = globalForSearch.__channel3SearchBodyReadsInFlight ?? 0;
  if (inFlight >= MAX_CONCURRENT_SEARCH_BODY_READS) return false;
  globalForSearch.__channel3SearchBodyReadsInFlight = inFlight + 1;
  return true;
}

function releaseBodyReadSlot(): void {
  globalForSearch.__channel3SearchBodyReadsInFlight = Math.max(
    0,
    (globalForSearch.__channel3SearchBodyReadsInFlight ?? 1) - 1,
  );
}

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "bad-request" | "timeout" | "too-large" };

function json(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withMobileWebCors(request, NextResponse.json(body, init));
}

function rejectRequest(request: NextRequest, error: string, status: number, headers?: HeadersInit) {
  try {
    const cancellation = request.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The stream may already be locked or consumed; the response still stands.
  }
  return json(request, { error }, { status, headers });
}

async function readBoundedBody(request: NextRequest): Promise<BodyReadResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, reason: "bad-request" };
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_SEARCH_BODY_BYTES) {
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
      if (byteLength > MAX_SEARCH_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }

    return { ok: true, bytes: Buffer.concat(chunks, byteLength) };
  } catch {
    return timedOut
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "bad-request" };
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function POST(request: NextRequest) {
  if (!isAllowedApplicationOrigin(request)) {
    return rejectRequest(request, "Request origin is not allowed.", 403);
  }

  if (!tryAcquireBodyReadSlot()) {
    return rejectRequest(request, "Search is temporarily busy. Please try again shortly.", 503, {
      "Cache-Control": "no-store",
      "Retry-After": String(BODY_READ_RETRY_AFTER_SECONDS),
    });
  }

  let input: z.infer<typeof inputSchema>;
  try {
    const bodyRead = await readBoundedBody(request);
    if (!bodyRead.ok) {
      if (bodyRead.reason === "too-large") {
        return rejectRequest(request, "Search request body exceeds 8 KiB.", 413);
      }
      if (bodyRead.reason === "timeout") {
        return rejectRequest(request, "Search request body timed out.", 408);
      }
      return rejectRequest(request, "Send a valid JSON search request.", 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyRead.bytes));
    } catch {
      return rejectRequest(request, "Send a valid JSON search request.", 400);
    }

    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      const invalidStorefront = parsed.error.issues.some((issue) => issue.path[0] === "storefront");
      return rejectRequest(request, invalidStorefront ? "Choose the GB or US storefront." : "Enter a search phrase between 2 and 120 characters.", 400);
    }
    input = parsed.data;
  } finally {
    // Provider latency must not hold a body-reading slot after validation.
    releaseBodyReadSlot();
  }

  const query = input.query;
  const limit = input.limit ?? 6;
  if (!takeChannel3RateLimit(request)) {
    return json(
      request,
      { error: "Search is temporarily limited. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const locale = getChannel3Locale(input.storefront);
    const result = await search({ query, limit, mode: "default", locale });
    const retrievedAt = new Date().toISOString();

    return json(
      request,
      {
        provider: "Channel3",
        storefront: locale.country,
        currency: locale.currency,
        query,
        retrievedAt,
        products: result.products.slice(0, limit),
        nextPageToken: result.next_page_token ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json(
      request,
      { error: "The product catalog is temporarily unavailable. Please try again later." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ['POST']);
}
