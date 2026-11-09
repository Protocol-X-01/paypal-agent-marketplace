import type { ReportInsightRequest } from "../../../../../../../packages/ai-insights/contracts";
import { withLocalBudget } from "../../../../../../../packages/ai-insights/src/budget";
import { checkLocalRequest, errorResponse, generateInsight, hasExactKeys, InsightError, jsonResponse, localDemoConfig, readRequestJson } from "../../../../../../../packages/ai-insights/src/core";
import { fictionalReportSource } from "./context";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = localDemoConfig(process.env);
    checkLocalRequest(request, config.origin);
    const raw = await readRequestJson(request);
    if (!hasExactKeys(raw, ["days", "account", "market"]) || (raw.days !== 7 && raw.days !== 30) ||
        typeof raw.account !== "string" || !["All", "Personal", "Business"].includes(raw.account) ||
        typeof raw.market !== "string" || !["All", "US", "UK", "Other"].includes(raw.market)) throw new InsightError("invalid_request", 400);
    const selection = raw as ReportInsightRequest;
    return await withLocalBudget(config.stateDir, async () => {
      const source = fictionalReportSource(selection);
      const insight = await generateInsight(config.key, config.model, "fictional-report", source);
      return jsonResponse({
        kind: "fictional-report", generatedAt: new Date().toISOString(), model: config.model, insight, source,
        disclaimer: "This is an AI-generated explanation of invented fixture data. It does not show PayPal customers, staff access, business conditions, or payment authority.",
      });
    });
  } catch (error) { return errorResponse(error); }
}
