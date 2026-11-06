import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/lib/telemetry-exporter.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
new Function("exports", "require", "module", compiled)(compiledModule.exports, require, compiledModule);
const { PrivacySafeSpanExporter, configureTelemetryDiagnostics, withoutOtlpEnvironmentHeaders } = compiledModule.exports;
const { diag } = require("@opentelemetry/api");

test("export failures, thrown errors and shutdown errors do not expose collector bodies", async () => {
  const secret = "SYNTHETIC_COLLECTOR_BODY";
  const exporter = new PrivacySafeSpanExporter({
    export(_spans, callback) { callback({ code: 1, error: new Error(secret) }); },
    async forceFlush() { throw new Error(secret); },
    async shutdown() { throw new Error(secret); },
  });
  const result = await new Promise((resolve) => exporter.export([], resolve));
  assert.equal(result.code, 1);
  assert.equal(result.error.message, "Trace export failed.");
  await assert.rejects(exporter.forceFlush(), { message: "Trace export failed." });
  await assert.rejects(exporter.shutdown(), { message: "Trace exporter shutdown failed." });

  const throwingExporter = new PrivacySafeSpanExporter({
    export() { throw new Error(secret); },
    async shutdown() {},
  });
  const thrownResult = await new Promise((resolve) => throwingExporter.export([], resolve));
  assert.equal(thrownResult.code, 1);
  assert.doesNotMatch(String(thrownResult.error), new RegExp(secret));
});

test("success remains success and a misbehaving delegate cannot complete twice", async () => {
  const exporter = new PrivacySafeSpanExporter({
    export(_spans, callback) { callback({ code: 0 }); callback({ code: 1 }); },
    async shutdown() {},
  });
  const results = [];
  exporter.export([], (result) => results.push(result));
  assert.deepEqual(results, [{ code: 0 }]);
  await exporter.forceFlush();
  await exporter.shutdown();
});

test("inherited OTLP headers are hidden during construction and restored even on failure", () => {
  const names = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"];
  const original = names.map((name) => process.env[name]);
  try {
    process.env[names[0]] = "x-private=SYNTHETIC_PRIVATE_HEADER";
    process.env[names[1]] = "x-another=SYNTHETIC_PRIVATE_HEADER";
    assert.throws(() => withoutOtlpEnvironmentHeaders(() => {
      for (const name of names) assert.equal(process.env[name], undefined);
      throw new Error("synthetic construction failure");
    }), /synthetic construction failure/);
    for (const name of names) assert.match(process.env[name], /SYNTHETIC_PRIVATE_HEADER/);
  } finally {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
});

test("diagnostics retain generic warnings without logging private details", () => {
  const previousLevel = process.env.OTEL_LOG_LEVEL;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    process.env.OTEL_LOG_LEVEL = "DEBUG";
    assert.equal(configureTelemetryDiagnostics(), true);
    diag.warn("Received Partial Success response:", { message: "SYNTHETIC_PRIVATE_RESPONSE" });
    diag.error("SYNTHETIC_PRIVATE_ERROR");
    diag.debug("SYNTHETIC_PRIVATE_SPAN");
    assert.equal(process.env.OTEL_LOG_LEVEL, "");
    assert.match(logs[0], /partial trace acceptance/);
    assert.match(logs[1], /details withheld/);
    assert.doesNotMatch(logs.join(" "), /SYNTHETIC_PRIVATE/);
  } finally {
    diag.disable();
    console.warn = originalWarn;
    console.error = originalError;
    if (previousLevel === undefined) delete process.env.OTEL_LOG_LEVEL;
    else process.env.OTEL_LOG_LEVEL = previousLevel;
  }
});
