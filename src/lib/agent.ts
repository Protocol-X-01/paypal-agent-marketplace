import "server-only";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { search, medianNewPrice, type C3Product } from "@/lib/channel3";

export const AGENT_SYSTEM_PROMPT = `You help with read-only Channel3 product discovery and retail price context. You cannot access a wallet, approve purchases, or make payments.`;

export async function buyerTools(): Promise<ToolSet> {
  return {
    search_catalog: tool({
      description:
        "Search millions of retail products via Channel3. Use for: finding products for the shopping list, and for pricing comps when the owner wants to sell something.",
      inputSchema: z.object({
        query: z.string().optional(),
        base64Image: z.string().optional(),
        includeUsed: z
          .boolean()
          .optional()
          .describe("if true, include used/out-of-stock offers for comps pricing"),
      }),
      execute: async ({ query, base64Image, includeUsed }): Promise<C3Product[]> => {
        const res = await search({ query, base64Image, includeUsed, limit: 10 });
        return res.products;
      },
    }),

    suggested_market_price: tool({
      description:
        "Given comparable retail products, compute a suggested price in cents for a used listing (percentage of retail suggested by depreciation).",
      inputSchema: z.object({
        products: z
          .array(z.custom<C3Product>())
          .max(30)
          .describe("products returned by search_catalog"),
        depreciation: z.number().min(0).max(1).optional(),
      }),
      execute: async ({ products, depreciation }): Promise<{ suggested_cents: number | null; retail_median_cents: number | null }> => {
        const retail = medianNewPrice(products);
        if (retail === null) return { suggested_cents: null, retail_median_cents: null };
        const dep = depreciation ?? 0.4;
        return { suggested_cents: Math.round(retail * (1 - dep)), retail_median_cents: retail };
      },
    }),

  };
}
