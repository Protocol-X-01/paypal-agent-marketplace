import "server-only";

const DEFAULT_BASE = "https://api.trychannel3.com";

interface C3Price {
  price: number;
  compare_at_price: number | null;
  currency: string;
}

export interface C3Offer {
  url: string;
  domain: string;
  price: C3Price;
  availability: "InStock" | "OutOfStock";
  condition: "new" | "used" | null;
}

export interface C3Product {
  id: string;
  title: string;
  description: string | null;
  brands: Array<{ id: string; name: string }>;
  images: Array<{ url: string; cleaned_url: string | null; is_main_image: boolean }>;
  category: { slug: string; title: string } | null;
  colors: Array<{ hex: string; percentage: number }>;
  offers: C3Offer[];
  structured_attributes: Record<string, string[]>;
  ratings: { value: number; count: number; source_count: number } | null;
}

export interface C3SearchResponse {
  products: C3Product[];
  next_page_token?: string | null;
}

export function lowestOffer(products: C3Product[]): C3Offer | null {
  const offers = products.flatMap((p) => p.offers).filter((o) => o.availability === "InStock");
  if (!offers.length) return null;
  return offers.reduce((a, b) => (b.price.price < a.price.price ? b : a));
}

export function medianNewPrice(products: C3Product[]): number | null {
  const prices = products
    .flatMap((p) => p.offers)
    .filter((o) => o.condition !== "used" && o.availability === "InStock")
    .map((o) => o.price.price)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return (prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid]) * 100;
}

interface SearchOpts {
  query?: string;
  imageUrl?: string;
  base64Image?: string;
  limit?: number;
  includeUsed?: boolean;
  mode?: "default" | "keyword" | "agentic";
  pageToken?: string;
}

async function call(path: string, body: Record<string, unknown>): Promise<C3SearchResponse> {
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) throw new Error("Channel3 is not configured");

  const base = process.env.CHANNEL3_BASE_URL ?? DEFAULT_BASE;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new Error("Channel3 base URL is invalid");
  }
  if (baseUrl.protocol !== "https:") throw new Error("Channel3 base URL must use HTTPS");
  const endpoint = new URL(path.replace(/^\/+/, ""), `${baseUrl.toString().replace(/\/+$/, "")}/`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Channel3 request failed (${res.status})`);
  }
  return (await res.json()) as C3SearchResponse;
}

function filters(includeUsed?: boolean) {
  if (!includeUsed) return undefined;
  return {
    conditions: ["new", "used"],
    availability: ["InStock", "OutOfStock"],
  };
}

export function search(opts: SearchOpts) {
  const { imageUrl, base64Image, pageToken, ...rest } = opts;
  return call("/v1/search", {
    query: rest.query,
    image_url: imageUrl,
    base64_image: base64Image,
    page_token: pageToken,
    limit: rest.limit,
    config: {
      mode: rest.mode ?? "default",
      language: process.env.CHANNEL3_LANGUAGE || undefined,
      country: process.env.CHANNEL3_COUNTRY || undefined,
      currency: process.env.CHANNEL3_CURRENCY || undefined,
    },
    ...(rest.includeUsed ? { filters: filters(true) } : {}),
  });
}
