/** Reject obvious local or non-HTTPS destinations from untrusted catalog data. */
export function safeMarketplaceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const labels = hostname.split(".");
    const isAddress = hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(hostname);
    const isLocal = hostname === "localhost" || [".localhost", ".local", ".internal", ".home.arpa", ".localdomain", ".lan"].some((suffix) => hostname.endsWith(suffix));
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      isAddress || isLocal || labels.length < 2 ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** An offer may link to its listed retailer or Channel3's affiliate host. */
export function safeMarketplaceOfferUrl(value: unknown, retailerDomain: string): string | null {
  const url = safeMarketplaceUrl(value);
  if (!url) return null;
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return hostname.replace(/^www\./, "") === retailerDomain || hostname === "buy.trychannel3.com" ? url : null;
}

/** Restrict the initial image URL to Channel3's image host. */
export function safeMarketplaceImageUrl(value: unknown): string | null {
  const url = safeMarketplaceUrl(value);
  if (!url) return null;
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "") === "cdn.trychannel3.com" ? url : null;
}

export const MAX_MARKETPLACE_IMAGE_BYTES = 4 * 1024 * 1024;
const MARKETPLACE_IMAGE_TIMEOUT_MS = 10_000;
const MARKETPLACE_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

/** Fetch a bounded raster image without credentials, referrer, or redirects. */
export async function fetchMarketplaceImage(value: unknown, signal: AbortSignal): Promise<Blob> {
  const url = safeMarketplaceImageUrl(value);
  if (!url) throw new Error("Unsupported product image URL.");
  if (signal.aborted) throw new Error("Product image request was canceled.");

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), MARKETPLACE_IMAGE_TIMEOUT_MS);
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("Product image request was canceled."));
    if (controller.signal.aborted) onAbort();
    else {
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    }
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let body: ReadableStream<Uint8Array> | null = null;
  let complete = false;
  try {
    const response = await Promise.race([fetch(url, {
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }), aborted]);
    body = response.body;
    if (!response.ok || response.redirected || (response.url && !safeMarketplaceImageUrl(response.url))) {
      throw new Error("Product image is unavailable.");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!MARKETPLACE_IMAGE_TYPES.has(contentType)) throw new Error("Unsupported product image type.");
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_MARKETPLACE_IMAGE_BYTES) {
      throw new Error("Product image is too large.");
    }
    if (!body) throw new Error("Product image is empty.");
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await Promise.race([reader.read(), aborted]);
      if (done) { complete = true; break; }
      size += chunk.byteLength;
      if (size > MAX_MARKETPLACE_IMAGE_BYTES) throw new Error("Product image is too large.");
      chunks.push(chunk);
    }
    if (!size) throw new Error("Product image is empty.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Blob([bytes.buffer], { type: contentType });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onExternalAbort);
    removeAbortListener();
    if (!complete) controller.abort();
    if (reader) {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (body) void body.cancel().catch(() => undefined);
  }
}

export function marketplaceImages(value: unknown): Array<{ url: string; cleaned_url: null; is_main_image: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const image = candidate as Record<string, unknown>;
    const url = safeMarketplaceImageUrl(image.cleaned_url) ?? safeMarketplaceImageUrl(image.url);
    return url ? [{ url, cleaned_url: null, is_main_image: image.is_main_image === true }] : [];
  });
}

export function primaryMarketplaceImage(value: unknown): string | null {
  const images = marketplaceImages(value);
  return images.find((image) => image.is_main_image)?.url ?? images[0]?.url ?? null;
}

type OfferCandidate = { domain: string; url: string | null };
type ProductCandidate = { id: string; offers: readonly OfferCandidate[] };
export const VERIFIED_OFFER_LIFETIME_MS = 5 * 60 * 1000;
// This is the existing application storage boundary, not a Channel3 limit.
export const MAX_PRODUCT_ID_LENGTH = 300;

/** Keep an entire opaque identifier, or reject it; never normalize or truncate it. */
export function isUsableProductId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PRODUCT_ID_LENGTH && value.trim().length > 0 && !/\p{Cc}/u.test(value);
}

export function isFreshVerifiedOffer(verifiedAt: number, now: number): boolean {
  return Number.isFinite(verifiedAt) && Number.isFinite(now) && now >= verifiedAt && now - verifiedAt < VERIFIED_OFFER_LIFETIME_MS;
}

/** Recheck the exact product and merchant before accepting its direct or Channel3 affiliate URL. */
export function matchCurrentOffer<T extends ProductCandidate>(products: readonly T[], productId: string, retailerDomain?: string, preferredUrl?: string): { product: T | null; url: string | null } {
  if (!isUsableProductId(productId)) return { product: null, url: null };
  const product = products.find((candidate) => isUsableProductId(candidate.id) && candidate.id === productId) ?? null;
  if (!product || !retailerDomain) return { product, url: null };
  const matches = product.offers.flatMap((candidate) => {
    const url = candidate.domain === retailerDomain ? safeMarketplaceOfferUrl(candidate.url, retailerDomain) : null;
    return url ? [url] : [];
  });
  const preferred = safeMarketplaceUrl(preferredUrl);
  if (preferred && matches.includes(preferred)) return { product, url: preferred };
  const uniqueUrls = [...new Set(matches)];
  return { product, url: uniqueUrls.length === 1 ? uniqueUrls[0] : null };
}
