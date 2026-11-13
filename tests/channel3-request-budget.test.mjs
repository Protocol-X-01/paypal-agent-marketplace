import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const { reserveChannel3ProviderRequest, Channel3BudgetExceededError, Channel3BudgetUnavailableError } = load("src/lib/channel3-request-budget.ts");

test("production budget requires a valid dedicated database URL before provider calls", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousUrl = process.env.CHANNEL3_BUDGET_DATABASE_URL;
  process.env.NODE_ENV = "production";
  try {
    delete process.env.CHANNEL3_BUDGET_DATABASE_URL;
    await assert.rejects(reserveChannel3ProviderRequest(), error => error instanceof Channel3BudgetUnavailableError);
    process.env.CHANNEL3_BUDGET_DATABASE_URL = "not-a-postgres-url";
    await assert.rejects(reserveChannel3ProviderRequest(), error => error instanceof Channel3BudgetUnavailableError);
    process.env.CHANNEL3_BUDGET_DATABASE_URL = "postgresql://budget:secret@db.example.invalid/paypal?sslmode=disable";
    await assert.rejects(reserveChannel3ProviderRequest(), error => error instanceof Channel3BudgetUnavailableError);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousUrl === undefined) delete process.env.CHANNEL3_BUDGET_DATABASE_URL;
    else process.env.CHANNEL3_BUDGET_DATABASE_URL = previousUrl;
  }
});


test("missing production budget stops the real Channel3 adapter before transport", async () => {
  const storefront = load("src/lib/channel3-storefront.ts");
  const safety = load("src/lib/marketplace-safety.ts");
  const priceRange = load("src/lib/marketplace-price-range.ts");
  const channel3 = load("src/lib/channel3.ts", {
    "@/lib/channel3-storefront": storefront,
    "@/lib/marketplace-safety": safety,
    "@/lib/marketplace-price-range": priceRange,
    "@/lib/channel3-request-budget": { reserveChannel3ProviderRequest, Channel3BudgetExceededError },
  });
  const previousNodeEnv = process.env.NODE_ENV;
  const previousUrl = process.env.CHANNEL3_BUDGET_DATABASE_URL;
  const previousKey = process.env.CHANNEL3_API_KEY;
  const previousBase = process.env.CHANNEL3_BASE_URL;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  process.env.NODE_ENV = "production";
  delete process.env.CHANNEL3_BUDGET_DATABASE_URL;
  process.env.CHANNEL3_API_KEY = "synthetic-key";
  process.env.CHANNEL3_BASE_URL = "https://channel3.example.invalid";
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider must not be reached"); };
  try {
    await assert.rejects(channel3.search({ query: "headphones", locale: { country: "US", currency: "USD", language: "en" } }), error => error instanceof Channel3BudgetUnavailableError);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousUrl === undefined) delete process.env.CHANNEL3_BUDGET_DATABASE_URL; else process.env.CHANNEL3_BUDGET_DATABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.CHANNEL3_API_KEY; else process.env.CHANNEL3_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.CHANNEL3_BASE_URL; else process.env.CHANNEL3_BASE_URL = previousBase;
  }
});
