import { NextResponse } from "next/server";
import { getMarketOverview, MarketDataError } from "@/lib/market-data";

export async function GET() {
  try {
    const data = await getMarketOverview();
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
