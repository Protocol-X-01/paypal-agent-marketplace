import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { load } from "./customer-auth-fixtures.mjs";

const core = load("packages/ai-insights/src/core.ts");
const budget = load("packages/ai-insights/src/budget.ts", { "./core": core });
const assets = load("src/lib/market-assets.ts");
const currencies = load("src/lib/market-currency.ts");
const managementData = load("apps/management/src/lib/management-data.ts");
const marketContext = load("src/app/api/ai/market-insight/context.ts", { "../../../../../packages/ai-insights/src/core": core });
const reportContext = load("apps/management/src/app/api/ai/report-insight/context.ts", { "../../../../lib/management-data": managementData });
const exampleInsight = { headline: "A measured movement", summary: "The observed price moved across the selected period.", observations: ["The range reflects the supplied observations."], caution: "Past movement does not predict future results." };
const asResponse = (value = exampleInsight) => ({ status: "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
const statusIs = (status) => (error) => error instanceof core.InsightError && error.status === status;
const fakeConfig = { NODE_ENV: "development", AI_INSIGHTS_LOCAL_DEMO: "true", AI_INSIGHTS_LOCAL_ORIGIN: "http://localhost:3000", AI_INSIGHTS_SHARED_STATE_DIR: "/tmp/fictional-insight-state", OPENAI_API_KEY: "fictional-key" };

test("local opt-in and canonical origin fail closed for hosted, foreign or disabled requests", () => {
  assert.equal(core.localDemoConfig(fakeConfig).model, "gpt-6-luna");
  assert.equal(core.localDemoConfig({ ...fakeConfig, AI_INSIGHTS_LOCAL_ORIGIN: "http://127.0.0.1:3002" }).origin, "http://127.0.0.1:3002");
  assert.equal(core.localDemoConfig({ ...fakeConfig, AI_INSIGHTS_MODEL: "custom-model" }).model, "custom-model");
  for (const override of [
    { NODE_ENV: "production" }, { AI_INSIGHTS_LOCAL_DEMO: "false" }, { RENDER: "true" }, { VERCEL: "1" },
    { OPENAI_API_KEY: "" }, { AI_INSIGHTS_LOCAL_ORIGIN: "https://localhost:3000" },
    { AI_INSIGHTS_LOCAL_ORIGIN: "http://localhost.example.test:3000" }, { AI_INSIGHTS_LOCAL_ORIGIN: "http://localhost:3000/path" },
    { AI_INSIGHTS_LOCAL_ORIGIN: "http://127.0.0.1:3000/" }, { AI_INSIGHTS_MODEL: "bad model" },
  ]) assert.throws(() => core.localDemoConfig({ ...fakeConfig, ...override }), statusIs(503));
  const request = (origin, host, site = "same-origin") => new Request("http://localhost:3000/api/ai/market-insight", { method: "POST", headers: { origin, host, "content-type": "application/json", "sec-fetch-site": site }, body: "{}" });
  assert.doesNotThrow(() => core.checkLocalRequest(request("http://localhost:3000", "localhost:3000"), fakeConfig.AI_INSIGHTS_LOCAL_ORIGIN));
  for (const bad of [request("http://foreign.test", "localhost:3000"), request("http://localhost:3000", "foreign.test"), request("http://localhost:3000", "localhost:3000", "cross-site")]) {
    assert.throws(() => core.checkLocalRequest(bad, fakeConfig.AI_INSIGHTS_LOCAL_ORIGIN), statusIs(403));
  }
});

test("numeric loopback requests survive Next URL normalization without widening Origin or Host", () => {
  const origin = "http://127.0.0.1:3002";
  const make = (url, requestOrigin = origin, host = "127.0.0.1:3002") => new Request(url, { method: "POST", headers: { origin: requestOrigin, host, "content-type": "application/json" }, body: "{}" });
  assert.doesNotThrow(() => core.checkLocalRequest(make("http://localhost:3002/api/ai/report-insight"), origin));
  assert.doesNotThrow(() => core.checkLocalRequest(make("http://127.0.0.1:3002/api/ai/report-insight"), origin));
  for (const bad of [
    make("http://localhost:3003/api/ai/report-insight"),
    make("http://localhost:3002/api/ai/report-insight", "http://localhost:3002"),
    make("http://localhost:3002/api/ai/report-insight", origin, "localhost:3002"),
    make("http://127.0.0.2:3002/api/ai/report-insight"),
    make("http://foreign.test:3002/api/ai/report-insight"),
  ]) assert.throws(() => core.checkLocalRequest(bad, origin), statusIs(403));
});

test("Responses request is bounded, stateless, tool-free and contains only supplied source context", async () => {
  const source = { provider: "CoinGecko", coinId: "bitcoin", currency: "USD", days: 7, firstPrice: 10, lastPrice: 11 };
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fictional-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.max_output_tokens, 512);
    assert.equal(body.tools, undefined);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(JSON.parse(body.input[1].content), source);
    assert.doesNotMatch(init.body, /fictional-key|private holdings|customer record/i);
    return Response.json(asResponse());
  };
  assert.deepEqual(await core.generateInsight("fictional-key", "gpt-6-luna", "market", source, fakeFetch), exampleInsight);
  assert.equal(calls, 1);
});

