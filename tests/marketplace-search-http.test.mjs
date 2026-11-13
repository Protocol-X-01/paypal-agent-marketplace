import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Run only against a local development server: this briefly occupies the
// two search body readers allowed for one client. Every body is invalid, so
// Channel3 is never contacted.
const endpoint = new URL("/api/marketplace/search", process.env.MARKETPLACE_TEST_BASE_URL ?? "http://127.0.0.1:3000");
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("MARKETPLACE_TEST_BASE_URL must point to a local HTTP development server.");
}

function startRequest(body, closeImmediately) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const request = http.request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, (incoming) => {
    let content = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => { content += chunk; });
    incoming.on("end", () => resolveResponse({ status: incoming.statusCode, headers: incoming.headers, content }));
    incoming.on("error", rejectResponse);
  });
  request.on("error", rejectResponse);
  request.write(body);
  if (closeImmediately) request.end();
  return { request, response };
}

test("local HTTP search returns a retryable busy response and recovers", { timeout: 10_000 }, async () => {
  assert.equal((await startRequest("{", true).response).status, 400, "the route is ready");
  const held = Array.from({ length: 2 }, () => startRequest("{", false));
  try {
    let busy;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const probe = await startRequest('{"query":"x"}', true).response;
      if (probe.status === 503) { busy = probe; break; }
      assert.equal(probe.status, 400);
      await delay(80);
    }
    assert.ok(busy, "two incomplete uploads from one client must reach the route before its read deadline");
    assert.equal(busy.headers["retry-after"], "5");
    assert.equal(busy.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(busy.content), { error: "Search is temporarily busy. Please try again shortly." });
    for (const item of held) item.request.end();
    assert.deepEqual((await Promise.all(held.map((item) => item.response))).map((item) => item.status), Array(2).fill(400));
    assert.equal((await startRequest("{", true).response).status, 400, "capacity was released");
  } finally {
    for (const item of held) item.request.destroy();
    await Promise.allSettled(held.map((item) => item.response));
  }
});
