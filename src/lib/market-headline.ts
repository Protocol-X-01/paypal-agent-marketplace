type ChartSample = { timestamp: number; value: number };

export type MarketHeadline =
  | { source: "quote"; value: number; updatedAt: string | null; retrievedAt: string | null }
  | { source: "chart"; value: number; retrievedAt: string | null; sampleAt: number | null }
  | { source: "unavailable"; value: null; retrievedAt: null };

function usableValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Keep the value and its provenance together when an overview field is missing. */
export function selectMarketHeadline(
  quoteValue: number | null | undefined,
  quoteRetrievedAt: string | null | undefined,
  chartSample: ChartSample | null | undefined,
  chartRetrievedAt: string | null | undefined,
  quoteUpdatedAt?: string | null,
): MarketHeadline {
  if (usableValue(quoteValue)) {
    return { source: "quote", value: quoteValue, updatedAt: quoteUpdatedAt ?? null, retrievedAt: quoteRetrievedAt ?? null };
  }
  if (chartSample && usableValue(chartSample.value)) {
    return {
      source: "chart",
      value: chartSample.value,
      retrievedAt: chartRetrievedAt ?? null,
      sampleAt: Number.isFinite(chartSample.timestamp) ? chartSample.timestamp : null,
    };
  }
  return { source: "unavailable", value: null, retrievedAt: null };
}
