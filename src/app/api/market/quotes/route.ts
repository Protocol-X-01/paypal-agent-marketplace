import { NextResponse, type NextRequest } from "next/server";
import { isMarketCurrency } from "@/lib/market-currency";
import { getMarketQuotes, MarketDataError } from "@/lib/market-data";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";

function json(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withMobileWebCors(request, NextResponse.json(body, init));
}

export async function GET(request: NextRequest) {
  if (!isAllowedApplicationOrigin(request)) {
    return json(request, { error: { code: "origin_not_allowed", message: "Request origin is not allowed." } }, { status: 403 });
  }

  const currency = new URL(request.url).searchParams.get("currency") ?? "USD";
  if (!isMarketCurrency(currency)) {
    return json(request, { error: { code: "unsupported_currency", message: "Choose a supported display currency." } }, { status: 400 });
  }

  try {
    const data = await getMarketQuotes(currency);
    return json(request, data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=240" },
    });
  } catch (error) {
    const rateLimited = error instanceof MarketDataError && (error.kind === "rate_limited" || error.status === 429);
    if (rateLimited) {
      return json(request, {
        error: {
          code: "market_data_rate_limited",
          message: "Market data requests are temporarily rate limited. Retry after the interval in the Retry-After header.",
        },
      }, {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSeconds ?? 60) },
      });
    }

    const notConfigured = error instanceof MarketDataError && error.kind === "not_configured";
    const invalidResponse = error instanceof MarketDataError && error.kind === "invalid_response";
    return json(request, {
      error: {
        code: notConfigured ? "market_data_not_configured" : invalidResponse ? "upstream_invalid_response" : "market_data_unavailable",
        message: notConfigured
          ? "Market data is not configured for this service."
          : invalidResponse
            ? "The market data provider returned an unexpected response."
            : "Market data is temporarily unavailable. Please try again shortly.",
      },
    }, { status: invalidResponse ? 502 : 503 });
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ["GET"]);
}
