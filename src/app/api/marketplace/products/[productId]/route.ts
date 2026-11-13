import { NextResponse, type NextRequest } from "next/server";

import { getChannel3Locale, retrieveProduct } from "@/lib/channel3";
import { isStorefront } from "@/lib/channel3-storefront";
import { takeChannel3RateLimit } from "@/lib/channel3-rate-limit";
import { safeMarketplaceOfferUrl } from "@/lib/marketplace-safety";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function json(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return withMobileWebCors(request, response);
}

export async function GET(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  if (!isAllowedApplicationOrigin(request)) {
    return json(request, { error: "Request origin is not allowed." }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  if (request.nextUrl.search.length > 256 || [...params.keys()].some(key => key !== "storefront" || params.getAll(key).length !== 1)) {
    return json(request, { error: "Choose one supported storefront." }, { status: 400 });
  }
  const storefront = params.get("storefront");
  if (!isStorefront(storefront)) {
    return json(request, { error: "Choose the GB or US storefront." }, { status: 400 });
  }

  const { productId } = await context.params;
  if (!PRODUCT_ID_PATTERN.test(productId)) {
    return json(request, { error: "Choose a valid product from the marketplace." }, { status: 400 });
  }

  if (!takeChannel3RateLimit(request)) {
    return json(request, { error: "Product checks are temporarily limited. Please wait a minute and try again." }, {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }

  try {
    const locale = getChannel3Locale(storefront);
    const product = await retrieveProduct(productId, locale);
    if (!product || product.offers.length === 0) {
      return json(request, { error: "This product is not currently listed for the selected storefront.", code: "PRODUCT_UNAVAILABLE" }, { status: 404 });
    }
    const offers = product.offers.filter(offer => safeMarketplaceOfferUrl(offer.url, offer.domain));
    if (!offers.length) {
      return json(request, { error: "A safe retailer link could not be confirmed. Please try again shortly." }, { status: 503 });
    }
    return json(request, {
      provider: "Channel3",
      storefront: locale.country,
      currency: locale.currency,
      retrievedAt: new Date().toISOString(),
      product: { ...product, offers },
    });
  } catch {
    return json(request, { error: "Current product offers could not be refreshed. Please try again shortly." }, { status: 503 });
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ["GET"]);
}
