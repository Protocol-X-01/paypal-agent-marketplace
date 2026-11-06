// Invoked only by the isolated Postman simulation runner.
/* eslint-disable @typescript-eslint/no-require-imports -- This standalone fixture runs directly as CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ts = require('typescript');
const { BasicTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { context, trace, createTraceState, TraceFlags, SpanStatusCode, diag } = require('@opentelemetry/api');

function loopbackEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/elastic' || endpoint.search || endpoint.hash || !endpoint.port) {
    throw new Error('The simulation requires a loopback endpoint.');
  }
  return endpoint;
}
const endpoint = loopbackEndpoint(process.argv[2]);
const closedEndpoint = loopbackEndpoint(process.argv[3]);
if (endpoint.port === closedEndpoint.port) throw new Error('The network-failure port must differ from the mock port.');
function loadLocalTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const isolatedModule = { exports: {} };
  new Function('exports', 'require', 'module', compiled)(isolatedModule.exports, require, isolatedModule);
  return isolatedModule.exports;
}
const { PrivacyFilterSpanProcessor } = loadLocalTypeScript('../src/lib/telemetry-privacy.ts');
const { PrivacySafeSpanExporter, configureTelemetryDiagnostics, withoutOtlpEnvironmentHeaders } = loadLocalTypeScript('../src/lib/telemetry-exporter.ts');
const PRIVATE_MARKER = 'synthetic_private_marker_9f12';
function containsMarker(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return value.includes(PRIVATE_MARKER);
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).includes(PRIVATE_MARKER);
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) =>
    Object.prototype.hasOwnProperty.call(descriptor, 'value') && containsMarker(descriptor.value, seen, depth + 1));
}
const realFetch = globalThis.fetch;
const realHttpRequest = http.request;
const originalConsole = { error: console.error, warn: console.warn };
const diagnosticOutput = [];
console.error = (...args) => diagnosticOutput.push({ level: 'error', args });
console.warn = (...args) => diagnosticOutput.push({ level: 'warn', args });
process.env.OTEL_LOG_LEVEL = 'debug';
assert.equal(configureTelemetryDiagnostics(), true, 'safe diagnostic logger was not installed');
assert.equal(process.env.OTEL_LOG_LEVEL, '', 'the unsafe diagnostic override was not cleared');
const diagnosticStart = diagnosticOutput.length;
diag.error('synthetic diagnostic', { detail: PRIVATE_MARKER });
diag.warn('synthetic warning', PRIVATE_MARKER);
diag.warn('Received Partial Success response:', { message: PRIVATE_MARKER });
diag.info(PRIVATE_MARKER);
diag.debug(PRIVATE_MARKER);
assert.equal(diagnosticOutput.length - diagnosticStart, 3, 'expected redacted warning and error diagnostics were not emitted');
assert.equal(containsMarker(diagnosticOutput), false, 'diagnostic logger exposed the private marker');
const { OTLPHttpProtoTraceExporter } = require('@vercel/otel');
const responseStatuses = [];
// Pass through to the real network and record only HTTP status codes. Vercel
// uses fetch; the official Node exporter uses node:http.
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  responseStatuses.push(response.status);
  return response;
};
http.request = function (...args) {
  const request = realHttpRequest.apply(this, args);
  request.on('response', (response) => responseStatuses.push(response.statusCode));
  return request;
};
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

async function exportTrace(kind, base, pathname, expectSuccess) {
  const statusStart = responseStatuses.length;
  const Exporter = kind === 'vercel' ? OTLPHttpProtoTraceExporter : OTLPTraceExporter;
  const config = {
    url: `${base.origin}/elastic${pathname}`,
    headers: { authorization: 'ApiKey simulation-only', 'x-simulation-exporter': kind },
    timeoutMillis: 2500,
  };
  const ambientNames = ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'];
  const savedHeaders = ambientNames.map((name) => process.env[name]);
  const ambientValues = [`x-simulation-ambient-general=${PRIVATE_MARKER}`, `x-simulation-ambient-traces=${PRIVATE_MARKER}`];
  let delegate;
  try {
    ambientNames.forEach((name, index) => { process.env[name] = ambientValues[index]; });
    delegate = kind === 'wrapped'
      ? withoutOtlpEnvironmentHeaders(() => new Exporter(config))
      : new Exporter(config);
    if (kind === 'wrapped') {
      assert.deepEqual(ambientNames.map((name) => process.env[name]), ambientValues, 'the helper did not restore the inherited environment');
    }
  } finally {
    ambientNames.forEach((name, index) => {
      if (savedHeaders[index] === undefined) delete process.env[name];
      else process.env[name] = savedHeaders[index];
    });
  }
  const rawResults = [];
  if (kind === 'wrapped') {
    // Observe, without changing, the official delegate's callback so the test
    // can prove the wrapper removed the receiver's marker from the same error.
    const rawExport = delegate.export.bind(delegate);
    delegate.export = (spans, callback) => rawExport(spans, (result) => {
      rawResults.push({ code: result.code, errorContainsMarker: containsMarker(result.error) });
      callback(result);
    });
  }
  const exporter = kind === 'wrapped' ? new PrivacySafeSpanExporter(delegate) : delegate;
  const results = [];
  let flushErrorContainsMarker = false;
  // Observe the real exporter's completion without replacing its transport.
  const observedExporter = {
    export(spans, callback) {
      return exporter.export(spans, (result) => {
        results.push({ code: result.code, hasError: Boolean(result.error), errorContainsMarker: containsMarker(result.error) });
        callback(result);
      });
    },
    shutdown() { return exporter.shutdown(); },
  };
  const processor = new PrivacyFilterSpanProcessor(new BatchSpanProcessor(observedExporter, {
    scheduledDelayMillis: 30000,
    exportTimeoutMillis: 5000,
  }));
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': PRIVATE_MARKER, 'host.name': PRIVATE_MARKER }),
    spanProcessors: [processor],
  });
  const parent = trace.setSpanContext(context.active(), {
    traceId: '1234567890abcdef1234567890abcdef',
    spanId: '1234567890abcdef',
    traceFlags: TraceFlags.SAMPLED,
    traceState: createTraceState(`private=${PRIVATE_MARKER}`),
    isRemote: true,
  });
  const span = provider.getTracer(PRIVATE_MARKER, PRIVATE_MARKER, { schemaUrl: PRIVATE_MARKER }).startSpan(PRIVATE_MARKER, {
    attributes: {
      'http.request.method': 'GET',
      'http.route': '/api/marketplace/catalog',
      'next.route': `/api/${PRIVATE_MARKER}`,
      'next.span_type': 'BaseServer.handleRequest',
      'http.response.status_code': 200,
      'url.full': `https://example.invalid/?q=${PRIVATE_MARKER}`,
      'customer.id': PRIVATE_MARKER,
    },
    links: [{ context: trace.getSpanContext(parent), attributes: { 'private.value': PRIVATE_MARKER } }],
  }, parent);
  span.addEvent(PRIVATE_MARKER, { 'private.value': PRIVATE_MARKER });
  span.setStatus({ code: SpanStatusCode.ERROR, message: PRIVATE_MARKER });
  span.end();

  let flushed = false;
  try {
    await provider.forceFlush();
    flushed = true;
  } catch (error) {
    // A receiver rejection is expected in the failure scenario. Do not log
    // exporter error objects, which could include request-specific details.
    flushErrorContainsMarker = containsMarker(error);
  } finally {
    await provider.shutdown().catch(() => undefined);
  }
  assert.equal(results.length, 1, 'the real exporter did not complete exactly once');
  if (expectSuccess) {
    assert.equal(flushed, true, 'valid trace was not accepted');
    assert.equal(results[0].code, 0, 'valid trace did not report success');
  }
  const statuses = responseStatuses.slice(statusStart);
  return { flushed, ...results[0], flushErrorContainsMarker, statuses, rawResults };
}

(async () => {
  for (const kind of ['vercel', 'official', 'wrapped']) {
    const success = await exportTrace(kind, endpoint, '/v1/traces', true);
    assert.deepEqual(success.statuses, [200]);
    console.log(`PASS ${kind} OTLP protobuf exporter accepted the filtered synthetic span`);
    for (const [pathname, status] of [['/bad-request/v1/traces', 400], ['/unavailable/v1/traces', 503]]) {
      const result = await exportTrace(kind, endpoint, pathname, false);
      assert.ok(result.statuses.length > 0 && result.statuses.every((value) => value === status), 'the exporter did not receive the intended HTTP status');
      const reported = result.code !== 0 && !result.flushed && result.hasError;
      if (kind !== 'vercel') {
        assert.equal(reported, true, `${kind} exporter did not report HTTP ${status} as a failure`);
        if (kind === 'wrapped') {
          assert.equal(result.rawResults.length, 1, 'official delegate did not complete exactly once');
          if (status === 400) assert.equal(result.rawResults[0].errorContainsMarker, true, 'fixture did not put the marker in the raw 400 error');
          assert.equal(result.errorContainsMarker || result.flushErrorContainsMarker, false, 'wrapper exposed the receiver marker');
        }
        console.log(`PASS ${kind} HTTP ${status}: export failed and forceFlush rejected (${result.statuses.length} response${result.statuses.length === 1 ? '' : 's'}); receiver marker in error ${result.errorContainsMarker || result.flushErrorContainsMarker ? 'present' : 'absent'}`);
      } else {
        console.log(`OBSERVED vercel HTTP ${status}: exporter code ${result.code}, error ${result.hasError ? 'present' : 'absent'}, forceFlush ${result.flushed ? 'resolved' : 'rejected'}`);
      }
    }
    const offline = await exportTrace(kind, closedEndpoint, '/v1/traces', false);
    assert.equal(offline.statuses.length, 0, 'the closed loopback port unexpectedly returned an HTTP response');
    assert.notEqual(offline.code, 0, 'the exporter did not report a network failure');
    assert.equal(offline.flushed, false, 'forceFlush did not reject the network failure');
    if (kind === 'wrapped') assert.equal(offline.errorContainsMarker || offline.flushErrorContainsMarker, false, 'network failure exposed the marker');
    console.log(`PASS ${kind} closed loopback port produced a failed export and rejected forceFlush`);
  }
  const redirect = await exportTrace('wrapped', endpoint, '/redirect/v1/traces', false);
  assert.deepEqual(redirect.statuses, [307], 'the wrapped exporter followed or failed to receive the redirect');
  assert.notEqual(redirect.code, 0, 'redirect did not produce an export failure');
  assert.equal(redirect.flushed, false, 'redirect did not reject forceFlush');
  assert.equal(redirect.rawResults[0].errorContainsMarker, true, 'fixture did not put the marker in the raw redirect error');
  assert.equal(redirect.errorContainsMarker || redirect.flushErrorContainsMarker, false, 'redirect error exposed the marker');
  console.log('PASS wrapped HTTP 307 failed without following the redirect or exposing the receiver marker');

  const sensitiveFailure = new Error(PRIVATE_MARKER);
  const throwingDelegate = new PrivacySafeSpanExporter({
    export() { throw sensitiveFailure; },
    async forceFlush() { throw sensitiveFailure; },
    async shutdown() { throw sensitiveFailure; },
  });
  const synchronousResult = await new Promise((resolve) => throwingDelegate.export([], resolve));
  assert.notEqual(synchronousResult.code, 0, 'synchronous exporter exception was not reported');
  assert.equal(containsMarker(synchronousResult), false, 'synchronous exporter exception exposed the marker');
  for (const method of ['forceFlush', 'shutdown']) {
    const error = await throwingDelegate[method]().then(() => null, (failure) => failure);
    assert.ok(error, `${method} resolved despite delegate failure`);
    assert.equal(containsMarker(error), false, `${method} exposed the marker`);
  }
  assert.equal(containsMarker(diagnosticOutput), false, 'captured OpenTelemetry diagnostics exposed the marker');
  console.log('PASS redacting diagnostics and wrapper lifecycle errors withheld the synthetic marker');
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
})().catch((error) => {
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.error(`FAIL exporter simulation: ${containsMarker(error) ? 'details withheld' : error.message}`);
  process.exitCode = 1;
});
