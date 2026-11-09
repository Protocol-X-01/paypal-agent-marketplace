import { NextResponse, type NextRequest } from "next/server";
import { handleMobileWebPreflight, isAllowedApplicationOrigin, withMobileWebCors } from "@/lib/mobile-web-cors";
import { isMarketCurrency } from "@/lib/market-currency";
import { CHART_DAYS, getMarketCandles, MarketDataError, TRACKED_COINS, type ChartDays, type TrackedCoin } from "@/lib/market-data";
import { takeClientRequestLimit } from "@/lib/request-limits";

export async function GET(request: NextRequest, { params }: { params: Promise<{ coinId: string }> }) {
  const json = (body: unknown, init?: ResponseInit) => withMobileWebCors(request, NextResponse.json(body, init));
  const invalid = (code: string, message: string, status = 400, headers: Record<string, string> = {}) => json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
  if (!isAllowedApplicationOrigin(request)) return invalid("origin_not_allowed", "Request origin is not allowed.", 403);
  const { coinId } = await params;
  if (!TRACKED_COINS.includes(coinId as TrackedCoin)) return invalid("unsupported_coin", "Choose a supported asset from the market watchlist.");
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !["days", "currency"].includes(key)) || query.getAll("days").length > 1 || query.getAll("currency").length > 1) {
    return invalid("unsupported_parameters", "Use days and currency at most once each.");
  }
  const rawDays = query.get("days") ?? "7";
  if (!/^(1|7|30|90|365)$/.test(rawDays) || !CHART_DAYS.includes(Number(rawDays) as ChartDays)) {
    return invalid("unsupported_days", "Choose a candle range of 1, 7, 30, 90, or 365 days.");
  }
  const currency = query.get("currency") ?? "USD";
  if (!isMarketCurrency(currency)) return invalid("unsupported_currency", "Choose a supported display currency.");
  const clientBudget = takeClientRequestLimit(request, "coingecko", 12);
  if (!clientBudget.allowed) return invalid("market_data_rate_limited", "Market data requests are temporarily rate limited.", 429,
    { "Retry-After": String(clientBudget.retryAfterSeconds) });
  try {
    return json(await getMarketCandles(coinId as TrackedCoin, Number(rawDays) as ChartDays, currency), {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=240" },
    });
  } catch (error) {
    if (error instanceof MarketDataError && (error.kind === "rate_limited" || error.status === 429)) {
      return json({ error: { code: "market_data_rate_limited", message: "Market data requests are temporarily rate limited. Retry after the interval in the Retry-After header." } }, {
        status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSeconds ?? 60) },
      });
    }
    const missing = error instanceof MarketDataError && error.kind === "not_configured";
    const malformed = error instanceof MarketDataError && error.kind === "invalid_response";
    return invalid(missing ? "market_data_not_configured" : malformed ? "upstream_invalid_response" : "market_data_unavailable",
      missing ? "Market data is not configured for this service." : malformed ? "The market data provider returned an unexpected response." : "Candle history is temporarily unavailable. Please try again shortly.", malformed ? 502 : 503);
  }
}

export function OPTIONS(request: NextRequest) {
  return handleMobileWebPreflight(request, ["GET"]);
}
