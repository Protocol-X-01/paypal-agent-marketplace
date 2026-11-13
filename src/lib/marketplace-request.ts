const MARKETPLACE_REQUEST_TIMEOUT_MS = 15_000;
export const MARKETPLACE_SEARCH_TIMEOUT_MS = 25_000;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export class MarketplaceRequestTimeoutError extends Error {
  constructor() {
    super("The shop request took too long. Please try again.");
    this.name = "MarketplaceRequestTimeoutError";
  }
}

function abortError(): Error {
  const error = new Error("The shop request was cancelled.");
  error.name = "AbortError";
  return error;
}

/** Read only the small, known product-unavailable marker from a JSON 404. */
async function readProductUnavailable(response: Response): Promise<{ code: "PRODUCT_UNAVAILABLE" } | null> {
  const discard = () => {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* Body is already unavailable. */ }
  };
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const declared = response.headers.get("content-length");
  if (response.status !== 404 || contentType !== "application/json" || !response.body ||
      (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_ERROR_BODY_BYTES))) {
    discard();
    return null;
  }

  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_ERROR_BODY_BYTES);
  let used = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      if (value.byteLength > MAX_ERROR_BODY_BYTES - used) return null;
      bytes.set(value, used);
      used += value.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      "code" in parsed && parsed.code === "PRODUCT_UNAVAILABLE" && "error" in parsed && typeof parsed.error === "string"
      ? { code: "PRODUCT_UNAVAILABLE" }
      : null;
  } catch {
    return null;
  } finally {
    if (!finished) {
      try { void reader.cancel().catch(() => undefined); } catch { /* Body is already unavailable. */ }
    }
    try { reader.releaseLock(); } catch { /* A cancelled stream may still be settling. */ }
  }
}

/** Bound both the response and its body without confusing a timeout with a region change. */
export async function fetchMarketplaceJson(
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = MARKETPLACE_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: unknown }> {
  if (signal.aborted) throw abortError();

  // Keep the caller's controller separate: its aborted flag fences stale
  // storefront results, whereas an internal timeout must reach the UI.
  const request = new AbortController();
  let onAbort: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError());
      request.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new MarketplaceRequestTimeoutError());
      request.abort();
    }, timeoutMs);
  });

  try {
    const operation = (async () => {
      const response = await fetch(input, { ...init, cache: "no-store", signal: request.signal });
      if (request.signal.aborted) throw abortError();

      if (!response.ok) {
        // Preserve the explicit marker while leaving legacy HTML 404s usable.
        const body = await readProductUnavailable(response);
        if (request.signal.aborted) throw abortError();
        return { response, body };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("The shop returned an unreadable response. Please try again.");
      }
      if (request.signal.aborted) throw abortError();
      return { response, body };
    })();

    return await Promise.race([operation, cancellation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
