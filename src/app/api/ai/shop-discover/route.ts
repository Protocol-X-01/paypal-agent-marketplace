import type { ProductDiscoveryInsightSource } from "../../../../../packages/ai-insights/contracts";
import { withLocalBudget } from "../../../../../packages/ai-insights/src/budget";
import { checkLocalRequest, errorResponse, generateInsight, jsonResponse, localDemoConfig, readRequestJson } from "../../../../../packages/ai-insights/src/core";
import { shopInsightContext } from "./context";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = localDemoConfig(process.env);
    checkLocalRequest(request, config.origin);
    const context = shopInsightContext(await readRequestJson(request));
    return await withLocalBudget(config.stateDir, async () => {
      const insight = await generateInsight(config.key, config.model, "product-discovery", context);
      const source: ProductDiscoveryInsightSource = {
        provider: "Displayed Channel3 result labels",
        storefront: context.storefront,
        productCount: context.products.length,
      };
      return jsonResponse({
        kind: "product-discovery", generatedAt: new Date().toISOString(), model: config.model, insight, source,
        disclaimer: "AI commentary is fallible and does not verify, rank, or recommend offers. The separate Channel3 cards and retailer pages are the sources for current prices, availability, payment options, and terms.",
      });
    });
  } catch (error) { return errorResponse(error); }
}
