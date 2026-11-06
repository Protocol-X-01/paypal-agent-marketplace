import type { InsightKind, InsightResponse, MarketInsightRequest, ReportInsightRequest } from "../contracts";

export type InsightSelection = MarketInsightRequest | ReportInsightRequest;
const MAX_RESPONSE_BYTES = 32 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const timestamp = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());

export function isSelectedInsight(value: unknown, kind: InsightKind, selection: InsightSelection): value is InsightResponse {
  if (!object(value) || value.kind !== kind || !date(value.generatedAt) || !text(value.model, 120) || !text(value.disclaimer, 2000) || !object(value.insight) || !object(value.source)) return false;
  const insight = value.insight;
  if (!text(insight.headline, 300) || !text(insight.summary, 4000) || !text(insight.caution, 2000) || !Array.isArray(insight.observations) || insight.observations.length < 1 || insight.observations.length > 5 || !insight.observations.every((item) => text(item, 1500))) return false;
  const source = value.source;
  if (!Object.entries(selection).every(([key, selected]) => source[key] === selected)) return false;
  if (kind === "market") {
    const expectedInterval = selection.days === 1 ? 30 : selection.days === 7 || selection.days === 30 ? 240 : 5760;
    return source.provider === "CoinGecko" && source.priceBasis === "candle_close" && source.rangeBasis === "candle_high_low" && source.timestampKind === "close" && source.candleIntervalMinutes === expectedInterval && date(source.retrievedAt) && Number.isInteger(source.sampleCount) && Number(source.sampleCount) >= 2 && timestamp(source.firstTimestamp) && timestamp(source.lastTimestamp) && Number(source.lastTimestamp) > Number(source.firstTimestamp) && [source.firstPrice, source.lastPrice, source.low, source.high].every(number) && Number(source.low) <= Math.min(Number(source.firstPrice), Number(source.lastPrice)) && Number(source.high) >= Math.max(Number(source.firstPrice), Number(source.lastPrice)) && (source.changePercent === null || (typeof source.changePercent === "number" && Number.isFinite(source.changePercent)));
  }
  return source.provider === "Fictional local fixture" && [source.fixtureTimestamp, source.currentStart, source.currentEnd, source.priorStart, source.priorEnd].every(date) && [source.cohortCount, source.priorActive, source.currentActive, source.retained, source.currentAttempted, source.currentCompleted, source.priorCompleted].every((item) => number(item) && Number.isInteger(item)) && [source.retention, source.completion].every((item) => item === null || (number(item) && Number(item) <= 1));
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("The summary could not be read. Please try again.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const read = async () => {
    for (;;) {
      if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      const next = await reader.read();
      if (next.done) { done = true; break; }
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("The summary could not be read. Please try again.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  };
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!done) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read may still own the lock. */ }
  }
}

export async function requestInsight(kind: InsightKind, selection: InsightSelection, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<InsightResponse> {
  const response = await fetcher(kind === "market" ? "/api/ai/market-insight" : "/api/ai/report-insight", {
    method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection), signal,
  });
  let payload: unknown;
  try { payload = await readBounded(response, signal); }
  catch (error) { if (signal.aborted) throw error; throw new Error("The summary could not be read. Please try again."); }
  if (!response.ok) {
    const retry = response.headers.get("Retry-After");
    if (response.status === 429 && retry && /^\d{1,5}$/.test(retry)) throw new Error(`Please wait ${retry} seconds before generating another summary.`);
    if (response.status === 503) throw new Error("AI assistance is unavailable in this preview. Your chart and report remain available.");
    if (response.status === 504) throw new Error("The summary took too long. Please try again shortly.");
    throw new Error("The summary is unavailable. Please try again shortly.");
  }
  if (!isSelectedInsight(payload, kind, selection)) throw new Error("The returned summary did not match this view. Please try again.");
  return payload;
}
