import { CHART_DAYS, getMarketCandles, TRACKED_COINS, type ChartDays, type TrackedCoin } from "@/lib/market-data";
import { isMarketCurrency } from "@/lib/market-currency";
import { withLocalBudget } from "../../../../../packages/ai-insights/src/budget";
import { checkLocalRequest, errorResponse, generateInsight, hasExactKeys, InsightError, jsonResponse, localDemoConfig, readRequestJson } from "../../../../../packages/ai-insights/src/core";
import { marketInsightSource } from "./context";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = localDemoConfig(process.env);
    checkLocalRequest(request, config.origin);
    const raw = await readRequestJson(request);
    if (!hasExactKeys(raw, ["coinId", "currency", "days"]) || typeof raw.coinId !== "string" ||
        !TRACKED_COINS.includes(raw.coinId as TrackedCoin) || !isMarketCurrency(raw.currency) ||
        typeof raw.days !== "number" || !CHART_DAYS.includes(raw.days as ChartDays)) throw new InsightError("invalid_request", 400);
    const selection = { coinId: raw.coinId as TrackedCoin, currency: raw.currency, days: raw.days as ChartDays };
    return await withLocalBudget(config.stateDir, async () => {
      const chart = await getMarketCandles(selection.coinId, selection.days, selection.currency);
      const source = marketInsightSource(selection, chart);
      const insight = await generateInsight(config.key, config.model, "market", source);
      return jsonResponse({
        kind: "market", generatedAt: new Date().toISOString(), model: config.model, insight, source,
        disclaimer: "AI-generated commentary may be inaccurate. CoinGecko observations are historical reference data, not PayPal execution quotes or personalized investment advice.",
      });
    });
  } catch (error) { return errorResponse(error); }
}
