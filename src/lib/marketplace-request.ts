const MARKETPLACE_REQUEST_TIMEOUT_MS = 15_000;

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
        // Status codes still have useful meaning when a proxy returns HTML.
        try { void response.body?.cancel().catch(() => undefined); } catch { /* Body is already unavailable. */ }
        return { response, body: null };
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
