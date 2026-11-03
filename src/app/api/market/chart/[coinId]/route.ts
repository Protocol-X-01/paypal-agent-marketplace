import { NextResponse } from "next/server";
import {
  CHART_DAYS,
  getMarketChart,
  MarketDataError,
  TRACKED_COINS,
  type ChartDays,
  type TrackedCoin,
} from "@/lib/market-data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ coinId: string }> },
) {
  const { coinId } = await params;
  if (!TRACKED_COINS.includes(coinId as TrackedCoin)) {
    return NextResponse.json(
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
    return NextResponse.json(
      {
        error: {
          code: "unsupported_days",
          message: "Choose a chart range of 1, 7, 30, 90, or 365 days.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const data = await getMarketChart(coinId as TrackedCoin, days as ChartDays);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=240" },
    });
  } catch (error) {
    const unavailable = !(error instanceof MarketDataError) || error.kind === "unavailable";
    return NextResponse.json(
      {
        error: {
          code: unavailable ? "market_data_unavailable" : "upstream_invalid_response",
          message: unavailable
            ? "Market data is temporarily unavailable. Please try again shortly."
            : "The market data provider returned an unexpected response.",
        },
      },
      { status: unavailable ? 503 : 502 },
    );
  }
}