test("refusals, incomplete responses, tools, malformed text and extra output fields fail closed", () => {
  for (const bad of [
    { status: "incomplete", output: [] },
    { status: "completed", output: [{ type: "function_call" }] },
    { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] },
    asResponse({ ...exampleInsight, leaked: "fictional secret" }),
    asResponse({ ...exampleInsight, summary: "It rose 900 percent." }),
    asResponse({ ...exampleInsight, observations: [] }),
    asResponse({ ...exampleInsight, headline: "<unsafe>" }),
  ]) assert.throws(() => core.parseResponsesResult(bad), statusIs(502));
});

test("request and provider bounds reject oversized, malformed and nonsettling bodies without leaking errors", async () => {
  const exact = new TextEncoder().encode(`\"${"x".repeat(4094)}\"`);
  const exactStream = new ReadableStream({ start(controller) { controller.enqueue(exact); controller.close(); } });
  assert.equal((await core.readBoundedJson(exactStream, "4096", 4096, 100, "request_timeout")).length, 4094);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); controller.close(); } });
  await assert.rejects(core.readBoundedJson(oversized, null, 4096, 100, "request_timeout"), statusIs(413));
  const malformed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
  await assert.rejects(core.readBoundedJson(malformed, null, 4096, 100, "request_timeout"), statusIs(400));
  const stuck = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
  await assert.rejects(core.readBoundedJson(stuck, null, 4096, 20, "request_timeout"), statusIs(504));
  await assert.rejects(core.generateInsight("fictional-key", "gpt-6-luna", "market", {}, async () => new Promise(() => {}), 20), statusIs(504));
  await assert.rejects(core.generateInsight("fictional-key", "gpt-6-luna", "market", {}, async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), 20), statusIs(504));
  await assert.rejects(core.generateInsight("fictional-key", "gpt-6-luna", "market", {}, async () => new Response("fictional-secret", { status: 401 })), statusIs(503));
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262145)); controller.close(); } });
  await assert.rejects(core.generateInsight("fictional-key", "gpt-6-luna", "market", {}, async () => new Response(huge)), statusIs(502));
  const response = core.errorResponse(new core.InsightError("insights_unavailable", 503));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await response.text(), /fictional-secret|fictional-key/);
});

