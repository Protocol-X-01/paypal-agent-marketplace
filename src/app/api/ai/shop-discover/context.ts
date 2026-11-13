import type { ProductDiscoveryInsightRequest } from "../../../../../packages/ai-insights/contracts";
import { hasContactDetails, hasExactKeys, InsightError } from "../../../../../packages/ai-insights/src/core";

const LINK = /(?:https?:\/\/|www\.)/i;

function cleanLabel(value: string, maximum: number): string {
  return value.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cs}\p{Cf}]/gu, " ")
    .replace(/[\s\p{Z}]+/gu, " ")
    .trim()
    .slice(0, maximum)
    .trim();
}

/** Accepts only a small, untrusted preview of the public Search result labels. */
export function shopInsightContext(raw: unknown): ProductDiscoveryInsightRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hasExactKeys(raw, ["query", "storefront", "products"])) {
    throw new InsightError("invalid_request", 400);
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.query !== "string" || candidate.query.trim().length < 2 || candidate.query.length > 120 ||
      LINK.test(candidate.query) || (candidate.storefront !== "US" && candidate.storefront !== "GB") ||
      !Array.isArray(candidate.products) || candidate.products.length < 1 || candidate.products.length > 5) {
    throw new InsightError("invalid_request", 400);
  }
  const query = cleanLabel(candidate.query, 120);
  if (query.length < 2 || LINK.test(query) || hasContactDetails(query)) throw new InsightError("invalid_request", 400);
  const products = candidate.products.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !(hasExactKeys(item, ["title"]) || hasExactKeys(item, ["title", "brand"]))) {
      throw new InsightError("invalid_request", 400);
    }
    const product = item as Record<string, unknown>;
    if (typeof product.title !== "string" || product.title.trim().length === 0 || product.title.length > 180 ||
        (product.brand !== undefined && (typeof product.brand !== "string" || product.brand.length > 100))) {
      throw new InsightError("invalid_request", 400);
    }
    const title = cleanLabel(product.title, 120);
    if (!title || LINK.test(title) || hasContactDetails(title)) throw new InsightError("invalid_request", 400);
    const brand = typeof product.brand === "string" ? cleanLabel(product.brand, 80) : "";
    if (LINK.test(brand) || hasContactDetails(brand)) throw new InsightError("invalid_request", 400);
    return brand ? { title, brand } : { title };
  });
  return { query, storefront: candidate.storefront, products };
}
