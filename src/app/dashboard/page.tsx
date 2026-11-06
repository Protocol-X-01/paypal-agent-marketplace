import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { marketInsightAvailable } from "@/lib/market-insight-availability";
import MarketDashboard from "../market-dashboard";

export const metadata: Metadata = {
  title: "Market dashboard | PayPal Markets concept",
  description: "Crypto market references, chart history, manual portfolio estimates, and Channel3 product discovery in a mobile first workspace.",
};

export default function DashboardPage() {
  return <Suspense fallback={<main aria-busy="true"><p role="status">Loading your workspace…</p></main>}><DashboardWithAvailability /></Suspense>;
}

async function DashboardWithAvailability() {
  const requestHeaders = await headers();
  return <MarketDashboard aiInsightsAvailable={marketInsightAvailable(process.env, requestHeaders.get("host"))} />;
}