test("shared on-disk budget holds one in-flight request and counts failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-insight-budget-"));
  const now = 1_700_000_000_000;
  try {
    let release, reached;
    const waiting = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { reached = resolve; });
    const first = budget.withLocalBudget(directory, async () => { reached(); await waiting; return "done"; }, now);
    await started;
    await assert.rejects(budget.withLocalBudget(directory, async () => "must not run", now), statusIs(429));
    release(); assert.equal(await first, "done");
    await assert.rejects(budget.withLocalBudget(directory, async () => { throw new Error("synthetic failure"); }, now + 1), statusIs(503));
    await assert.rejects(budget.withLocalBudget(directory, async () => "must not run", now + 2), statusIs(429));
    assert.equal(JSON.parse(await readFile(path.join(directory, "attempts.json"), "utf8")).attempts.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared lock works across processes; daily limits and unsafe state fail closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-insight-cross-process-"));
  const now = 1_700_100_000_000;
  let child;
  try {
    const script = `import { load } from './tests/customer-auth-fixtures.mjs'; const core=load('packages/ai-insights/src/core.ts'); const budget=load('packages/ai-insights/src/budget.ts',{'./core':core}); await budget.withLocalBudget(process.argv[1],async()=>{console.log('locked'); await new Promise(r=>process.stdin.once('data',r));},${now});`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin", HOME: "/tmp" }, stdio: ["pipe", "pipe", "pipe"] });
    const [chunk] = await once(child.stdout, "data");
    assert.match(String(chunk), /locked/);
    await assert.rejects(budget.withLocalBudget(directory, async () => null, now + 1), statusIs(429));
    child.stdin.end("release\n");
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    child = undefined;
    for (let i = 1; i < 10; i++) await budget.withLocalBudget(directory, async () => null, now + i * 60_001);
    await assert.rejects(budget.withLocalBudget(directory, async () => null, now + 10 * 60_001), statusIs(429));
    await writeFile(path.join(directory, "attempts.json"), "not-json", { mode: 0o600 });
    await assert.rejects(budget.withLocalBudget(directory, async () => null, now + 11 * 60_001), statusIs(503));
    await chmod(directory, 0o755);
    await assert.rejects(budget.withLocalBudget(directory, async () => null, now + 11 * 60_001), statusIs(503));
    await chmod(directory, 0o700);
    const link = `${directory}-link`;
    await symlink(directory, link);
    try { await assert.rejects(budget.withLocalBudget(link, async () => null, now + 11 * 60_001), statusIs(503)); }
    finally { await rm(link, { force: true }); }
    await mkdir(path.join(directory, "in-flight.lock"));
    await assert.rejects(budget.withLocalBudget(directory, async () => null, now + 11 * 60_001), statusIs(429));
  } finally { if (child) child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("market facts use actual selected candles and reject inaccurate or mismatched series", () => {
  const selection = { coinId: "bitcoin", currency: "GBP", days: 7 };
  const chart = { ...selection, source: "CoinGecko", retrievedAt: "2026-11-06T12:00:00.000Z", timestampKind: "close", candleIntervalMinutes: 240, candles: [{ timestamp: 1000, open: 10, high: 11, low: 9, close: 10 }, { timestamp: 2000, open: 10, high: 14, low: 10, close: 13 }, { timestamp: 3000, open: 13, high: 13, low: 11, close: 12 }] };
  const source = marketContext.marketInsightSource(selection, chart);
  assert.deepEqual({ first: source.firstPrice, last: source.lastPrice, low: source.low, high: source.high, change: source.changePercent, count: source.sampleCount }, { first: 10, last: 12, low: 9, high: 14, change: 20, count: 3 });
  const future = { ...chart, candles: [...chart.candles, { timestamp: Date.parse(chart.retrievedAt) + 1, open: 12, high: 99, low: 12, close: 99 }] };
  assert.equal(marketContext.marketInsightSource(selection, future).high, 14, "A candle with a future close is not used");
  const zero = { ...chart, candles: [{ timestamp: 1000, open: 0, high: 0, low: 0, close: 0 }, chart.candles[1]] };
  assert.equal(marketContext.marketInsightSource(selection, zero).changePercent, null);
  for (const bad of [{ ...chart, timestampKind: "open" }, { ...chart, candleIntervalMinutes: 30 }, { ...chart, coinId: "ethereum" }, { ...chart, candles: [...chart.candles].reverse() }, { ...chart, candles: [{ timestamp: 1000, open: 1, high: 2, low: 0, close: 1 }, { timestamp: 2000, open: 1, high: 2, low: 0, close: NaN }] }, { ...chart, candles: [{ timestamp: 1000, open: 1, high: 2, low: 0, close: 1 }, { timestamp: 2000, open: 3, high: 2, low: 0, close: 1 }] }]) {
    assert.throws(() => marketContext.marketInsightSource(selection, bad), statusIs(503));
  }
});

test("fictional report derives only the selected fixed fixture and exact aggregates", () => {
  const selection = { days: 7, account: "Business", market: "UK" };
  const source = reportContext.fictionalReportSource(selection);
  const rows = managementData.filterAggregates(managementData.getFictionalPeriod(7).rows, "Business", "UK");
  const expected = managementData.summarize(rows);
  assert.equal(source.provider, "Fictional local fixture");
  assert.equal(source.cohortCount, 2);
  assert.equal(source.currentActive, expected.currentActive);
  assert.equal(source.retention, expected.retention);
  assert.equal(source.currentCompleted, expected.currentCompleted);
  assert.equal("fixtureEventCohorts" in source, false);
});

test("both routes reject private or unknown input before gathering context or generating text", async () => {
  Object.assign(process.env, fakeConfig);
  let providerCalls = 0, marketReads = 0;
  const stubCore = { ...core, generateInsight: async () => { providerCalls++; return exampleInsight; } };
  const stubBudget = { withLocalBudget: async (_dir, work) => work() };
  const marketRoute = load("src/app/api/ai/market-insight/route.ts", {
    "@/lib/market-data": { ...assets, CHART_DAYS: [1, 7, 30, 90, 365], getMarketCandles: async (coinId, days, currency) => { marketReads++; return { coinId, days, currency, source: "CoinGecko", retrievedAt: "2026-11-06T12:00:00.000Z", timestampKind: "close", candleIntervalMinutes: 240, candles: [{ timestamp: 1000, open: 10, high: 10, low: 10, close: 10 }, { timestamp: 2000, open: 10, high: 11, low: 10, close: 11 }] }; } },
    "@/lib/market-currency": currencies,
    "../../../../../packages/ai-insights/src/budget": stubBudget,
    "../../../../../packages/ai-insights/src/core": stubCore,
    "./context": marketContext,
  });
  const reportRoute = load("apps/management/src/app/api/ai/report-insight/route.ts", {
    "../../../../../../../packages/ai-insights/src/budget": stubBudget,
    "../../../../../../../packages/ai-insights/src/core": stubCore,
    "./context": reportContext,
  });
  const request = (route, value, origin = fakeConfig.AI_INSIGHTS_LOCAL_ORIGIN) => new Request(`http://localhost:3000${route}`, { method: "POST", headers: { origin, host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(value) });
  const marketInput = { coinId: "bitcoin", currency: "USD", days: 7 };
  const reportInput = { days: 7, account: "All", market: "All" };
  for (const [route, handler, input] of [["/api/ai/market-insight", marketRoute.POST, marketInput], ["/api/ai/report-insight", reportRoute.POST, reportInput]]) {
    assert.equal((await handler(request(route, { ...input, holdings: "private" }))).status, 400);
    assert.equal((await handler(request(route, { ...input, prompt: "user text" }))).status, 400);
    assert.equal((await handler(request(route, input, "https://foreign.test"))).status, 403);
  }
  for (const value of [{ ...marketInput, coinId: "unknown" }, { ...marketInput, currency: "BTC" }, { ...marketInput, days: 2 }, { ...marketInput, days: "7" }]) {
    assert.equal((await marketRoute.POST(request("/api/ai/market-insight", value))).status, 400);
  }
  for (const value of [{ ...reportInput, days: 1 }, { ...reportInput, account: "Leadership" }, { ...reportInput, market: "Earth" }]) {
    assert.equal((await reportRoute.POST(request("/api/ai/report-insight", value))).status, 400);
  }
  process.env.NODE_ENV = "production";
  assert.equal((await marketRoute.POST(request("/api/ai/market-insight", marketInput))).status, 503);
  process.env.NODE_ENV = "development";
  assert.equal(providerCalls, 0); assert.equal(marketReads, 0);
  const market = await marketRoute.POST(request("/api/ai/market-insight", marketInput));
  const marketBody = await market.json();
  assert.equal(market.status, 200); assert.equal(marketBody.source.provider, "CoinGecko");
  assert.equal(marketBody.source.lastPrice, 11); assert.equal(marketBody.kind, "market");
  assert.deepEqual(Object.keys(marketBody.source).sort(), ["provider", "coinId", "currency", "days", "retrievedAt", "sampleCount", "candleIntervalMinutes", "timestampKind", "priceBasis", "rangeBasis", "firstTimestamp", "lastTimestamp", "firstPrice", "lastPrice", "low", "high", "changePercent"].sort());
  const report = await reportRoute.POST(request("/api/ai/report-insight", reportInput));
  const reportBody = await report.json();
  assert.equal(report.status, 200); assert.equal(reportBody.source.provider, "Fictional local fixture");
  assert.equal(reportBody.kind, "fictional-report"); assert.match(reportBody.disclaimer, /invented/);
  assert.deepEqual(Object.keys(reportBody.source).sort(), ["provider", "days", "account", "market", "fixtureTimestamp", "currentStart", "currentEnd", "priorStart", "priorEnd", "cohortCount", "priorActive", "currentActive", "retained", "currentAttempted", "currentCompleted", "priorCompleted", "retention", "completion"].sort());
  assert.equal(providerCalls, 2); assert.equal(marketReads, 1);
});
