export type MarketplacePriceRange = {
  minPrice?: number;
  maxPrice?: number;
};

export const MAX_MARKETPLACE_PRICE = 100_000_000;

type PriceIntent = {
  query: string;
  range: MarketplacePriceRange | null;
  error: string | null;
};

const PRICE_AMOUNT = String.raw`(?:[£$€]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:\s*(?:GBP|USD|EUR|CAD|AUD|SEK|CZK|RON))?`;
const SYMBOL_CURRENCY: Record<string, string> = { "£": "GBP", "$": "USD", "€": "EUR" };

function amountValue(token: string, currency: string): { value: number | null; error: string | null } {
  const symbol = token.match(/[£$€]/)?.[0];
  const code = token.match(/\b(GBP|USD|EUR|CAD|AUD|SEK|CZK|RON)\b/i)?.[1]?.toUpperCase();
  if ((symbol && SYMBOL_CURRENCY[symbol] !== currency) || (code && code !== currency)) {
    return { value: null, error: "The price uses a different currency from your selected storefront." };
  }

  const numeric = token.replace(/[£$€]/g, "").replace(/\b(GBP|USD|EUR|CAD|AUD|SEK|CZK|RON)\b/ig, "").replace(/,/g, "").trim();
  const value = Number(numeric);
  if (!Number.isFinite(value) || value < 0 || value > MAX_MARKETPLACE_PRICE) {
    return { value: null, error: "Enter a price between 0 and 100,000,000 in your storefront currency." };
  }
  return { value, error: null };
}

/** Extract common shopping budget phrases so the provider receives a structured price filter. */
export function parseNaturalPriceIntent(query: string, currency: string): PriceIntent {
  const patterns: Array<{ kind: "range" | "min" | "max"; expression: RegExp }> = [
    { kind: "range", expression: new RegExp(`\\bbetween\\s+(${PRICE_AMOUNT})\\s+(?:and|to|-)\\s+(${PRICE_AMOUNT})\\b`, "i") },
    { kind: "range", expression: new RegExp(`\\bfrom\\s+(${PRICE_AMOUNT})\\s+to\\s+(${PRICE_AMOUNT})\\b`, "i") },
    { kind: "max", expression: new RegExp(`\\b(?:under|below|less than|up to|at most)\\s+(${PRICE_AMOUNT})\\b`, "i") },
    { kind: "min", expression: new RegExp(`\\b(?:over|above|more than|at least)\\s+(${PRICE_AMOUNT})\\b`, "i") },
  ];

  for (const { kind, expression } of patterns) {
    const match = query.match(expression);
    if (!match) continue;
    const amounts = match.slice(1).map((token) => amountValue(token, currency));
    const amountError = amounts.find((item) => item.error)?.error;
    if (amountError) return { query, range: null, error: amountError };

    const values = amounts.map((item) => item.value as number);
    const range: MarketplacePriceRange = kind === "range"
      ? { minPrice: values[0], maxPrice: values[1] }
      : kind === "min" ? { minPrice: values[0] } : { maxPrice: values[0] };
    if (range.minPrice !== undefined && range.maxPrice !== undefined && range.minPrice > range.maxPrice) {
      return { query, range: null, error: "The minimum price must not exceed the maximum price." };
    }

    return {
      query: query.replace(match[0], " ").replace(/\s+/g, " ").trim(),
      range,
      error: null,
    };
  }

  return { query, range: null, error: null };
}

/** Intersect typed bounds with a natural-language budget. */
export function intersectPriceRanges(
  first: MarketplacePriceRange | null | undefined,
  second: MarketplacePriceRange | null | undefined,
): { range: MarketplacePriceRange | null; valid: boolean } {
  const minimums = [first?.minPrice, second?.minPrice].filter((value): value is number => value !== undefined);
  const maximums = [first?.maxPrice, second?.maxPrice].filter((value): value is number => value !== undefined);
  const minPrice = minimums.length ? Math.max(...minimums) : undefined;
  const maxPrice = maximums.length ? Math.min(...maximums) : undefined;
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) return { range: null, valid: false };
  return {
    range: minPrice === undefined && maxPrice === undefined
      ? null
      : { ...(minPrice === undefined ? {} : { minPrice }), ...(maxPrice === undefined ? {} : { maxPrice }) },
    valid: true,
  };
}

/** Parse the optional min/max fields used by the website marketplace form. */
export function parsePriceRangeInputs(
  minimumValue: string,
  maximumValue: string,
): { range: MarketplacePriceRange | undefined; error: string | null } {
  const read = (raw: string, label: string): { value?: number; error?: string } => {
    const value = raw.trim();
    if (!value) return {};
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return { error: `Enter a valid ${label} price.` };
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount > MAX_MARKETPLACE_PRICE) {
      return { error: `${label} price must be ${MAX_MARKETPLACE_PRICE.toLocaleString("en-US")} or less.` };
    }
    return { value: amount };
  };

  const minimum = read(minimumValue, "minimum");
  if (minimum.error) return { range: undefined, error: minimum.error };
  const maximum = read(maximumValue, "maximum");
  if (maximum.error) return { range: undefined, error: maximum.error };
  if (minimum.value !== undefined && maximum.value !== undefined && minimum.value > maximum.value) {
    return { range: undefined, error: "Minimum price must not exceed maximum price." };
  }
  return {
    range: minimum.value === undefined && maximum.value === undefined
      ? undefined
      : { ...(minimum.value === undefined ? {} : { minPrice: minimum.value }), ...(maximum.value === undefined ? {} : { maxPrice: maximum.value }) },
    error: null,
  };
}

export function isMarketplacePriceRange(value: unknown): value is MarketplacePriceRange | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  const keys = Object.keys(range);
  if (keys.some((key) => key !== "minPrice" && key !== "maxPrice") || keys.length === 0) return false;
  if (range.minPrice !== undefined && (typeof range.minPrice !== "number" || !Number.isFinite(range.minPrice) || range.minPrice < 0 || range.minPrice > MAX_MARKETPLACE_PRICE)) return false;
  if (range.maxPrice !== undefined && (typeof range.maxPrice !== "number" || !Number.isFinite(range.maxPrice) || range.maxPrice < 0 || range.maxPrice > MAX_MARKETPLACE_PRICE)) return false;
  return !(typeof range.minPrice === "number" && typeof range.maxPrice === "number" && range.minPrice > range.maxPrice);
}

export function samePriceRange(first: MarketplacePriceRange | null, second: MarketplacePriceRange | null): boolean {
  return first?.minPrice === second?.minPrice && first?.maxPrice === second?.maxPrice;
}

export function formatPriceRange(range: MarketplacePriceRange | null, currency: string): string | null {
  if (!range) return null;
  const format = (value: number) => {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
    catch { return `${value.toFixed(2)} ${currency}`; }
  };
  if (range.minPrice !== undefined && range.maxPrice !== undefined) return `Price filter applied · ${format(range.minPrice)}–${format(range.maxPrice)}`;
  if (range.minPrice !== undefined) return `Price filter applied · from ${format(range.minPrice)}`;
  return `Price filter applied · up to ${format(range.maxPrice as number)}`;
}
