import { NextResponse, type NextRequest } from "next/server";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";
import { isMarketCurrency } from "@/lib/market-currency";
import { takeClientRequestLimit } from "@/lib/request-limits";
import {
  CHART_DAYS,
  getMarketChart,
  MarketDataError,
  TRACKED_COINS,
  type ChartDays,
  type TrackedCoin,
} from "@/lib/market-data";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ coinId: string }> },
) {
  if (!isAllowedApplicationOrigin(request)) {
    return withMobileWebCors(request, NextResponse.json(
      { error: { code: "origin_not_allowed", message: "Request origin is not allowed." } },
      { status: 403 },
    ));
  }

  const json = (body: unknown, init?: ResponseInit) => withMobileWebCors(request, NextResponse.json(body, init));
  const { coinId } = await params;
  if (!TRACKED_COINS.includes(coinId as TrackedCoin)) {
    return json(
      {
        error: {
          code: "unsupported_coin",
          message: "Choose a supported asset from the market watchlist.",
        },
      },
      { status: 400 },
    );
  }

  const rawDays = new URL(request.url).searchParams.get("days");
  const days = rawDays === null ? 7 : Number(rawDays);
  if (!CHART_DAYS.includes(days as ChartDays)) {
    return json(
      {
        error: {
          code: "unsupported_days",
          message: "Choose a chart range of 1, 7, 30, 90, or 365 days.",
        },
      },
      { status: 400 },
    );
  }

  const currency = new URL(request.url).searchParams.get("currency") ?? "USD";
  if (!isMarketCurrency(currency)) {
    return json(
      { error: { code: "unsupported_currency", message: "Choose a supported display currency." } },
      { status: 400 },
    );
  }

  const clientBudget = takeClientRequestLimit(request, "coingecko", 12);
  if (!clientBudget.allowed) {
    return json({
      error: {
        code: "market_data_rate_limited",
        message: "Market data requests are temporarily rate limited. Retry after the interval in the Retry-After header.",
      },
    }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(clientBudget.retryAfterSeconds) } });
  }

  try {
    const data = await getMarketChart(coinId as TrackedCoin, days as ChartDays, currency);
    return json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=240" },
    });
  } catch (error) {
    const rateLimited = error instanceof MarketDataError && (error.kind === "rate_limited" || error.status === 429);
    if (rateLimited) {
      return json(
        {
          error: {
            code: "market_data_rate_limited",
            message: "Market data requests are temporarily rate limited. Retry after the interval in the Retry-After header.",
          },
        },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(error.retryAfterSeconds ?? 60),
          },
        },
      );
    }

    const notConfigured = error instanceof MarketDataError && error.kind === "not_configured";
    const invalidResponse = error instanceof MarketDataError && error.kind === "invalid_response";
    return json(
      {
        error: {
          code: notConfigured
            ? "market_data_not_configured"
            : invalidResponse
              ? "upstream_invalid_response"
              : "market_data_unavailable",
          message: notConfigured
            ? "Market data is not configured for this service."
            : invalidResponse
              ? "The market data provider returned an unexpected response."
              : "Market data is temporarily unavailable. Please try again shortly.",
        },
      },
      { status: invalidResponse ? 502 : 503 },
    );
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ["GET"]);
}
