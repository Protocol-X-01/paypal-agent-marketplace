import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Channel3TimeoutError, decodeCatalogPageToken, encodeCatalogPageToken, getChannel3CollectionId, getChannel3Locale, requestedChannel3Retailer, search } from "@/lib/channel3";
import { intersectPriceRanges, MAX_MARKETPLACE_PRICE, parseNaturalPriceIntent } from "@/lib/marketplace-price-range";
import { takeChannel3RateLimit } from "@/lib/channel3-rate-limit";
import { acquireClientSlot } from "@/lib/request-limits";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";

const inputSchema = z.object({
  query: z.string().trim().min(2).max(120),
  mode: z.enum(["default", "agentic"]).optional(),
  limit: z.number().int().min(1).max(24).optional(),
  storefront: z.enum(["GB", "US"]).optional(),
  priceRange: z.object({
    minPrice: z.number().finite().min(0).max(MAX_MARKETPLACE_PRICE).optional(),
    maxPrice: z.number().finite().min(0).max(MAX_MARKETPLACE_PRICE).optional(),
  }).strict().superRefine((range, context) => {
    if (range.minPrice === undefined && range.maxPrice === undefined) {
      context.addIssue({ code: "custom", path: ["minPrice"], message: "Provide at least one price bound." });
    }
    if (range.minPrice !== undefined && range.maxPrice !== undefined && range.minPrice > range.maxPrice) {
      context.addIssue({ code: "custom", path: ["maxPrice"], message: "Maximum price must not be below minimum price." });
    }
  }).optional(),
  pageToken: z.string().min(1).max(6144).optional(),
}).strip();

const MAX_SEARCH_BODY_BYTES = 8 * 1024;
const BODY_READ_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_SEARCH_BODY_READS = 8;
const BODY_READ_RETRY_AFTER_SECONDS = 5;
const PRICE_ONLY_PROVIDER_QUERY = "products";

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
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return withMobileWebCors(request, response);
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

  const releaseClientSlot = acquireClientSlot(request, "marketplace-search-body", 2);
  if (!releaseClientSlot) {
    return rejectRequest(request, "Search is temporarily busy. Please try again shortly.", 503, {
      "Cache-Control": "no-store",
      "Retry-After": String(BODY_READ_RETRY_AFTER_SECONDS),
    });
  }

  if (!tryAcquireBodyReadSlot()) {
    releaseClientSlot();
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
      const invalidPriceRange = parsed.error.issues.some((issue) => issue.path[0] === "priceRange");
      const invalidPageToken = parsed.error.issues.some((issue) => issue.path[0] === "pageToken");
      const invalidMode = parsed.error.issues.some((issue) => issue.path[0] === "mode");
      return rejectRequest(request, invalidStorefront ? "Choose the GB or US storefront." : invalidPriceRange ? "Enter a valid price range in your storefront currency." : invalidPageToken ? "Restart this search to load more products." : invalidMode ? "Choose quick search or Channel3-assisted search." : "Enter a search phrase between 2 and 120 characters.", 400);
    }
    input = parsed.data;
  } finally {
    // Provider latency must not hold a body-reading slot after validation.
    releaseBodyReadSlot();
    releaseClientSlot();
  }

  const query = input.query;
  const mode = input.mode ?? "default";
  const limit = input.limit ?? 6;
  let locale: ReturnType<typeof getChannel3Locale>;
  try {
    locale = getChannel3Locale(input.storefront);
  } catch {
    return json(request, { error: "The product catalog is temporarily unavailable. Please try again later." }, { status: 503 });
  }
  const intent = parseNaturalPriceIntent(query, locale.currency);
  if (intent.error) return json(request, { error: intent.error }, { status: 400 });
  const mergedPriceRange = intersectPriceRanges(input.priceRange, intent.range);
  if (!mergedPriceRange.valid) {
    return json(request, { error: "The selected price range conflicts with the budget in your search." }, { status: 400 });
  }
  const priceRange = mergedPriceRange.range;
  const retailer = requestedChannel3Retailer(query);
  if (retailer && locale.country !== retailer.storefront) {
    return json(request, { error: `${retailer.title} offers are only available in the US storefront. Switch to US to continue.` }, { status: 400 });
  }
  // Agentic search plans from the shopper's full natural-language brief. The
  // structured budget filter is still sent independently to Channel3.
  const providerQuery = mode === "agentic" ? query : intent.range ? intent.query || PRICE_ONLY_PROVIDER_QUERY : query;
  if (!takeChannel3RateLimit(request)) {
    return json(
      request,
      { error: "Search is temporarily limited. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const binding = JSON.stringify({ kind: "search", query, providerQuery, mode, priceRange, retailer: retailer?.id ?? null, collectionId: getChannel3CollectionId() ?? null, locale, limit });
    const providerToken = input.pageToken === undefined ? undefined : decodeCatalogPageToken(input.pageToken, binding);
    if (providerToken === null) return json(request, { error: "Restart this search to load more products." }, { status: 400 });
    const result = await search({ query: providerQuery, limit, mode, locale, pageToken: providerToken, ...(priceRange ? { priceRange } : {}), ...(retailer ? { retailerWebsiteId: retailer.websiteId, retailerDomain: retailer.domain } : {}) });
    if (providerToken && result.next_page_token === providerToken) throw new Error("Channel3 repeated its continuation");
    const nextPageToken = result.next_page_token ? encodeCatalogPageToken(result.next_page_token, binding) : null;
    const retrievedAt = new Date().toISOString();

    return json(
      request,
      {
        provider: "Channel3",
        storefront: locale.country,
        currency: locale.currency,
        query,
        ...(input.mode !== undefined ? { searchMode: mode } : {}),
        priceRange,
        retrievedAt,
        products: result.products.slice(0, limit),
        nextPageToken,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Channel3TimeoutError) {
      return json(
        request,
        { error: "Product search took too long. Please try again." },
        { status: 504 },
      );
    }
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
