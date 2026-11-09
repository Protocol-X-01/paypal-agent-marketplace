import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../instrumentation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the actual Next registration function with an isolated environment and
// inert collaborators. No SDK exporter is constructed and no network is used.
function registration(environment, { diagnosticsReady = true } = {}) {
  const calls = { loads: [], diagnostics: 0, headerGuards: 0, configs: [], registrations: [], logs: [] };
  const fakeProcess = { env: { ...environment } };
  class FakeCollector {
    constructor(config) { calls.configs.push(config); }
  }
  class SafeExporter {
    constructor(delegate) { this.delegate = delegate; }
  }
  class BatchProcessor {
    constructor(exporter) { this.exporter = exporter; }
  }
  class FilterProcessor {
    constructor(delegate) { this.delegate = delegate; }
  }
  const modules = {
    "@/lib/telemetry-privacy": { PrivacyFilterSpanProcessor: FilterProcessor },
    "@/lib/telemetry-exporter": {
      configureTelemetryDiagnostics() { calls.diagnostics += 1; return diagnosticsReady; },
      PrivacySafeSpanExporter: SafeExporter,
      withoutOtlpEnvironmentHeaders(factory) { calls.headerGuards += 1; return factory(); },
    },
    "@opentelemetry/exporter-trace-otlp-proto": { OTLPTraceExporter: FakeCollector },
    "@opentelemetry/sdk-trace-base": { BatchSpanProcessor: BatchProcessor },
    "@vercel/otel": { registerOTel(options) { calls.registrations.push(options); } },
  };
  const require = (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    calls.loads.push(name);
    return modules[name];
  };
  const fakeConsole = {
    info: (...args) => calls.logs.push(args.join(" ")),
    warn: (...args) => calls.logs.push(args.join(" ")),
  };
  const isolatedModule = { exports: {} };
  new Function("exports", "require", "module", "process", "console", compiled)(
    isolatedModule.exports, require, isolatedModule, fakeProcess, fakeConsole,
  );
  return { register: isolatedModule.exports.register, calls, env: fakeProcess.env, FilterProcessor, BatchProcessor, SafeExporter };
}

const eligible = {
  NEXT_RUNTIME: "nodejs",
  NODE_ENV: "production",
  RENDER: "true",
  IS_PULL_REQUEST: "false",
  ELASTIC_OTLP_ENDPOINT: "https://collector.example.invalid/otlp",
  PAYPAL_ELASTIC_OTLP_API_KEY: "synthetic-dedicated-key",
};

function assertNoExport(result) {
  assert.equal(result.calls.diagnostics, 0);
  assert.equal(result.calls.headerGuards, 0);
  assert.deepEqual(result.calls.configs, []);
  assert.deepEqual(result.calls.registrations, []);
  assert.equal(result.calls.loads.includes("@opentelemetry/exporter-trace-otlp-proto"), false);
}

test("export stays off unless its flag is exactly true", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
    const result = registration({ ...eligible, PAYPAL_ELASTIC_EXPORT_ENABLED: value });
    await result.register();
    assertNoExport(result);
    assert.equal(result.env.NEXT_OTEL_FETCH_DISABLED, "1");
    assert.deepEqual(result.calls.logs, []);
  }
});

test("export requires the dedicated key and never falls back to a generic key", async () => {
  for (const value of [undefined, "", "   "]) {
    const result = registration({
      ...eligible,
      PAYPAL_ELASTIC_EXPORT_ENABLED: "true",
      PAYPAL_ELASTIC_OTLP_API_KEY: value,
      ELASTIC_API_KEY: "synthetic-unrelated-key",
    });
    await result.register();
    assertNoExport(result);
    assert.match(result.calls.logs.join(" "), /PAYPAL_ELASTIC_OTLP_API_KEY/);
    assert.doesNotMatch(result.calls.logs.join(" "), /synthetic-unrelated-key/);
  }
});

test("explicitly enabled production Render registers only the dedicated key with privacy wrappers", async () => {
  for (const generic of [undefined, "synthetic-unrelated-key"]) {
    const result = registration({ ...eligible, PAYPAL_ELASTIC_EXPORT_ENABLED: "true", ELASTIC_API_KEY: generic });
    await result.register();
    assert.equal(result.calls.diagnostics, 1);
    assert.equal(result.calls.headerGuards, 1);
    assert.equal(result.calls.configs.length, 1);
    assert.deepEqual(result.calls.configs[0], {
      url: "https://collector.example.invalid/otlp/v1/traces",
      headers: { Authorization: "ApiKey synthetic-dedicated-key" },
      timeoutMillis: 10_000,
    });
    assert.equal(result.calls.registrations.length, 1);
    const options = result.calls.registrations[0];
    assert.equal(options.serviceName, "paypal-markets-companion");
    assert.equal(options.autoDetectResources, false);
    assert.deepEqual(options.instrumentations, []);
    assert.deepEqual(options.propagators, ["none"]);
    assert.ok(options.spanProcessors[0] instanceof result.FilterProcessor);
    assert.ok(options.spanProcessors[0].delegate instanceof result.BatchProcessor);
    assert.ok(options.spanProcessors[0].delegate.exporter instanceof result.SafeExporter);
    assert.equal(result.env.NEXT_OTEL_FETCH_DISABLED, "1");
    assert.equal(result.env.OTEL_SERVICE_NAME, "paypal-markets-companion");
    assert.deepEqual(result.calls.logs, []);
  }
});

test("non-Node, non-production, non-Render, and pull-request environments never export", async () => {
  for (const change of [
    { NEXT_RUNTIME: "edge" },
    { NEXT_RUNTIME: undefined },
    { NODE_ENV: "development" },
    { NODE_ENV: "test" },
    { RENDER: undefined },
    { RENDER: "false" },
    { IS_PULL_REQUEST: "true" },
  ]) {
    const result = registration({ ...eligible, PAYPAL_ELASTIC_EXPORT_ENABLED: "true", ...change });
    await result.register();
    assertNoExport(result);
    assert.equal(result.env.NEXT_OTEL_FETCH_DISABLED, change.NEXT_RUNTIME === "edge" || Object.hasOwn(change, "NEXT_RUNTIME") ? undefined : "1");
  }
});

test("missing or invalid configuration and unsafe diagnostics prevent registration", async () => {
  for (const change of [
    { ELASTIC_OTLP_ENDPOINT: undefined },
    { ELASTIC_OTLP_ENDPOINT: "http://collector.example.invalid" },
    { ELASTIC_OTLP_ENDPOINT: "https://localhost/" },
    { ELASTIC_OTLP_ENDPOINT: "https://collector.example.invalid/?token=synthetic" },
    { ELASTIC_OTLP_ENDPOINT: "https://user:pass@collector.example.invalid/" },
    { PAYPAL_ELASTIC_OTLP_API_KEY: "synthetic,bad-key" },
    { PAYPAL_ELASTIC_OTLP_API_KEY: "synthetic\nbad-key" },
  ]) {
    const result = registration({ ...eligible, PAYPAL_ELASTIC_EXPORT_ENABLED: "true", ...change });
    await result.register();
    assertNoExport(result);
    assert.doesNotMatch(result.calls.logs.join(" "), /synthetic|user:pass/);
  }
  const result = registration({ ...eligible, PAYPAL_ELASTIC_EXPORT_ENABLED: "true" }, { diagnosticsReady: false });
  await result.register();
  assert.equal(result.calls.diagnostics, 1);
  assert.equal(result.calls.headerGuards, 0);
  assert.deepEqual(result.calls.configs, []);
  assert.deepEqual(result.calls.registrations, []);
});
