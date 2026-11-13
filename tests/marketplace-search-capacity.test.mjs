import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Exercise the real route with in-memory request streams and a local provider
// stand-in. No network request or provider credential is used by these tests.
const nodeRequire = createRequire(import.meta.url);
const source = await readFile(new URL("../src/app/api/marketplace/search/route.ts", import.meta.url), "utf8");
const corsSource = await readFile(new URL("../src/lib/mobile-web-cors.ts", import.meta.url), "utf8");
const priceRangeSource = await readFile(new URL("../src/lib/marketplace-price-range.ts", import.meta.url), "utf8");

function loadTypeScript(text, aliases = {}) {
  const compiled = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cjsModule = { exports: {} };
  const require = (name) => Object.hasOwn(aliases, name) ? aliases[name] : nodeRequire(name);
  new Function("exports", "require", "module", compiled)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}

const cors = loadTypeScript(corsSource, { "server-only": {} });
const priceRange = loadTypeScript(priceRangeSource);
let allowProviderRequest = true;
let searchCalls = [];
let searchImpl = async () => ({ products: [] });
const { POST } = loadTypeScript(source, {
  "@/lib/mobile-web-cors": cors,
  "@/lib/marketplace-price-range": priceRange,
  "@/lib/channel3-rate-limit": { takeChannel3RateLimit: () => allowProviderRequest },
  "@/lib/request-limits": { acquireClientSlot: () => () => {} },
  "@/lib/channel3": {
    Channel3BudgetExceededError: class Channel3BudgetExceededError extends Error {},
    Channel3TimeoutError: class Channel3TimeoutError extends Error {},
    getChannel3Locale: (storefront) => ({ country: storefront ?? "GB", currency: storefront === "US" ? "USD" : "GBP", language: "en" }),
    getChannel3CollectionId: () => undefined,
    requestedChannel3Retailer: () => null,
    search: (options) => {
      searchCalls.push(options);
      return searchImpl(options);
    },
  },
});

const endpoint = "http://127.0.0.1:3000/api/marketplace/search";
const encoder = new TextEncoder();

function request(body, extraHeaders = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "127.0.0.1:3000", ...extraHeaders },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

function heldRequest(extraHeaders = {}) {
  let controller;
  let canceled = false;
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { canceled = true; },
  });
  return { request: request(body, extraHeaders), controller, wasCanceled: () => canceled };
}

function finish(held, text = "{") {
  held.controller.enqueue(encoder.encode(text));
  held.controller.close();
}

async function rejectAll(held, pending) {
  for (const entry of held) {
    try { entry.controller.error(new Error("test cleanup")); } catch { /* already closed */ }
  }
  await Promise.allSettled(pending);
}

test("capacity rejects the ninth body, preserves CORS, and releases slots on each path", async () => {
  searchCalls = [];
  allowProviderRequest = true;
  const held = Array.from({ length: 8 }, () => heldRequest());
  const pending = held.map((item) => POST(item.request));
  let finishProvider;
  try {
    assert.ok(held.every((item) => item.request.body.locked), "all eight bodies are actively being read");

    const denied = await POST(request("{}", { Origin: "https://not-allowed.example" }));
    assert.equal(denied.status, 403, "origin checks precede capacity checks");
    assert.equal(denied.headers.get("cache-control"), "no-store");

    const excess = heldRequest({ Origin: "http://localhost:8081" });
    const busy = await POST(excess.request);
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: "Search is temporarily busy. Please try again shortly." });
    assert.equal(busy.headers.get("retry-after"), "5");
    assert.equal(busy.headers.get("cache-control"), "no-store");
    assert.equal(busy.headers.get("access-control-allow-origin"), "http://localhost:8081");
    assert.match(busy.headers.get("vary") ?? "", /\borigin\b/i);
    assert.equal(excess.wasCanceled(), true, "the rejected body is canceled without being read");
    assert.equal(searchCalls.length, 0);

    finish(held[0]);
    const malformed = await pending[0];
    assert.equal(malformed.status, 400, "malformed JSON releases a slot");
    assert.equal(malformed.headers.get("cache-control"), "no-store");

    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    searchImpl = () => {
      providerStarted();
      return new Promise((resolve) => { finishProvider = resolve; });
    };
    const providerPending = POST(request('{"query":"headphones"}'));
    await started;
    assert.equal((await POST(request("{"))).status, 400, "provider latency does not retain an upload slot");
    finishProvider({ products: [] });
    assert.equal((await providerPending).status, 200);

    held[1].controller.error(new Error("client disconnected"));
    assert.equal((await pending[1]).status, 400, "a failed stream releases its slot");
    held[2].controller.enqueue(new Uint8Array(8193));
    const oversized = await pending[2];
    assert.equal(oversized.status, 413, "an oversized stream releases its slot");
    assert.equal(oversized.headers.get("cache-control"), "no-store");
    for (const entry of held.slice(3)) finish(entry);
    assert.deepEqual((await Promise.all(pending.slice(3))).map((response) => response.status), [400, 400, 400, 400, 400]);

    const again = Array.from({ length: 8 }, () => heldRequest());
    const againPending = again.map((item) => POST(item.request));
    try {
      assert.ok(again.every((item) => item.request.body.locked), "all eight slots were recovered");
      assert.equal((await POST(request("{}"))).status, 503);
    } finally {
      await rejectAll(again, againPending);
    }
  } finally {
    finishProvider?.({ products: [] });
    await rejectAll(held, pending);
    searchImpl = async () => ({ products: [] });
  }
});

test("timed-out bodies release capacity and valid requests retain existing responses", { timeout: 10_000 }, async () => {
  searchCalls = [];
  const slow = heldRequest();
  const timedOut = await POST(slow.request);
  assert.equal(timedOut.status, 408);
  assert.equal(timedOut.headers.get("cache-control"), "no-store");

  const held = Array.from({ length: 8 }, () => heldRequest());
  const pending = held.map((item) => POST(item.request));
  try {
    assert.ok(held.every((item) => item.request.body.locked), "timeout returned its slot");
    assert.equal((await POST(request("{}"))).status, 503);
  } finally {
    await rejectAll(held, pending);
  }

  assert.equal((await POST(request('{"query":"x"}'))).status, 400);
  allowProviderRequest = false;
  const limited = await POST(request('{"query":"headphones"}'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(searchCalls.length, 0);
  allowProviderRequest = true;
  searchImpl = async () => { throw new Error("synthetic provider failure"); };
  assert.equal((await POST(request('{"query":"headphones"}'))).status, 503);
  searchImpl = async () => ({ products: [] });
  const result = await POST(request('{"query":"headphones"}'));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).provider, "Channel3");
});
