import type { Metadata } from "next";
import MarketDashboard from "../market-dashboard";

export const metadata: Metadata = {
  title: "Market dashboard | PayPal Markets concept",
  description: "Crypto market references, chart history, manual portfolio estimates, and Channel3 product discovery in a mobile first workspace.",
};

export default function DashboardPage() {
  return <MarketDashboard />;
}
