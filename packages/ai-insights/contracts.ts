/** Client-safe contracts: no server modules, credentials or data fetching. */
export type MarketInsightRequest = {
  coinId: "bitcoin" | "ethereum" | "solana" | "chainlink" | "litecoin" | "bitcoin-cash" | "paypal-usd";
  currency: "USD" | "GBP" | "EUR" | "AED" | "AUD" | "BRL" | "CAD" | "CHF" | "CNY" | "CZK" | "DKK" | "HKD" | "HUF" | "ILS" | "INR" | "JPY" | "MXN" | "MYR" | "NOK" | "NZD" | "PHP" | "PLN" | "SEK" | "SGD" | "THB" | "TWD" | "ZAR";
  days: 1 | 7 | 30 | 90 | 365;
};

export type ReportInsightRequest = {
  days: 7 | 30;
  account: "All" | "Personal" | "Business";
  market: "All" | "US" | "UK" | "Other";
};

export type ProductDiscoveryInsightRequest = {
  query: string;
  storefront: "US" | "GB";
  products: Array<{ title: string; brand?: string }>;
};

export type Insight = { headline: string; summary: string; observations: string[]; caution: string };
export type InsightKind = "market" | "fictional-report" | "product-discovery";

export type MarketInsightSource = MarketInsightRequest & {
  provider: "CoinGecko";
  retrievedAt: string;
  sampleCount: number;
  candleIntervalMinutes: 30 | 240 | 5760;
  timestampKind: "close";
  priceBasis: "candle_close";
  rangeBasis: "candle_high_low";
  firstTimestamp: number;
  lastTimestamp: number;
  firstPrice: number;
  lastPrice: number;
  low: number;
  high: number;
  changePercent: number | null;
};

export type ReportInsightSource = ReportInsightRequest & {
  provider: "Fictional local fixture";
  fixtureTimestamp: string;
  currentStart: string;
  currentEnd: string;
  priorStart: string;
  priorEnd: string;
  cohortCount: number;
  priorActive: number;
  currentActive: number;
  retained: number;
  currentAttempted: number;
  currentCompleted: number;
  priorCompleted: number;
  retention: number | null;
  completion: number | null;
};

export type ProductDiscoveryInsightSource = {
  provider: "Displayed Channel3 result labels";
  storefront: "US" | "GB";
  productCount: number;
};

type InsightEnvelope = { generatedAt: string; model: string; insight: Insight; disclaimer: string };
export type MarketInsightResponse = InsightEnvelope & { kind: "market"; source: MarketInsightSource };
export type ReportInsightResponse = InsightEnvelope & { kind: "fictional-report"; source: ReportInsightSource };
export type ProductDiscoveryInsightResponse = InsightEnvelope & { kind: "product-discovery"; source: ProductDiscoveryInsightSource };
export type InsightResponse = MarketInsightResponse | ReportInsightResponse | ProductDiscoveryInsightResponse;
export type InsightErrorResponse = { error: { code: string; message: string } };
