import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/lib/telemetry-privacy.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
new Function("exports", "require", "module", compiled)(compiledModule.exports, require, compiledModule);
const { PrivacyFilterSpanProcessor } = compiledModule.exports;
const { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { context, trace, createTraceState, TraceFlags, SpanStatusCode } = require("@opentelemetry/api");

test("real SDK spans survive batching while private telemetry is removed", async () => {
  const secret = "SYNTHETIC_PRIVATE_VALUE";
  const exporter = new InMemorySpanExporter();
  const processor = new PrivacyFilterSpanProcessor(new BatchSpanProcessor(exporter));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": secret, "customer.id": secret }),
    spanProcessors: [processor],
  });
  try {
    const parent = trace.setSpanContext(context.active(), {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: TraceFlags.SAMPLED,
      traceState: createTraceState("private=synthetic"),
      isRemote: true,
    });
    const span = provider.getTracer(secret).startSpan(secret, {
      attributes: {
        "http.request.method": "GET",
        "http.route": "/api/marketplace/catalog",
        "next.route": `/api/${secret}`,
        "next.span_type": "BaseServer.handleRequest",
        "http.response.status_code": 200,
        "url.full": `https://example.invalid/?q=${secret}`,
        "customer.id": secret,
      },
      links: [{ context: trace.getSpanContext(parent), attributes: { "private.value": secret } }],
    }, parent);
    span.addEvent(secret, { "private.value": secret });
    span.setStatus({ code: SpanStatusCode.ERROR, message: secret });
    span.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const saved = spans[0];
    assert.equal(saved.name, "GET /api/marketplace/catalog");
    assert.deepEqual(saved.attributes, {
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/api/marketplace/catalog",
      "next.span_type": "BaseServer.handleRequest",
    });
    assert.equal(typeof saved.spanContext, "function");
    assert.equal(saved.spanContext().traceState, undefined);
    assert.equal(saved.parentSpanContext?.traceState, undefined);
    assert.equal(saved.ended, true);
    assert.equal(saved.duration.length, 2);
    assert.deepEqual(saved.events, []);
    assert.deepEqual(saved.links, []);
    assert.deepEqual(saved.status, { code: SpanStatusCode.ERROR });
    assert.deepEqual(saved.resource.attributes, {
      "service.name": "paypal-markets-companion",
      "deployment.environment.name": "production",
    });
    assert.deepEqual(saved.instrumentationScope, { name: "paypal-markets.filtered" });
    assert.doesNotMatch(JSON.stringify({ ...saved, resource: saved.resource.attributes }), new RegExp(secret));
  } finally {
    await provider.shutdown();
  }
});

test("unknown span types and invalid status values cannot become labels", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new PrivacyFilterSpanProcessor(new BatchSpanProcessor(exporter))],
  });
  try {
    const span = provider.getTracer("test").startSpan("private-operation", {
      attributes: {
        "next.span_type": "SyntheticPrivateToken123",
        "next.route": "/users/private-id",
        "http.status_code": 200.5,
        "http.method": "GET",
      },
    });
    span.end();
    await provider.forceFlush();
    const [saved] = exporter.getFinishedSpans();
    assert.equal(saved.name, "app.operation");
    assert.deepEqual(saved.attributes, { "http.method": "GET" });
  } finally {
    await provider.shutdown();
  }
});

test("never forwards an unfiltered start or a malformed trace context", () => {
  let starts = 0;
  let ends = 0;
  const delegate = {
    onStart() { starts += 1; },
    onEnd() { ends += 1; },
    async forceFlush() {},
    async shutdown() {},
  };
  const processor = new PrivacyFilterSpanProcessor(delegate);
  processor.onStart({ attributes: { "customer.id": "SYNTHETIC_PRIVATE_VALUE" } }, context.active());
  processor.onEnd({ spanContext: () => ({ traceId: "SYNTHETIC_PRIVATE_VALUE", spanId: "1234567890abcdef", traceFlags: 1 }) });
  assert.equal(starts, 0);
  assert.equal(ends, 0);
});
