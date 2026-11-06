import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./customer-auth-fixtures.mjs";
const core = load("packages/ai-insights/src/core.ts");
const { marketInsightAvailable } = load("src/lib/market-insight-availability.ts", { "../../packages/ai-insights/src/core": core });
const env = { NODE_ENV: "development", AI_INSIGHTS_LOCAL_DEMO: "true", AI_INSIGHTS_LOCAL_ORIGIN: "http://localhost:3000", AI_INSIGHTS_SHARED_STATE_DIR: "/tmp/fixture", OPENAI_API_KEY: "fictional-key" };
test("availability shares server route guard and matches actual request host", () => {
  assert.equal(marketInsightAvailable(env, "localhost:3000"), true);
  for (const override of [{ NODE_ENV: "production" }, { RENDER: "true" }, { AI_INSIGHTS_LOCAL_DEMO: "false" }, { OPENAI_API_KEY: "" }, { AI_INSIGHTS_SHARED_STATE_DIR: "" }, { AI_INSIGHTS_MODEL: "invalid model" }]) {
    assert.equal(marketInsightAvailable({ ...env, ...override }, "localhost:3000"), false);
  }
  for (const host of [null, "localhost:3001", "127.0.0.1:3000", "foreign.test", "localhost:3000,foreign.test"]) assert.equal(marketInsightAvailable(env, host), false);
});
