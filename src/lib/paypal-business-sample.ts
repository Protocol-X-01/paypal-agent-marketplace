import "server-only";

// Experimental building block, not an authenticated app endpoint. It reads at
// most the first page and returns no row contents or business metrics. A future
// caller must independently enforce merchant ownership, consent and access.
const SANDBOX_REPORT_URL = "https://api-m.sandbox.paypal.com/v1/reporting/transactions";
const PAGE_SIZE = 100;
const RESPONSE_LIMIT = 262_144;
const TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;

type InspectionFailure = "invalid-request" | "denied" | "unavailable" | "invalid-response" | "timeout";

export type PayPalFirstPageInspection =
  | {
      state: "inspection-only";
      observedTransactionDetailEntries: number;
      metrics: "unavailable";
      complete: false;
    }
  | { state: "unavailable"; reason: InspectionFailure; metrics: "unavailable"; complete: false };

function failure(reason: InspectionFailure): PayPalFirstPageInspection {
  return { state: "unavailable", reason, metrics: "unavailable", complete: false };
}

function utcSecond(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value.replace("Z", ".000Z") ? parsed : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid-response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid-response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new Error("invalid-response");
      chunks.push(part.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Inspect one sandbox response without returning provider rows or identifiers.
 * `transport` must be explicitly supplied; there is no production wiring or
 * implicit credential discovery. A first-page row count is NOT a count of
 * sales, customers, transactions, or a complete report. No pagination, date
 * boundary, sign, event identity or merchant authorization is inferred here.
 */
export async function inspectPayPalFirstPage(options: {
  start: string;
  end: string;
  accessToken: string;
  transport: typeof fetch;
}): Promise<PayPalFirstPageInspection> {
  const start = utcSecond(options.start);
  const end = utcSecond(options.end);
  const duration = start === null || end === null ? null : end - start;
  if ((duration !== 7 * DAY_MS && duration !== 30 * DAY_MS) ||
      typeof options.accessToken !== "string" || options.accessToken.length > 2048 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(options.accessToken) || typeof options.transport !== "function") {
    return failure("invalid-request");
  }

  const url = new URL(SANDBOX_REPORT_URL);
  url.search = new URLSearchParams({
    start_date: options.start,
    end_date: options.end,
    fields: "transaction_info",
    balance_affecting_records_only: "Y",
    page: "1",
    page_size: String(PAGE_SIZE),
  }).toString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, TIMEOUT_MS);
  });

  try {
    const inspect = async (): Promise<PayPalFirstPageInspection> => {
      const response = await options.transport(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${options.accessToken}` },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return failure(response.status === 401 || response.status === 403 ? "denied" : "unavailable");
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel().catch(() => {});
        return failure("invalid-response");
      }
      let payload: unknown;
      try {
        payload = await readBoundedJson(response);
      } catch {
        return failure("invalid-response");
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return failure("invalid-response");
      const rows = (payload as Record<string, unknown>).transaction_details;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE ||
          rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
        return failure("invalid-response");
      }
      return { state: "inspection-only", observedTransactionDetailEntries: rows.length, metrics: "unavailable", complete: false };
    };
    const result = await Promise.race([inspect(), timeout]);
    return controller.signal.aborted ? failure("timeout") : result;
  } catch {
    return failure(controller.signal.aborted ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timer);
  }
}
