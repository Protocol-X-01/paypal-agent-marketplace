import test from "node:test";
import assert from "node:assert/strict";

// Run against a local development server; invalid currency is rejected before
// the route calls CoinGecko, so these checks do not consume provider requests.
const target = new URL("/api/market/quotes?currency=XYZ", process.env.MARKET_TEST_BASE_URL ?? "http://127.0.0.1:3000");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
  throw new Error("MARKET_TEST_BASE_URL must point to a local development server.");
}

const allowedOrigin = "http://localhost:8081";
const deniedOrigin = "https://example.invalid";

test("responses without Origin still vary by Origin", async () => {
  const response = await fetch(target);
  assert.equal(response.status, 400);
  assert.match(response.headers.get("vary") ?? "", /\borigin\b/i);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("an allowed mobile-web origin receives its CORS header", async () => {
  const response = await fetch(target, { headers: { Origin: allowedOrigin } });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(response.headers.get("vary") ?? "", /\borigin\b/i);
});

test("an unapproved origin is rejected without a CORS grant", async () => {
  const response = await fetch(target, { headers: { Origin: deniedOrigin } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(response.headers.get("vary") ?? "", /\borigin\b/i);
});

test("preflight accepts the configured development origin and GET", async () => {
  const response = await fetch(target, {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
});

test("preflight rejects an unapproved origin", async () => {
  const response = await fetch(target, {
    method: "OPTIONS",
    headers: { Origin: deniedOrigin, "Access-Control-Request-Method": "GET" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("vary") ?? "", /\borigin\b/i);
});
